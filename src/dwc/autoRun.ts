/**
 * Auto-run on upload (D5): watches DWC's own `fileUploaded` event and, when enabled, picks a
 * matching recipe (via `model/recipeMatch.ts`) and applies it automatically.
 *
 * Installed once from `index.ts`, not from a mounted component — a listener installed by a
 * component stops working the moment its page unmounts, which is exactly when auto-run is supposed
 * to be doing its job. Torn down in `onPluginUnloaded` using the SAME handler reference `Events.on`
 * was given, since `Events.off` needs that exact reference to remove it — otherwise a plugin restart
 * stacks a second listener and every uploaded file is processed twice.
 *
 * Verified against DuetWebControl's own source (cited in full in
 * docs/tasks/16-automation-and-reporting.md §D):
 * - `fileUploaded` (`@/utils/events.ts`) fires once per uploaded file, AFTER the bytes are already on
 *   the card, for every upload made through this DWC session — including this plugin's own writes.
 *   It does NOT fire for an upload made outside this browser tab (a slicer uploading straight to the
 *   Duet never passes through `machineStore.upload`), which is why this only ever works "while a DWC
 *   tab is open" — deliberately narrower than it might sound.
 * - `showConfirmDialog` (`@/composables/useConfirmDialog`) queues into an app-global dialog rendered
 *   by DWC's own `<ConfirmDialogQueue/>` (`App.vue`), so it works with no page of this plugin mounted.
 *
 * The plugin's own uploads are excluded by path, not by some "is this us" flag, because it is
 * provably sufficient: `processFile` only ever uploads to `plan.tempPath` (`${target}.pp.tmp`), a
 * backup under `BACKUP_DIR`, or `BACKUP_INDEX`/`HISTORY_INDEX` (both under `WORK_DIR`) — its final
 * target arrives by `move`, which fires `fileOrDirectoryMoved`, NOT `fileUploaded`.
 *
 * Runs are serialised through one promise chain: a multi-file upload emits `fileUploaded` once per
 * file, and several full pipelines running concurrently on the main thread would make the tab
 * unusable. Queued work past `AUTORUN_QUEUE_LIMIT` is dropped with a notification rather than
 * growing without bound.
 */

import { showConfirmDialog } from "@/composables/useConfirmDialog";
import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";
import Events from "@/utils/events";
import { recordError } from "dwc-plugin-runtime/diagnostics";

import { createGateway } from "./gateway";
import {
	installedPluginVersion, jobFileName, machineLimits, machineStatus, toolHeaterConfigs,
} from "./machineSnapshot";
import { useRecipes } from "./recipeStore";
import {
	AUTORUN_QUEUE_LIMIT, LS_AUTORUN_ENABLED, LS_AUTORUN_SILENT, PLUGIN_MANIFEST_ID, WORK_DIR,
} from "../model/constants";
import { recordRun, toFailedHistoryEntry, toHistoryEntry } from "../model/io/history";
import { blocking, checkSafety, isGcodePath, planOutput } from "../model/io/plan";
import { CancelledError, prescan, processFile } from "../model/io/transfer";
import { usesScripts, type Recipe } from "../model/recipe";
import { needsMetadata, pickRecipe } from "../model/recipeMatch";

export interface FileUploadedPayload {
	filename: string;
}

function readFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === "true";
	} catch {
		return false;
	}
}

function writeFlag(key: string, value: boolean): void {
	try {
		if (value) localStorage.setItem(key, "true");
		else localStorage.removeItem(key);
	} catch {
		// Storage disabled: the setting reverts to its default (off) next load, which is the safe
		// direction to fail in
	}
}

export function isAutoRunEnabled(): boolean {
	return readFlag(LS_AUTORUN_ENABLED);
}

export function setAutoRunEnabled(value: boolean): void {
	writeFlag(LS_AUTORUN_ENABLED, value);
	// Enabling auto-run must never silently enable silent mode — that is a second, deliberate opt-in
	if (!value) writeFlag(LS_AUTORUN_SILENT, false);
}

export function isAutoRunSilent(): boolean {
	return readFlag(LS_AUTORUN_SILENT);
}

export function setAutoRunSilent(value: boolean): void {
	writeFlag(LS_AUTORUN_SILENT, value);
}

/** True for anything this plugin itself writes — see the module comment for the proof this is
 *  sufficient to prevent auto-run triggering itself. */
function isPluginOwnUpload(path: string): boolean {
	return path.startsWith(`${WORK_DIR}/`) || path.endsWith(".pp.tmp");
}

function notify(uiStore: ReturnType<typeof useUiStore>, level: LogLevel, message: string): void {
	uiStore.makeNotification(level, "G-code Post-Processor (auto-run)", message);
}

/**
 * The decision logic and the run itself, for one uploaded file. Exported directly (rather than only
 * reachable through the real `Events` emitter) so tests can drive it with a hand-built payload and
 * `await` its result — the real emitter calls handlers synchronously and does not await what they
 * return.
 */
