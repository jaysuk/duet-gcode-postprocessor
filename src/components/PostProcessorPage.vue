<style scoped>
.page {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}

.panes {
	display: flex;
	gap: 0.75rem;
	flex: 1 1 auto;
	min-height: 0;
	padding: 0.75rem;
}

.browser-pane {
	flex: 0 0 22rem;
	max-width: 22rem;
	display: flex;
	min-height: 0;
	overflow: hidden;
}

.work-pane {
	flex: 1 1 auto;
	min-width: 0;
	display: flex;
	flex-direction: column;
	min-height: 0;
}

.work-body {
	flex: 1 1 auto;
	overflow-y: auto;
	min-height: 0;
}

@media (max-width: 960px) {
	.panes {
		flex-direction: column;
	}

	.browser-pane {
		/* Stacked, the browser must not split the viewport height with the work pane — cap it and
		 * let the work pane (the recipe editor, the diff) take the rest. On an 800×480 panel an
		 * even split leaves both panes scrolling a few rows at a time. */
		flex: 0 0 auto;
		max-width: none;
		max-height: 40vh;
	}

	.work-pane {
		flex: 1 1 auto;
	}
}

@media (max-width: 600px) {
	.panes {
		padding: 0.375rem;
		gap: 0.375rem;
	}
}
</style>

