<style scoped>
.path {
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
	font-size: 0.8125rem;
}
</style>

<template>
	<v-dialog :model-value="modelValue" max-width="40rem" persistent @update:model-value="onClose">
		<v-card :title="`Batch process ${paths.length} file${paths.length === 1 ? '' : 's'}`">
			<v-card-text>
				<template v-if="outcomes === null">
					<v-row dense class="mb-2">
						<v-col cols="12" sm="6">
							<v-select v-model="mode" :items="outputModes" item-title="label" item-value="value"
									  density="compact" hide-details label="Write the result" :disabled="running" />
						</v-col>
						<v-col v-if="mode === 'alongside'" cols="12" sm="6">
							<v-text-field v-model="suffix" density="compact" hide-details label="Suffix" :disabled="running" />
						</v-col>
						<v-col v-if="mode === 'folder'" cols="12" sm="6">
							<v-text-field v-model="folder" density="compact" hide-details label="Destination folder"
										  :disabled="running" />
						</v-col>
					</v-row>

					<v-alert v-if="backupCapWarning" type="warning" variant="tonal" density="compact" class="mb-2">
						{{ backupCapWarning }}
					</v-alert>

					<div v-if="!running" class="mb-2">
						<div class="text-body-2 mb-1">This will write:</div>
						<ul class="text-caption path" style="max-height: 10rem; overflow-y: auto">
							<li v-for="path in paths" :key="path">{{ path }}</li>
						</ul>
					</div>

					<template v-if="running">
						<v-progress-linear :model-value="(progressIndex / paths.length) * 100" height="8" rounded class="mb-2" />
						<div class="text-caption text-medium-emphasis mb-2">
							{{ progressIndex }} of {{ paths.length }} — {{ currentPath ?? "" }}
						</div>
					</template>
				</template>

				<template v-else>
					<v-alert v-for="line in summaryLines" :key="line" type="info" variant="tonal" density="compact" class="mb-2">
						{{ line }}
					</v-alert>
					<v-list density="compact">
						<v-list-item v-for="outcome in outcomes" :key="outcome.path">
							<template #prepend>
								<v-icon :color="iconColor(outcome.outcome)" size="small">{{ icon(outcome.outcome) }}</v-icon>
							</template>
							<template #title>
								<span class="path">{{ outcome.path }}</span>
							</template>
							<template #subtitle>
								{{ outcome.reason ?? outcome.error ?? describeDone(outcome) }}
							</template>
						</v-list-item>
					</v-list>
				</template>
			</v-card-text>
			<v-card-actions>
				<v-spacer />
				<v-btn v-if="running" text="Cancel" @click="cancel" />
				<template v-else-if="outcomes === null">
					<v-btn text="Cancel" @click="onClose(false)" />
					<v-btn text="Start" color="primary" @click="start" />
				</template>
				<v-btn v-else text="Close" @click="onClose(false)" />
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMachineStore } from "@/stores/machine";

import { createGateway } from "../dwc/gateway";
import { installedPluginVersion, jobFileName, machineLimits, machineStatus, mainboardFirmwareVersion, toolHeaterConfigs } from "../dwc/machineSnapshot";
import { MAX_BACKUPS, PLUGIN_MANIFEST_ID } from "../model/constants";
import { exceedsBackupCap, runBatch, type BatchFileOutcome } from "../model/io/batch";
import type { OutputMode } from "../model/io/plan";
import type { Recipe } from "../model/recipe";

const props = defineProps<{
	modelValue: boolean;
	paths: Array<string>;
	recipe: Recipe | null;
	scriptsTrusted: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const machineStore = useMachineStore();

const mode = ref<OutputMode>("alongside");
const suffix = ref(".pp");
const folder = ref("0:/gcodes/postprocessed");
const running = ref(false);
const progressIndex = ref(0);
const currentPath = ref<string | null>(null);
const outcomes = ref<Array<BatchFileOutcome> | null>(null);
let signal = { aborted: false };

const outputModes = [
	{ value: "alongside", label: "As a new file next to each original" },
	{ value: "folder", label: "Into another folder" },
	{ value: "inPlace", label: "Over each original (with a backup)" },
];

const backupCapWarning = computed(() => (
	exceedsBackupCap(mode.value, props.paths.length, MAX_BACKUPS)
		? `Writing ${props.paths.length} files in place will take more backups than this plugin keeps `
			+ `(${MAX_BACKUPS}) — the oldest backups from this batch will be pruned as it runs.`
		: null
));

watch(() => props.modelValue, (open) => {
	if (open) {
		outcomes.value = null;
		running.value = false;
		progressIndex.value = 0;
		currentPath.value = null;
	}
});

function onClose(value: boolean): void {
	if (!value) emit("update:modelValue", false);
}

function cancel(): void {
	signal.aborted = true;
}

async function start(): Promise<void> {
	if (props.recipe === null) return;
	running.value = true;
	signal = { aborted: false };
	try {
		await runBatchInto();
	} finally {
		// Without this, anything unexpected escaping runBatch would leave `running` true forever —
		// and while running, the dialog offers only Cancel, so it could not even be closed
		running.value = false;
	}
}

async function runBatchInto(): Promise<void> {
	if (props.recipe === null) return;
	const gateway = createGateway();
	outcomes.value = await runBatch({
		gateway,
		paths: props.paths,
		recipe: props.recipe,
		mode: mode.value,
		suffix: suffix.value,
		folder: folder.value,
		pluginVersion: installedPluginVersion(machineStore.model, PLUGIN_MANIFEST_ID),
		rrfVersion: mainboardFirmwareVersion(machineStore.model),
		scriptsTrusted: props.scriptsTrusted,
		limits: machineLimits(machineStore.model),
		toolHeaters: toolHeaterConfigs(machineStore.model),
		jobFileName: jobFileName(machineStore.model),
		machineStatus: machineStatus(machineStore.model),
		signal,
		onFileStart: (path, index) => { currentPath.value = path; progressIndex.value = index; },
		onFileDone: (_outcome, index) => { progressIndex.value = index + 1; },
	});
}

const summaryLines = computed(() => {
	if (outcomes.value === null) return [];
	const done = outcomes.value.filter((o) => o.outcome === "done").length;
	const skipped = outcomes.value.filter((o) => o.outcome === "skipped").length;
	const failed = outcomes.value.filter((o) => o.outcome === "failed").length;
	const notStarted = props.paths.length - outcomes.value.length;
	const lines = [`${done} written, ${skipped} skipped, ${failed} failed.`];
	if (notStarted > 0) lines.push(`${notStarted} file${notStarted === 1 ? "" : "s"} not started (cancelled).`);
	return lines;
});

function icon(outcome: BatchFileOutcome["outcome"]): string {
	return outcome === "done" ? "mdi-check-circle-outline" : outcome === "skipped" ? "mdi-minus-circle-outline" : "mdi-alert-circle-outline";
}

function iconColor(outcome: BatchFileOutcome["outcome"]): string {
	return outcome === "done" ? "success" : outcome === "skipped" ? "warning" : "error";
}

function describeDone(outcome: BatchFileOutcome): string {
	if (outcome.result === undefined) return "";
	const s = outcome.result.stats;
	const counts = `${s.linesChanged} changed, ${s.linesAdded} added, ${s.linesRemoved} removed`;
	// processFile prescans the copy it downloads, so the "this file already carried this recipe's
	// stamp" notice comes back on the result rather than costing a second transfer up front
	return outcome.result.existingStamp !== null
		? `${counts} — note: this file already carried this recipe's stamp`
		: counts;
}
</script>