export async function handleFileUploaded(payload: FileUploadedPayload): Promise<void> {
	if (!isAutoRunEnabled()) return;
	const path = payload.filename;
	if (isPluginOwnUpload(path)) return;
	if (!isGcodePath(path)) return;

	const machineStore = useMachineStore();
	const uiStore = useUiStore();
	const { recipes } = useRecipes();

	// Tier 1: everything answerable without downloading the file
	const tier1 = pickRecipe(recipes.value, path);
	if (tier1.matches.length === 0) return; // no candidate at all — nothing to do, silently
	if (tier1.ambiguous) {
		notify(uiStore, LogLevel.warning, `${tier1.matches.length} recipes match ${path}; skipped because auto-run must not guess between them.`);
		return;
	}

	const gateway = createGateway();

	// Tier 2 only exists to apply a `matchSlicer` rule, and the only way to read the slicer is to
	// fetch the file. For a recipe matching on name or folder alone — the common case — tier 1 is
	// already the final answer, and downloading here would transfer the whole file a second time
	// (`processFile` fetches its own copy) purely to learn something we would not act on.
	let recipe: Recipe;
	if (tier1.matches.some(needsMetadata)) {
		let blob: Blob;
		try {
			blob = await gateway.download(path);
		} catch {
			return; // gone by the time we looked — nothing to report
		}
		const { meta } = await prescan(blob);
		const tier2 = pickRecipe(recipes.value, path, meta);
		if (tier2.chosen === null) return;
		if (tier2.ambiguous) {
			notify(uiStore, LogLevel.warning, `${tier2.matches.length} recipes match ${path}; skipped because auto-run must not guess between them.`);
			return;
		}
		recipe = tier2.chosen;
	} else {
		if (tier1.chosen === null) return;
		recipe = tier1.chosen;
	}

	// Trust is per-session and deliberately never persisted (dwc/recipeStore.ts's `sanitise`) —
	// there is nobody present here to grant it, so a scripted recipe is always refused
	if (usesScripts(recipe)) {
		notify(uiStore, LogLevel.warning, `"${recipe.name}" contains a script and cannot run unattended — open it and run it manually instead.`);
		return;
	}

	const plan = planOutput({ sourcePath: path, mode: "alongside" });
	const targetSize = await gateway.sizeOf(plan.targetPath).catch(() => null);
	const sourceSize = await gateway.sizeOf(path).catch(() => null);
	const issues = checkSafety({
		sourcePath: path,
		plan,
		jobFileName: jobFileName(machineStore.model),
		status: machineStatus(machineStore.model),
		sizeBytes: sourceSize,
		// The "already processed" notice is warn-level and this path acts on `blocking()` alone, so
		// reading the file's head to compute it would cost a whole extra transfer for nothing
		existingStamp: null,
		targetExists: targetSize !== null,
		recipe,
	});
	const blockers = blocking(issues);
	if (blockers.length > 0) {
		notify(uiStore, LogLevel.warning, `Auto-run refused for ${path}: ${blockers[0].message}`);
		return;
	}

	if (!isAutoRunSilent()) {
		const confirmed = await showConfirmDialog(
			"Post-process this file automatically?",
			`Apply recipe "${recipe.name}" to ${path}, writing ${plan.targetPath}.`,
		);
		if (!confirmed) return;
	}

	try {
		const result = await processFile({
			gateway,
			sourcePath: path,
			recipe,
			plan,
			pluginVersion: installedPluginVersion(machineStore.model, PLUGIN_MANIFEST_ID),
			scriptsTrusted: false,
			dryRun: false,
			limits: machineLimits(machineStore.model),
			toolHeaters: toolHeaterConfigs(machineStore.model),
		});
		await recordRun(gateway, toHistoryEntry(result, recipe, path, "auto"));
		notify(uiStore, LogLevel.success, `Wrote ${result.targetPath}`);
	} catch (e) {
		if (!(e instanceof CancelledError)) {
			await recordRun(gateway, toFailedHistoryEntry(path, recipe, "auto", e as Error));
			notify(uiStore, LogLevel.error, `Auto-run failed for ${path}: ${(e as Error).message}`);
		}
	}
}

// One promise chain serialises every queued upload; `queued` is only ever used to cap it
let queue: Promise<void> = Promise.resolve();
let queued = 0;

/**
 * Run one upload's handler so that it can never reject.
 *
 * This is what keeps the chain below alive. `handleFileUploaded` handles the failures it expects,
 * but an unexpected throw anywhere in it (a store getter, `prescan` on a truncated body, the
 * confirmation dialog) would otherwise leave `queue` holding a rejected promise — and since every
 * later upload chains off it with `.then`, auto-run would go silently and permanently dead for the
 * rest of the session, with nothing in the UI to say so. Swallowing here is deliberate: one bad file
 * must not take the feature down with it.
 */
async function runGuarded(payload: FileUploadedPayload): Promise<void> {
	try {
		await handleFileUploaded(payload);
	} catch (e) {
		recordError("autoRun", e);
		try {
			useUiStore().makeNotification(
				LogLevel.error, "G-code Post-Processor (auto-run)",
				`Auto-run failed unexpectedly for ${payload.filename}: ${(e as Error).message}`,
			);
		} catch {
			// The notification is best-effort; not rethrowing is the important part
		}
	}
}

/** Queue one upload for processing, serially after anything already queued. */
export function queueFileUploaded(payload: FileUploadedPayload): Promise<void> {
	if (queued >= AUTORUN_QUEUE_LIMIT) {
		try {
			useUiStore().makeNotification(
				LogLevel.warning, "G-code Post-Processor (auto-run)",
				`Too many files queued for auto-run — ${payload.filename} was skipped.`,
			);
		} catch {
			// Best-effort notification; dropping the file is the important part
		}
		return Promise.resolve();
	}
	queued++;
	const task = queue.then(() => runGuarded(payload)).finally(() => { queued--; });
	queue = task;
	return task;
}

/** Install the listener. Returns an uninstall function — call it from `onPluginUnloaded`. */
export function installAutoRun(): () => void {
	const handler = (payload: unknown): void => {
		void queueFileUploaded(payload as FileUploadedPayload);
	};
	Events.on("fileUploaded", handler);
	return () => Events.off("fileUploaded", handler);
}