<template>
	<div class="page">
		<v-toolbar density="comfortable" color="surface">
			<v-icon class="ms-4 me-2">mdi-file-replace-outline</v-icon>
			<v-toolbar-title class="text-body-large">G-code Post-Processor</v-toolbar-title>
			<v-spacer />

			<v-btn v-if="busy" variant="text" class="me-2" :icon="xs" title="Cancel" @click="cancel">
				<template v-if="xs"><v-icon>mdi-stop</v-icon></template>
				<template v-else>Cancel</template>
			</v-btn>
			<v-btn v-if="selection.length > 0" :prepend-icon="xs ? undefined : 'mdi-file-multiple-outline'" variant="tonal"
				   class="me-2" :icon="xs" :title="`Batch (${selection.length})`"
				   :disabled="recipe === null || problems.length > 0 || (usesScripts(recipe) && !trusted)"
				   @click="batchOpen = true">
				<template v-if="xs"><v-icon>mdi-file-multiple-outline</v-icon></template>
				<template v-else>Batch ({{ selection.length }})</template>
			</v-btn>
			<v-btn :prepend-icon="xs ? undefined : 'mdi-eye-outline'" variant="tonal" class="me-2" :icon="xs"
				   title="Preview" :disabled="!canRun || busy" @click="run(true)">
				<template v-if="xs"><v-icon>mdi-eye-outline</v-icon></template>
				<template v-else>Preview</template>
			</v-btn>
			<v-btn :prepend-icon="xs ? undefined : 'mdi-content-save-outline'" color="primary" class="me-2" :icon="xs"
				   title="Apply" :disabled="!canApply || busy" @click="startApply">
				<template v-if="xs"><v-icon>mdi-content-save-outline</v-icon></template>
				<template v-else>Apply</template>
			</v-btn>

			<v-divider vertical class="mx-2" />

			<v-btn variant="text" icon title="Settings" @click="settingsOpen = true">
				<v-icon :color="autoRunEnabled || preflightGate ? 'primary' : undefined">mdi-cog-outline</v-icon>
			</v-btn>
			<v-btn variant="text" icon title="About" @click="aboutOpen = true">
				<v-icon>mdi-information-outline</v-icon>
			</v-btn>
		</v-toolbar>

		<div v-if="!canRun" class="text-caption text-medium-emphasis px-4 pt-2">
			{{ blockedReason }}
		</div>

		<div class="panes">
			<v-card class="browser-pane" variant="outlined">
				<GcodeBrowser v-model="selectedPath" style="width: 100%" @update:selection="selection = $event" />
			</v-card>

			<v-card class="work-pane" variant="outlined">
				<v-tabs v-model="tab" density="compact" show-arrows>
					<v-tab value="recipe">Recipe</v-tab>
					<v-tab value="inspect">Inspect</v-tab>
					<v-tab value="preview">
						Preview
						<v-badge v-if="lastRun !== null" inline :content="lastRun.diff.length" color="primary" />
					</v-tab>
					<v-tab value="backups">Backups</v-tab>
					<v-tab value="history">History</v-tab>
					<v-tab value="compare">Compare</v-tab>
				</v-tabs>
				<v-divider />

				<div class="work-body">
					<RecipeEditor v-show="tab === 'recipe'"
								  :recipe="recipe"
								  :recipes="recipes"
								  :scripts-trusted="trusted"
								  @update:recipe="onRecipeChange"
								  @update:scripts-trusted="onTrustChange"
								  @select="select"
								  @add="add()"
								  @remove="removeActive"
								  @duplicate="duplicateActive"
								  @import="onImport" />

					<FileInspector v-if="hasOpenedInspect" v-show="tab === 'inspect'" :path="selectedPath"
								   @checked="onChecked" />

					<DiffPreview v-if="tab === 'preview'"
								 :result="lastRun"
								 :recipe="recipe"
								 :source-name="selectedPath ?? ''" />

					<BackupManager v-if="tab === 'backups'" />

					<RunHistory v-if="tab === 'history'" />

					<CompareFiles v-if="tab === 'compare'" :initial-path="selectedPath" />
				</div>
			</v-card>
		</div>

		<v-divider />

		<div class="pa-3">
			<v-alert v-if="runError !== null" type="error" variant="tonal" density="compact" class="mb-3">
				{{ runError }}
			</v-alert>

			<v-alert v-if="applied !== null" type="success" variant="tonal" density="compact" class="mb-3">
				Wrote <strong>{{ applied.targetPath }}</strong> —
				{{ applied.stats.linesChanged.toLocaleString() }} changed,
				{{ applied.stats.linesAdded.toLocaleString() }} added,
				{{ applied.stats.linesRemoved.toLocaleString() }} removed in
				{{ (applied.durationMs / 1000).toFixed(1) }} s
				<template v-if="applied.analysisMs !== null">
					({{ (applied.analysisMs / 1000).toFixed(1) }} s analysing this file first,
					{{ (applied.transformMs / 1000).toFixed(1) }} s applying the recipe)
				</template>.
				<template v-if="applied.backupPath !== null">
					The original is backed up at <code>{{ applied.backupPath }}</code>.
				</template>
				<v-btn size="small" variant="text" prepend-icon="mdi-download" class="ms-2" @click="downloadAppliedReport">
					Download the run report
				</v-btn>
			</v-alert>

			<v-progress-linear v-if="busy" :model-value="(progress?.fraction ?? 0) * 100"
							   :indeterminate="progress?.fraction === null" height="8" rounded class="mb-3" />
			<div v-if="busy" class="text-caption text-medium-emphasis mb-2">
				{{ phaseLabel }}<template v-if="progress?.detail"> — {{ progress.detail }}</template>
			</div>

			<v-alert v-for="issue in warnings" :key="issue.code" type="warning" variant="tonal"
					 density="compact" class="mb-2">
				{{ issue.message }}
			</v-alert>

			<v-alert v-if="preflightUnchecked" type="info" variant="tonal" density="compact" class="mb-2">
				The preflight gate is on but this file has not been inspected yet. Open the Inspect tab and
				run it — a clean preflight is not required to Apply until you have.
			</v-alert>
			<v-alert v-else-if="preflightBlocks" type="error" variant="tonal" density="compact" class="mb-2">
				Preflight found {{ (preflightErrors ?? []).length }}
				{{ (preflightErrors ?? []).length === 1 ? "error" : "errors" }} and the gate is on —
				see the Inspect tab for the detail. Fix them, or turn the gate off in Settings.
			</v-alert>

			<div class="d-flex align-center flex-wrap ga-2">
				<v-select v-model="outputMode" :items="outputModes" item-title="label" item-value="value"
						  :density="controlDensity" hide-details variant="outlined" label="Write the result"
						  style="max-width: 20rem" :disabled="busy" />

				<v-text-field v-if="outputMode === 'alongside'" v-model="suffix" :density="controlDensity" hide-details
							  variant="outlined" label="Suffix" style="max-width: 10rem" :disabled="busy" />

				<v-text-field v-if="outputMode === 'folder'" v-model="folder" :density="controlDensity" hide-details
							  variant="outlined" label="Destination folder" style="max-width: 20rem"
							  :disabled="busy" />
			</div>
		</div>

		<v-dialog v-model="confirmOpen" max-width="34rem">
			<v-card title="Apply this recipe?">
				<v-card-text>
					<p class="mb-3">
						<strong>{{ recipe?.name }}</strong> will be applied to
						<code>{{ selectedPath }}</code>, writing <code>{{ plannedTarget }}</code>.
					</p>

					<v-alert v-for="issue in warnings" :key="issue.code" type="warning" variant="tonal"
							 density="compact" class="mb-2">
						{{ issue.message }}
					</v-alert>

					<p v-if="lastRun === null" class="text-medium-emphasis text-body-2">
						You have not previewed this recipe against this file yet.
					</p>
					<p v-else class="text-body-2">
						The preview changed {{ lastRun.stats.linesChanged.toLocaleString() }} lines,
						added {{ lastRun.stats.linesAdded.toLocaleString() }} and removed
						{{ lastRun.stats.linesRemoved.toLocaleString() }}.
					</p>

					<v-checkbox v-model="startAfterApply" label="Start printing immediately after"
								density="compact" hide-details class="mt-2" />
					<p v-if="startAfterApply" class="text-caption text-medium-emphasis mt-1">
						Sends <code>M32</code> for the written file once it is on the SD card. Refused if the
						machine is already printing, simulating, resuming or pausing.
					</p>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Cancel" @click="confirmOpen = false" />
					<v-btn :text="startAfterApply ? 'Apply and start' : 'Apply'" color="primary"
						   @click="confirmApply" />
				</v-card-actions>
			</v-card>
		</v-dialog>

		<BatchDialog v-model="batchOpen" :paths="selection" :recipe="recipe" :scripts-trusted="trusted" />

		<v-dialog v-model="settingsOpen" max-width="34rem">
			<v-card title="Settings">
				<v-card-text>
					<div class="text-caption text-medium-emphasis mb-1">Preflight gate</div>
					<p class="text-body-2 text-medium-emphasis mb-2">
						Block Apply while the selected file has an error-level preflight check outstanding.
						A file you have not inspected does not block, but the page reminds you to. Off by
						default: the checks are heuristic.
					</p>
					<v-switch :model-value="preflightGate" label="Require a clean preflight before Apply"
							  density="compact" hide-details color="primary"
							  @update:model-value="(v: boolean | null) => setPreflightGate(v === true)" />

					<v-divider class="my-4" />

					<div class="text-caption text-medium-emphasis mb-1">Auto-run on upload</div>
					<p class="text-body-2 text-medium-emphasis mb-2">
						When a file is uploaded to the SD card from this browser tab, automatically pick a
						matching recipe (using each recipe's "Only files matching" / "Only in folder" /
						"Only when sliced by" rules) and apply it. Only works while this browser tab stays
						open — an upload made from a slicer straight to the Duet is not seen here.
					</p>
					<v-switch v-model="autoRunEnabled" label="Enable auto-run" density="compact" hide-details
							  color="primary" @update:model-value="onAutoRunEnabledChange" />
					<v-switch v-model="autoRunSilent" label="Skip the confirmation prompt (silent mode)"
							  density="compact" hide-details color="warning" class="mt-2"
							  :disabled="!autoRunEnabled" @update:model-value="onAutoRunSilentChange" />
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Close" @click="settingsOpen = false" />
				</v-card-actions>
			</v-card>
		</v-dialog>

		<AboutDialog v-model="aboutOpen" plugin-id="GCodePostProcessor" title="G-code Post-Processor"
					 description="Post-process G-code already on the SD card: find and replace, command mapping, layer-anchored insertion, rules and scripts."
					 :model="machineStore.model"
					 :repo="repoUrl"
					 :docs-url="docsUrl" docs-label="Usage guide"
					 :update-available="updateState?.updateAvailable ?? false"
					 :latest-version="updateState?.latestVersion ?? ''"
					 :applying="applying"
					 :pending-reload="pendingReload"
					 :auto-check="autoCheck"
					 :extra-actions="diagnosticsActions"
					 @check-update="checkUpdate"
					 @apply-update="applyUpdateNow"
					 @toggle-auto-check="toggleAutoCheck" />
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AboutDialog, type AboutExtraAction } from "dwc-plugin-runtime";
import { buildReport, copyReport, downloadReport, recordError } from "dwc-plugin-runtime/diagnostics";
import { downloadBlob } from "dwc-plugin-runtime/download";
import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";

