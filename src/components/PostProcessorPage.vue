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
		flex: 0 0 auto;
		max-width: none;
	}
}
</style>

<template>
	<div class="page">
		<v-toolbar density="comfortable" color="surface">
			<v-icon class="ms-4 me-2">mdi-file-replace-outline</v-icon>
			<v-toolbar-title class="text-body-large">G-code Post-Processor</v-toolbar-title>
			<v-spacer />
			<v-btn variant="text" icon title="About" @click="aboutOpen = true">
				<v-icon>mdi-information-outline</v-icon>
			</v-btn>
		</v-toolbar>

		<div class="panes">
			<v-card class="browser-pane" variant="outlined">
				<GcodeBrowser v-model="selectedPath" style="width: 100%" />
			</v-card>

			<v-card class="work-pane" variant="outlined">
				<v-tabs v-model="tab" density="compact">
					<v-tab value="recipe">Recipe</v-tab>
					<v-tab value="inspect">Inspect</v-tab>
					<v-tab value="preview">
						Preview
						<v-badge v-if="lastRun !== null" inline :content="lastRun.diff.length" color="primary" />
					</v-tab>
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

					<FileInspector v-if="tab === 'inspect'" :path="selectedPath" />

					<DiffPreview v-if="tab === 'preview'"
								 :stats="lastRun?.stats ?? null"
								 :diff="lastRun?.diff ?? []"
								 :recipe="recipe"
								 :source-name="selectedPath ?? ''" />
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
				{{ (applied.durationMs / 1000).toFixed(1) }} s.
				<template v-if="applied.backupPath !== null">
					The original is backed up at <code>{{ applied.backupPath }}</code>.
				</template>
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

			<div class="d-flex align-center flex-wrap ga-2">
				<v-select v-model="outputMode" :items="outputModes" item-title="label" item-value="value"
						  density="compact" hide-details variant="outlined" label="Write the result"
						  style="max-width: 20rem" :disabled="busy" />

				<v-text-field v-if="outputMode === 'alongside'" v-model="suffix" density="compact" hide-details
							  variant="outlined" label="Suffix" style="max-width: 10rem" :disabled="busy" />

				<v-text-field v-if="outputMode === 'folder'" v-model="folder" density="compact" hide-details
							  variant="outlined" label="Destination folder" style="max-width: 20rem"
							  :disabled="busy" />

				<v-spacer />

				<v-btn v-if="busy" variant="text" @click="cancel">Cancel</v-btn>
				<v-btn prepend-icon="mdi-eye-outline" variant="tonal" :disabled="!canRun || busy"
					   @click="run(true)">
					Preview
				</v-btn>
				<v-btn prepend-icon="mdi-content-save-outline" color="primary" :disabled="!canApply || busy"
					   @click="startApply">
					Apply
				</v-btn>
			</div>

			<div v-if="!canRun" class="text-caption text-medium-emphasis mt-2">
				{{ blockedReason }}
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
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Cancel" @click="confirmOpen = false" />
					<v-btn text="Apply" color="primary" @click="confirmApply" />
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
					 @check-update="checkUpdate"
					 @apply-update="applyUpdateNow"
					 @toggle-auto-check="toggleAutoCheck" />
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AboutDialog } from "dwc-plugin-runtime";
import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";

import DiffPreview from "./DiffPreview.vue";
import FileInspector from "./FileInspector.vue";
import GcodeBrowser from "./GcodeBrowser.vue";
import RecipeEditor from "./RecipeEditor.vue";
import { createGateway } from "../dwc/gateway";
import { jobFileName, machineStatus } from "../dwc/machineSnapshot";
import { scriptsTrusted, setScriptsTrusted, trustedRecipes, useRecipes } from "../dwc/recipeStore";
import { DOCS_URL, LS_SELECTED_FILE, PLUGIN_MANIFEST_ID } from "../model/constants";
import { blocking, checkSafety, planOutput, type OutputMode, type SafetyIssue } from "../model/io/plan";
import { CancelledError, processFile, type ProcessResult, type ProgressUpdate } from "../model/io/transfer";
import { usesScripts, validateRecipe, type Recipe } from "../model/recipe";
import {
	applying, applyUpdateNow, autoCheck, pendingReload, runUpdateCheck, toggleAutoCheck, updateState,
} from "../model/updateCheck";

const machineStore = useMachineStore();
const uiStore = useUiStore();
const { recipes, active: recipe, save, add, remove, select, duplicate } = useRecipes();

const repoUrl = "https://github.com/jaysuk/duet-gcode-postprocessor";
const docsUrl = DOCS_URL;

const tab = ref("recipe");
const aboutOpen = ref(false);
const confirmOpen = ref(false);
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

const canApply = computed(() => canRun.value && blockers.value.length === 0);

const blockedReason = computed(() => {
	if (!machineStore.isConnected) return "Not connected to a machine.";
	if (selectedPath.value === null) return "Select a G-code file to work on.";
	if (recipe.value === null) return "Create or select a recipe.";
	if (problems.value.length > 0) return `The recipe has a problem: ${problems.value[0].message}`;
	if (usesScripts(recipe.value) && !trusted.value) {
		return "This recipe contains a script. Review it and tick \"Trust scripts in this recipe\".";
	}
	if (blockers.value.length > 0) return blockers.value[0].message;
	return "";
});

const phaseLabel = computed(() => {
	switch (progress.value?.phase) {
		case "downloading": return "Downloading";
		case "scanning": return "Reading the header";
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

	try {
		const result = await processFile({
			gateway: createGateway(),
			sourcePath: selectedPath.value,
			recipe: recipe.value,
			plan: plan.value,
			pluginVersion: installedVersion(),
			scriptsTrusted: scriptsTrusted(recipe.value.id),
			dryRun,
			signal,
			onProgress: (update) => { progress.value = update; },
		});
		lastRun.value = result;
		if (dryRun) {
			tab.value = "preview";
		} else {
			applied.value = result;
			uiStore.makeNotification(
				LogLevel.success,
				"G-code Post-Processor",
				`Wrote ${result.targetPath}`,
			);
		}
	} catch (e) {
		if (!(e instanceof CancelledError)) {
			runError.value = (e as Error).message;
			uiStore.makeNotification(LogLevel.error, "G-code Post-Processor", (e as Error).message);
		}
	} finally {
		busy.value = false;
		progress.value = null;
	}
}

function installedVersion(): string {
	const plugins = (machineStore.model as { plugins?: Map<string, { version?: string }> }).plugins;
	return plugins?.get(PLUGIN_MANIFEST_ID)?.version ?? "0.0.0";
}

function checkUpdate(): void {
	void runUpdateCheck({ force: true });
}
</script>
