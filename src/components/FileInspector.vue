<style scoped>
.stat-label {
	opacity: 0.7;
}

.command-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
	gap: 0.25rem 1rem;
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
	font-size: 0.8125rem;
}
</style>

<template>
	<div class="pa-3">
		<v-alert v-if="path === null" type="info" variant="tonal" density="compact">
			Select a G-code file to inspect it.
		</v-alert>

		<template v-else>
			<div class="d-flex align-center ga-2 mb-3">
				<v-btn :loading="busy" :disabled="!machineStore.isConnected"
					   prepend-icon="mdi-magnify-scan" variant="tonal" @click="inspect">
					{{ analysis === null ? "Inspect this file" : "Re-inspect" }}
				</v-btn>
				<v-btn v-if="busy" variant="text" @click="cancel">Cancel</v-btn>
				<v-spacer />
				<span class="text-caption text-medium-emphasis text-truncate">{{ path }}</span>
			</div>

			<v-progress-linear v-if="busy" :model-value="progressPercent" :indeterminate="progress === null"
							   height="6" rounded class="mb-3" />

			<v-alert v-if="error !== null" type="error" variant="tonal" density="compact" class="mb-3">
				{{ error }}
			</v-alert>

			<div v-if="analysis === null && !busy" class="text-medium-emphasis">
				Nothing read yet. Inspecting downloads the file and reads it once — nothing is written.
			</div>

			<template v-if="analysis !== null">
				<v-alert v-if="stamps.length > 0" type="info" variant="tonal" density="compact" class="mb-3">
					<div v-for="(stamp, index) in stamps" :key="index">
						Already post-processed with <strong>{{ stamp.recipe }}</strong>
						(v{{ stamp.pluginVersion }}, {{ stamp.at }}).
					</div>
				</v-alert>

				<v-row dense>
					<v-col v-for="stat in stats" :key="stat.label" cols="6" sm="4" md="3">
						<div class="text-caption stat-label">{{ stat.label }}</div>
						<div class="text-body-1">{{ stat.value }}</div>
					</v-col>
				</v-row>

				<v-expansion-panels variant="accordion" class="mt-4">
					<v-expansion-panel title="Preflight checks">
						<v-expansion-panel-text>
							<v-alert v-if="checks.length === 0" type="success" variant="tonal" density="compact">
								Nothing to report against this machine.
							</v-alert>
							<v-alert v-for="check in checks" :key="check.code" class="mb-2" density="compact"
									 variant="tonal"
									 :type="check.level === 'error' ? 'error' : check.level === 'warning' ? 'warning' : 'info'">
								<div class="font-weight-medium">{{ check.title }}</div>
								<div class="text-body-2">{{ check.detail }}</div>
							</v-alert>
						</v-expansion-panel-text>
					</v-expansion-panel>

					<v-expansion-panel title="Commands used">
						<v-expansion-panel-text>
							<div class="command-grid">
								<div v-for="[code, count] in commandList" :key="code">
									{{ code }} <span class="stat-label">× {{ count.toLocaleString() }}</span>
								</div>
							</div>
						</v-expansion-panel-text>
					</v-expansion-panel>

					<v-expansion-panel title="Slicer settings found">
						<v-expansion-panel-text>
							<div v-if="metaEntries.length === 0" class="text-medium-emphasis">
								No slicer metadata in this file.
							</div>
							<div v-for="[key, value] in metaEntries" :key="key" class="text-body-2">
								<span class="stat-label">{{ key }}</span> = {{ value }}
							</div>
						</v-expansion-panel-text>
					</v-expansion-panel>
				</v-expansion-panels>
			</template>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMachineStore } from "@/stores/machine";

import { createGateway } from "../dwc/gateway";
import { machineSnapshot } from "../dwc/machineSnapshot";
import type { FileAnalysis } from "../model/analysis";
import { runChecks, type CheckResult } from "../model/checks";
import type { SlicerMetadata } from "../model/gcode/metadata";
import { formatBytes } from "../model/io/plan";
import { CancelledError, inspectFile, type ProgressUpdate } from "../model/io/transfer";
import type { Stamp } from "../model/recipe";

const props = defineProps<{ path: string | null }>();