import BackupManager from "./BackupManager.vue";
import BatchDialog from "./BatchDialog.vue";
import CompareFiles from "./CompareFiles.vue";
import DiffPreview from "./DiffPreview.vue";
import FileInspector from "./FileInspector.vue";
import GcodeBrowser from "./GcodeBrowser.vue";
import RecipeEditor from "./RecipeEditor.vue";
import RunHistory from "./RunHistory.vue";
import { isAutoRunEnabled, isAutoRunSilent, setAutoRunEnabled, setAutoRunSilent } from "../dwc/autoRun";
import { useBreakpoint } from "../dwc/useBreakpoint";
import { createGateway } from "../dwc/gateway";
import { installedPluginVersion, jobFileName, machineLimits, machineStatus, mainboardFirmwareVersion, toolHeaterConfigs } from "../dwc/machineSnapshot";
import { usePluginSettings } from "../dwc/pluginSettings";
import { scriptsTrusted, setScriptsTrusted, trustedRecipes, useRecipes } from "../dwc/recipeStore";
import type { CheckResult } from "../model/checks";
import { DOCS_URL, LS_SELECTED_FILE, PLUGIN_MANIFEST_ID } from "../model/constants";
import { applyAndStart } from "../model/io/applyAndStart";
import { recordRun, toFailedHistoryEntry, toHistoryEntry } from "../model/io/history";
import { blocking, checkSafety, planOutput, type OutputMode, type SafetyIssue } from "../model/io/plan";
import { CancelledError, processFile, type ProcessResult, type ProgressUpdate } from "../model/io/transfer";
import { usesScripts, validateRecipe, type Recipe } from "../model/recipe";
import { buildRunReport } from "../model/runReport";
import {
	applying, applyUpdateNow, autoCheck, pendingReload, runUpdateCheck, toggleAutoCheck, updateState,
} from "../model/updateCheck";

