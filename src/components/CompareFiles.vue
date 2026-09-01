<style scoped>
.slots {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 0.75rem;
}

@media (max-width: 760px) {
	.slots {
		grid-template-columns: 1fr;
	}
}

.slot-path {
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
	font-size: 0.8125rem;
}

.diff-row {
	background: rgba(var(--v-theme-warning), 0.08);
}
</style>

<template>
	<div class="pa-3">
		<p class="text-body-2 text-medium-emphasis mb-3">
			Compares two files' own analysis — time, filament, temperatures, limits — not their G-code
			line by line. Pick any two files; neither has to be the one selected on the left.
		</p>

		<div class="slots mb-3">
			<v-card v-for="(slot, index) in slots" :key="index" variant="outlined" class="pa-3">
				<div class="d-flex align-center ga-2 mb-2">
					<span class="text-caption text-medium-emphasis">File {{ index === 0 ? "A" : "B" }}</span>
					<v-spacer />
					<v-btn size="small" variant="text" prepend-icon="mdi-file-outline" @click="openPicker(index)">
						{{ slot.path === null ? "Pick a file" : "Change" }}
					</v-btn>
				</div>

				<div v-if="slot.path !== null" class="slot-path text-truncate mb-2">{{ slot.path }}</div>
				<div v-else class="text-medium-emphasis mb-2">No file chosen.</div>

				<div class="d-flex align-center ga-2 mb-2">
					<v-btn size="small" :loading="slot.busy" :disabled="slot.path === null || !machineStore.isConnected"
						   prepend-icon="mdi-magnify-scan" variant="tonal" @click="analyseSlot(index)">
						{{ slot.analysis === null ? "Analyse" : "Re-analyse" }}
					</v-btn>
					<v-btn v-if="slot.busy" size="small" variant="text" @click="slot.signal.aborted = true">Cancel</v-btn>
				</div>

				<v-progress-linear v-if="slot.busy" :model-value="(slot.progress ?? 0) * 100"
								   :indeterminate="slot.progress === null" height="4" rounded class="mb-2" />

				<v-alert v-if="slot.error !== null" type="error" variant="tonal" density="compact">
					{{ slot.error }}
				</v-alert>

				<p v-if="slot.analysis !== null" class="text-body-2 mb-0">{{ summariseFile(slot.analysis) }}</p>
			</v-card>
		</div>

		<v-alert v-if="!machineStore.isConnected" type="info" variant="tonal" density="compact" class="mb-3">
			Connect to the machine to analyse a file.
		</v-alert>

		<v-table v-if="rows.length > 0" density="compact">
			<thead>
				<tr>
					<th>Fact</th>
					<th>File A</th>
					<th>File B</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="r in rows" :key="r.label" :class="{ 'diff-row': !r.same }">
					<td>{{ r.label }}</td>
					<td>{{ r.a }}</td>
					<td>{{ r.b }}</td>
				</tr>
			</tbody>
		</v-table>
		<div v-else class="text-medium-emphasis">
			Pick and analyse both files to see the comparison.
		</div>

		<v-dialog v-model="pickerOpen" max-width="30rem">
			<v-card title="Pick a file">
				<v-card-text style="height: 24rem">
					<GcodeBrowser v-model="pickerTarget" style="height: 100%" />
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Done" @click="pickerOpen = false" />
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useMachineStore } from "@/stores/machine";

import GcodeBrowser from "./GcodeBrowser.vue";
import { createGateway } from "../dwc/gateway";
import { machineLimits } from "../dwc/machineSnapshot";
import type { FileAnalysis } from "../model/analysis";
import { compareAnalyses } from "../model/compareFiles";
import { CancelledError, inspectFile, type ProgressUpdate } from "../model/io/transfer";
import { summariseFile } from "../model/summary";

const props = defineProps<{ initialPath?: string | null }>();

const machineStore = useMachineStore();

interface Slot {
	path: string | null;
	analysis: FileAnalysis | null;
	busy: boolean;
	progress: number | null;
	error: string | null;
	signal: { aborted: boolean };
}

function makeSlot(path: string | null): Slot {
	return { path, analysis: null, busy: false, progress: null, error: null, signal: { aborted: false } };
}

const slots = reactive<Array<Slot>>([makeSlot(props.initialPath ?? null), makeSlot(null)]);

// The page's own selection is only a starting point for slot A — a later change on the main page
// must not yank a comparison the user is actively looking at out from under them
let primedFromInitial = props.initialPath ?? null;
watch(() => props.initialPath, (path) => {
	if (slots[0].path !== primedFromInitial) return;
	primedFromInitial = path ?? null;
	slots[0].path = path ?? null;
	slots[0].analysis = null;
});

const pickerOpen = ref(false);
const pickerIndex = ref<number>(0);
const pickerTarget = computed({
	get: () => slots[pickerIndex.value].path,
	set: (value: string | null) => {
		slots[pickerIndex.value].path = value;
		slots[pickerIndex.value].analysis = null;
		pickerOpen.value = false;
	},
});

function openPicker(index: number): void {
	pickerIndex.value = index;
	pickerOpen.value = true;
}

async function analyseSlot(index: number): Promise<void> {
	const slot = slots[index];
	if (slot.path === null || slot.busy) return;
	slot.busy = true;
	slot.error = null;
	slot.progress = 0;
	slot.signal = { aborted: false };
	const signal = slot.signal;
	try {
		const result = await inspectFile({
			gateway: createGateway(),
			sourcePath: slot.path,
			signal,
			onProgress: (update: ProgressUpdate) => { slot.progress = update.fraction; },
			limits: machineLimits(machineStore.model),
		});
		slot.analysis = result.analysis;
	} catch (e) {
		if (!(e instanceof CancelledError)) slot.error = (e as Error).message;
	} finally {
		slot.busy = false;
		slot.progress = null;
	}
}

const rows = computed(() => (
	slots[0].analysis === null || slots[1].analysis === null
		? []
		: compareAnalyses(slots[0].analysis, slots[1].analysis)
));
</script>