const emit = defineEmits<{ analysed: [analysis: FileAnalysis] }>();

const machineStore = useMachineStore();

const analysis = ref<FileAnalysis | null>(null);
const meta = ref<SlicerMetadata | null>(null);
const stamps = ref<Array<Stamp>>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const progress = ref<number | null>(null);
let signal = { aborted: false };

// A new selection invalidates everything: showing the previous file's statistics under a new
// filename would be worse than showing nothing
watch(() => props.path, () => {
	analysis.value = null;
	meta.value = null;
	stamps.value = [];
	error.value = null;
});

const progressPercent = computed(() => (progress.value === null ? 0 : progress.value * 100));

const checks = computed<Array<CheckResult>>(() => (
	analysis.value === null ? [] : runChecks(analysis.value, machineSnapshot(machineStore.model))
));

const commandList = computed(() => (analysis.value === null ? [] : [...analysis.value.commandCounts.entries()]));

const metaEntries = computed(() => (meta.value === null ? [] : [...meta.value.values.entries()].slice(0, 200)));

const stats = computed(() => {
	const a = analysis.value;
	if (a === null) return [];
	const m = a.meta;
	const rows: Array<{ label: string; value: string }> = [
		{ label: "Slicer", value: m.slicer === "unknown" ? "not recognised" : `${m.slicer} ${m.slicerVersion ?? ""}`.trim() },
		{ label: "Size", value: formatBytes(a.bytes) },
		{ label: "Lines", value: a.lines.toLocaleString() },
		{ label: "Layers", value: String(a.layers) },
		{ label: "Layer height", value: m.layerHeight === null ? "—" : `${m.layerHeight} mm` },
		{ label: "Print time", value: m.printTimeSeconds === null ? "—" : formatDuration(m.printTimeSeconds) },
		{ label: "Filament", value: m.filamentMm === null ? "—" : `${(m.filamentMm / 1000).toFixed(2)} m` },
		{ label: "Tools used", value: a.tools.length === 0 ? "none" : a.tools.map((t) => `T${t}`).join(", ") },
		{ label: "Hot end", value: a.maxToolTemp === null ? "—" : `${a.maxToolTemp} °C` },
		{ label: "Bed", value: a.maxBedTemp === null ? "—" : `${a.maxBedTemp} °C` },
		{ label: "Max feedrate", value: a.maxFeedrate === null ? "—" : `${a.maxFeedrate} mm/min` },
		{ label: "Flavour", value: describeFlavour(a) },
		{ label: "Extrusion", value: a.usesRelativeE ? "relative (M83)" : "absolute (M82)" },
		{ label: "Objects (M486)", value: a.objects.length === 0 ? "none" : String(a.objects.length) },
	];
	if (a.extents !== null) {
		rows.push({
			label: "Extents",
			value: `X ${a.extents.minX.toFixed(1)}–${a.extents.maxX.toFixed(1)}, `
				+ `Y ${a.extents.minY.toFixed(1)}–${a.extents.maxY.toFixed(1)}, `
				+ `Z ${a.extents.minZ.toFixed(2)}–${a.extents.maxZ.toFixed(2)}`,
		});
	}
	return rows;
});

function describeFlavour(a: FileAnalysis): string {
	switch (a.dialect.flavour) {
		case "rrf": return "RepRapFirmware";
		case "marlin": return "Marlin";
		case "klipper": return "Klipper";
		default: return "no strong signal";
	}
}

function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function cancel(): void {
	signal.aborted = true;
}

async function inspect(): Promise<void> {
	if (props.path === null || busy.value) return;
	busy.value = true;
	error.value = null;
	progress.value = 0;
	signal = { aborted: false };
	try {
		const result = await inspectFile({
			gateway: createGateway(),
			sourcePath: props.path,
			signal,
			onProgress: (update: ProgressUpdate) => { progress.value = update.fraction; },
		});
		analysis.value = result.analysis;
		meta.value = result.meta;
		stamps.value = result.stamps;
		emit("analysed", result.analysis);
	} catch (e) {
		if (!(e instanceof CancelledError)) error.value = (e as Error).message;
	} finally {
		busy.value = false;
		progress.value = null;
	}
}
</script>