const machineStore = useMachineStore();
const uiStore = useUiStore();
const { recipes, active: recipe, save, add, remove, select, duplicate } = useRecipes();
const { xs, controlDensity } = useBreakpoint();
const { preflightGate, setPreflightGate } = usePluginSettings();

const repoUrl = "https://github.com/jaysuk/duet-gcode-postprocessor";
const docsUrl = DOCS_URL;

const tab = ref("recipe");
// The inspector is v-if'd on first open then kept alive with v-show — a plain v-show would mount it
// at startup for someone who never opens the tab; a plain v-if would throw its analysis (and the
// preflight result the gate reads) away on every tab switch.
const hasOpenedInspect = ref(false);
watch(tab, (t) => { if (t === "inspect") hasOpenedInspect.value = true; });
const aboutOpen = ref(false);
const selection = ref<Array<string>>([]);
const batchOpen = ref(false);
const settingsOpen = ref(false);
const autoRunEnabled = ref(isAutoRunEnabled());
const autoRunSilent = ref(isAutoRunSilent());
const confirmOpen = ref(false);
const startAfterApply = ref(false);
const selectedPath = ref<string | null>(readStoredPath());
const outputMode = ref<OutputMode>("alongside");
const suffix = ref(".pp");
const folder = ref("0:/gcodes/postprocessed");

