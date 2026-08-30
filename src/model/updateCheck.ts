/**
 * Self-update, working with the shared cross-plugin update hub in `dwc-plugin-runtime` — the same
 * one Flexible Layouts and the other plugins in this family use.
 *
 * On load it checks GitHub Releases and, when there is something newer, *announces* it into the hub
 * rather than raising its own notification. If a host is present (FL's shell claims it) the user
 * gets one aggregated popup listing every plugin with an update, instead of each plugin nagging
 * separately. With no host, this falls back to a single notification of its own.
 *
 * Lives in `model/` only because the rest of the plugin's non-UI code does; it is the one module
 * here that talks to DWC directly, which is why it does not follow the "no DWC imports" rule the
 * rest of `model/` keeps to.
 */

import { computed, ref } from "vue";
import {
	announceUpdate, applyUpdate, checkForUpdate, clearAnnouncedUpdate, isUpdateHostActive,
	registerUpdateChecker, type UpdateResult,
} from "dwc-plugin-runtime";
import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";

import {
	LS_UPDATE_DISMISSED, LS_UPDATE_ENABLED, LS_UPDATE_LAST, PLUGIN_MANIFEST_ID, REPO_NAME, REPO_OWNER,
} from "./constants";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TITLE = "G-code Post-Processor";

export const updateState = ref<UpdateResult | null>(null);
export const checking = ref(false);
export const applying = ref(false);
/** True after a one-click update: the running bundle is stale until the page reloads. */
export const pendingReload = ref(false);
export const dismissedVersion = ref<string | null>(safeGet(LS_UPDATE_DISMISSED));
export const autoCheck = computed(() => updateChecksEnabled());

function safeGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage disabled — the check simply runs again next load
	}
}

/** Installed version, from the object model's plugins map (authoritative). */
function currentVersion(): string {
	const plugins = (useMachineStore().model as { plugins?: Map<string, { version?: string }> }).plugins;
	return plugins?.get(PLUGIN_MANIFEST_ID)?.version ?? "0.0.0";
}

export function updateChecksEnabled(): boolean {
	return safeGet(LS_UPDATE_ENABLED) !== "false";
}

export function toggleAutoCheck(on: boolean): void {
	safeSet(LS_UPDATE_ENABLED, on ? "true" : "false");
	if (!on) clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
}

/** Mirror the current result into the shared hub so a host's aggregated popup can include us. */
function syncHub(): void {
	const state = updateState.value;
	if (state?.updateAvailable === true && dismissedVersion.value !== state.latestVersion) {
		announceUpdate(PLUGIN_MANIFEST_ID, TITLE, state);
	} else {
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
	}
}

/**
 * Run a check. Throttled to once a day unless forced, skipped when disabled, and never throws —
 * being offline or rate-limited is not an error worth showing anyone.
 */
export async function runUpdateCheck(opts: { force?: boolean; notify?: boolean } = {}): Promise<UpdateResult | null> {
	if (opts.force !== true) {
		if (!updateChecksEnabled()) return null;
		const last = Number(safeGet(LS_UPDATE_LAST) ?? 0);
		if (Date.now() - last < CHECK_INTERVAL_MS) {
			syncHub();
			return updateState.value;
		}
	}

	checking.value = true;
	try {
		const result = await checkForUpdate({
			owner: REPO_OWNER,
			repo: REPO_NAME,
			currentVersion: currentVersion(),
		});
		updateState.value = result;
		safeSet(LS_UPDATE_LAST, String(Date.now()));
		if (opts.notify === true && result.updateAvailable
			&& dismissedVersion.value !== result.latestVersion && !isUpdateHostActive()) {
			useUiStore().makeNotification(
				LogLevel.info, TITLE,
				`Version ${result.latestVersion} is available.`,
			);
		}
		syncHub();
		return result;
	} catch {
		return null;
	} finally {
		checking.value = false;
	}
}

/** Stop offering the current version until a newer one appears. */
export function dismissCurrentUpdate(): void {
	const version = updateState.value?.latestVersion;
	if (version === undefined || version === null) return;
	safeSet(LS_UPDATE_DISMISSED, version);
	dismissedVersion.value = version;
	clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
}

/** Download the release ZIP and install it through DWC, which hot-reloads the bundle. */
export async function applyUpdateNow(): Promise<void> {
	const result = updateState.value;
	const uiStore = useUiStore();
	const assetUrl = result?.assetUrl ?? null;
	const assetName = result?.assetName ?? null;
	if (result === null || assetUrl === null || assetName === null) {
		uiStore.makeNotification(LogLevel.warning, TITLE, "No downloadable release asset was found.");
		return;
	}

	applying.value = true;
	try {
		const machineStore = useMachineStore();
		await applyUpdate({
			assetUrl,
			assetName,
			installPlugin: (filename, blob, start) => machineStore.installPlugin(filename, blob, start),
		});
		pendingReload.value = true;
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
		uiStore.makeNotification(
			LogLevel.success, TITLE,
			`Version ${result.latestVersion} installed — reload DWC to use it.`,
		);
	} catch (e) {
		console.warn("[GCodePostProcessor] update failed:", e);
		uiStore.makeNotification(
			LogLevel.warning, TITLE,
			"The update could not be installed automatically; opening the download instead.",
		);
		window.location.href = assetUrl;
	} finally {
		applying.value = false;
	}
}

registerUpdateChecker(PLUGIN_MANIFEST_ID, async () => { await runUpdateCheck({ force: true }); });