const busy = ref(false);
const targetExists = ref(false);
const sourceSize = ref<number | null>(null);
const progress = ref<ProgressUpdate | null>(null);
const runError = ref<string | null>(null);
const lastRun = ref<ProcessResult | null>(null);
const applied = ref<ProcessResult | null>(null);
let signal = { aborted: false };

const outputModes = [
	{ value: "alongside", label: "As a new file next to the original" },
	{ value: "folder", label: "Into another folder" },
	{ value: "inPlace", label: "Over the original (with a backup)" },
];

const trustedSet = trustedRecipes();
const trusted = computed(() => trustedSet.value.has(recipe.value?.id ?? ""));

const problems = computed(() => (recipe.value === null ? [] : validateRecipe(recipe.value)));

const plan = computed(() => (selectedPath.value === null ? null : planOutput({
	sourcePath: selectedPath.value,
	mode: outputMode.value,
	suffix: suffix.value,
	folder: folder.value,
})));

const plannedTarget = computed(() => plan.value?.targetPath ?? "");

const safety = computed<Array<SafetyIssue>>(() => {
	if (selectedPath.value === null || plan.value === null || recipe.value === null) return [];
	return checkSafety({
		sourcePath: selectedPath.value,
		plan: plan.value,
		jobFileName: jobFileName(machineStore.model),
		status: machineStatus(machineStore.model),
		sizeBytes: lastRun.value?.bytesIn ?? sourceSize.value,
		existingStamp: lastRun.value?.existingStamp ?? null,
		targetExists: targetExists.value,
		recipe: recipe.value,
	});
});

const blockers = computed(() => blocking(safety.value));
const warnings = computed(() => safety.value.filter((i) => i.level === "warn"));

const canRun = computed(() => (
	machineStore.isConnected
	&& selectedPath.value !== null
	&& recipe.value !== null
	&& problems.value.length === 0
	&& (!usesScripts(recipe.value) || trusted.value)
));

// Preflight gate (E13). FileInspector emits the same merged, sorted check list it renders — the
// synchronous checks *and* the asynchronous macro check — so the gate can never judge a file by a
// different set of checks than the one shown on the Inspect tab. When the gate is on, an error-level
// check blocks Apply. A file that has never been inspected is NOT a failed file: it does not block,
// but the UI surfaces "not checked yet" rather than passing silently.
const lastPreflight = ref<{ path: string; errors: Array<CheckResult> } | null>(null);

function onChecked(checks: Array<CheckResult>, path: string): void {
	// An inspection of a large file takes tens of seconds; if the selection moved on while it ran,
	// this verdict belongs to a file the user is no longer looking at
	if (path !== selectedPath.value) return;
	lastPreflight.value = { path, errors: checks.filter((c) => c.level === "error") };
}

const preflightErrors = computed(() => (
	lastPreflight.value !== null && lastPreflight.value.path === selectedPath.value
		? lastPreflight.value.errors
		: null
));

const preflightBlocks = computed(() => (
	preflightGate.value && preflightErrors.value !== null && preflightErrors.value.length > 0
));

/** A non-blocking note: the gate is on and this file has not been inspected yet. */
const preflightUnchecked = computed(() => (
	preflightGate.value && selectedPath.value !== null && recipe.value !== null && preflightErrors.value === null
));

const canApply = computed(() => canRun.value && blockers.value.length === 0 && !preflightBlocks.value);

const blockedReason = computed(() => {
	if (!machineStore.isConnected) return "Not connected to a machine.";
	if (selectedPath.value === null) return "Select a G-code file to work on.";
	if (recipe.value === null) return "Create or select a recipe.";
	if (problems.value.length > 0) return `The recipe has a problem: ${problems.value[0].message}`;
	if (usesScripts(recipe.value) && !trusted.value) {
		return "This recipe contains a script. Review it and tick \"Trust scripts in this recipe\".";
	}
	if (blockers.value.length > 0) return blockers.value[0].message;
	if (preflightBlocks.value && preflightErrors.value !== null) {
		return `Preflight: ${preflightErrors.value[0].title}. ${preflightErrors.value[0].detail}`;
	}
	return "";
});

const phaseLabel = computed(() => {
	switch (progress.value?.phase) {
		case "downloading": return "Downloading";
		case "scanning": return "Reading the header";
		case "analysing": return "Analysing";
		case "processing": return "Processing";
		case "uploading": return "Uploading";
		case "finalising": return "Finishing up";
		case "done": return "Done";
		default: return "Working";
	}
});

watch(selectedPath, (value) => {
	// The preview belongs to one file; keeping it after switching would invite applying it to the
	// wrong one
	lastRun.value = null;
	applied.value = null;
	runError.value = null;
	startAfterApply.value = false;
	lastPreflight.value = null;
	try {
		if (value === null) localStorage.removeItem(LS_SELECTED_FILE);
		else localStorage.setItem(LS_SELECTED_FILE, value);
	} catch {
		// storage disabled
	}
});

watch(recipe, () => {
	lastRun.value = null;
	applied.value = null;
});

// "The output would replace an existing file" is only worth warning about if it is true, so the
// target is actually looked up rather than assumed. Debounced by the watcher's own coalescing:
// typing in the suffix field re-runs this, and a stale answer is corrected by the next one
watch([plannedTarget, selectedPath], async ([target]) => {
	targetExists.value = false;
	if (target === "" || target === selectedPath.value || !machineStore.isConnected) return;
	try {
		const size = await createGateway().sizeOf(target);
		if (plannedTarget.value === target) targetExists.value = size !== null;
	} catch {
		// A failed listing is not evidence either way; leave the warning off
	}
}, { immediate: true });

// The large-file warning only helps before the run it is warning about, so the source size is
// looked up as soon as a file is selected rather than waiting for a run to report it
watch(selectedPath, async (path) => {
	sourceSize.value = null;
	if (path === null || !machineStore.isConnected) return;
	try {
		const size = await createGateway().sizeOf(path);
		if (selectedPath.value === path) sourceSize.value = size;
	} catch {
		// A failed listing is not evidence of anything; leave the size unknown
	}
}, { immediate: true });

function readStoredPath(): string | null {
	try {
		return localStorage.getItem(LS_SELECTED_FILE);
	} catch {
		return null;
	}
}

function onRecipeChange(next: Recipe): void {
	save(next);
}

function onTrustChange(value: boolean): void {
	if (recipe.value === null) return;
	setScriptsTrusted(recipe.value.id, value);
}

function onImport(imported: Recipe): void {
	save(imported);
	select(imported.id);
}

function removeActive(): void {
	if (recipe.value !== null) remove(recipe.value.id);
}

function duplicateActive(): void {
	if (recipe.value !== null) duplicate(recipe.value.id);
}

function cancel(): void {
	signal.aborted = true;
}

function startApply(): void {
	confirmOpen.value = true;
}

async function confirmApply(): Promise<void> {
	confirmOpen.value = false;
	await run(false);
}

async function run(dryRun: boolean): Promise<void> {
	if (selectedPath.value === null || recipe.value === null || plan.value === null || busy.value) return;
	busy.value = true;
	runError.value = null;
	applied.value = null;
	progress.value = { phase: "downloading", fraction: 0 };
	signal = { aborted: false };

	const runOptions = {
		gateway: createGateway(),
		sourcePath: selectedPath.value,
		recipe: recipe.value,
		plan: plan.value,
		pluginVersion: installedPluginVersion(machineStore.model, PLUGIN_MANIFEST_ID),
		rrfVersion: mainboardFirmwareVersion(machineStore.model),
		scriptsTrusted: scriptsTrusted(recipe.value.id),
		dryRun,
		signal,
		limits: machineLimits(machineStore.model),
		toolHeaters: toolHeaterConfigs(machineStore.model),
		onProgress: (update: ProgressUpdate) => { progress.value = update; },
	};

	try {
		const result = !dryRun && startAfterApply.value
			? await applyAndStart({ ...runOptions, machineStatus: () => machineStatus(machineStore.model) })
			: await processFile(runOptions);
		lastRun.value = result;
		if (dryRun) {
			tab.value = "preview";
		} else {
			applied.value = result;
			uiStore.makeNotification(
				LogLevel.success,
				"G-code Post-Processor",
				startAfterApply.value ? `Wrote and started printing ${result.targetPath}` : `Wrote ${result.targetPath}`,
			);
			void recordRun(runOptions.gateway, toHistoryEntry(result, recipe.value, selectedPath.value, "page"));
		}
	} catch (e) {
		if (!(e instanceof CancelledError)) {
			runError.value = (e as Error).message;
			uiStore.makeNotification(LogLevel.error, "G-code Post-Processor", (e as Error).message);
			recordError("run", e);
			if (!dryRun) {
				void recordRun(runOptions.gateway, toFailedHistoryEntry(selectedPath.value, recipe.value, "page", e as Error));
			}
		}
	} finally {
		busy.value = false;
		progress.value = null;
	}
}

function checkUpdate(): void {
	void runUpdateCheck({ force: true });
}

/**
 * State handed to a diagnostics report, alongside the (already-redacted) object model `buildReport`
 * takes care of on its own. `scriptsTrusted` is stripped the same way `recipeStore.ts`'s own
 * `sanitise` does — trust is a per-session decision about code someone has read, never something a
 * shared report should assert. The diff is deliberately never included: it is the user's own file
 * content, and can be large — everything else here is metadata about the run, not the run's output.
 */
function diagnosticsState(): Record<string, unknown> {
	return {
		recipe: recipe.value === null ? null : { ...recipe.value, scriptsTrusted: undefined },
		selectedPath: selectedPath.value,
		lastRunStats: lastRun.value?.stats ?? null,
		lastError: runError.value,
	};
}

const diagnosticsActions = computed<Array<AboutExtraAction>>(() => [
	{
		label: "Download diagnostics (includes your recipe and the selected file's name)",
		icon: "mdi-download",
		onClick: () => {
			downloadReport(buildReport({ pluginId: PLUGIN_MANIFEST_ID, model: machineStore.model, state: diagnosticsState() }));
		},
	},
	{
		label: "Copy diagnostics (includes your recipe and the selected file's name)",
		icon: "mdi-content-copy",
		onClick: () => {
			void copyReport(buildReport({ pluginId: PLUGIN_MANIFEST_ID, model: machineStore.model, state: diagnosticsState() }));
		},
	},
]);

function onAutoRunEnabledChange(value: boolean | null): void {
	const enabled = value === true;
	setAutoRunEnabled(enabled);
	autoRunEnabled.value = isAutoRunEnabled();
	// setAutoRunEnabled(false) also clears silent mode — keep the switch in sync with that
	autoRunSilent.value = isAutoRunSilent();
}

function onAutoRunSilentChange(value: boolean | null): void {
	setAutoRunSilent(value === true);
	autoRunSilent.value = isAutoRunSilent();
}

function downloadAppliedReport(): void {
	if (applied.value === null || recipe.value === null) return;
	const report = buildRunReport({
		result: applied.value, recipe: recipe.value, sourcePath: selectedPath.value ?? "",
	});
	downloadBlob("gcode-postprocessor-run-report.md", report, "text/markdown");
}
</script>
