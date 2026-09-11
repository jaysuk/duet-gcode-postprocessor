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

/* Wide tables (feature stats, objects, retractions, metadata) scroll inside their own box on a
 * narrow panel rather than pushing the whole page sideways. */
.scroll-x {
	display: block;
	overflow-x: auto;
	max-width: 100%;
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
				<v-btn v-if="analysis !== null && !busy" :disabled="!canSimulate" :loading="simulating"
					   prepend-icon="mdi-play-speed" variant="tonal" @click="simulateDialog = true">
					Simulate on this machine
				</v-btn>
				<v-spacer />
				<span class="text-caption text-medium-emphasis text-truncate">{{ path }}</span>
			</div>

			<v-alert v-if="simulationResult !== null" type="success" variant="tonal" density="compact" class="mb-3">
				RepRapFirmware simulated this file in {{ formatDuration(simulationResult) }}
				<span v-if="analysis !== null && analysis.estimatedSeconds !== null">
					({{ formatDuration(analysis.estimatedSeconds) }} was this plugin's own estimate).
				</span>
				This is the most accurate figure available — the exact firmware that will run the print,
				not a model of it — but "Rewrite M73 print time" cannot be pointed at it yet: that step
				always recomputes M73 from this machine's own motion limits, not from a simulated total.
			</v-alert>
			<v-alert v-if="simulationError !== null" type="error" variant="tonal" density="compact" class="mb-3">
				{{ simulationError }}
			</v-alert>

			<v-dialog v-model="simulateDialog" max-width="34rem">
				<v-card title="Simulate this file on the machine?">
					<v-card-text>
						<p class="mb-2">
							Sends <code>M37</code> to have RepRapFirmware run the file through its own motion
							planner without moving anything, then reads back its own time estimate — the most
							accurate figure available, since it comes from the exact firmware that will print it.
						</p>
						<p class="mb-2">
							This briefly occupies the machine (shown as "Simulating" to anyone else watching it)
							but does not move it and does not take anywhere near the length of the real print —
							RepRapFirmware runs the simulation as fast as it can compute it, not in real time.
						</p>
						<v-alert v-if="!machineStore.isConnected" type="warning" variant="tonal" density="compact">
							Not connected to the machine.
						</v-alert>
					</v-card-text>
					<v-card-actions>
						<v-spacer />
						<v-btn text="Cancel" :disabled="simulating" @click="simulateDialog = false" />
						<v-btn text="Simulate" color="primary" :loading="simulating" :disabled="!canSimulate"
							   @click="runSimulation" />
					</v-card-actions>
				</v-card>
			</v-dialog>

			<v-progress-linear v-if="busy" :model-value="progressPercent" :indeterminate="progress === null"
							   height="6" rounded class="mb-3" />

			<v-alert v-if="error !== null" type="error" variant="tonal" density="compact" class="mb-3">
				{{ error }}
			</v-alert>

			<div v-if="analysis === null && !busy" class="text-medium-emphasis">
				Nothing read yet. Inspecting downloads the file and reads it once — nothing is written.
			</div>

			<template v-if="analysis !== null">
				<p class="text-body-2 text-medium-emphasis mb-3">{{ plainEnglishSummary }}</p>

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

				<v-alert v-if="clampingLabel !== null" type="info" variant="tonal" density="compact" class="mt-3">
					{{ clampingLabel }}
				</v-alert>

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

					<v-expansion-panel title="Fan speeds">
						<v-expansion-panel-text>
							<div v-if="fanRows.length === 0" class="text-medium-emphasis">
								No fan commands in this file.
							</div>
							<template v-else>
								<div v-if="mixedFanScale" class="text-caption text-warning mb-2">
									This file mixes 0–255 and 0–1 fan speed values — shown exactly as written.
								</div>
								<v-table density="compact" class="scroll-x">
									<thead>
										<tr>
											<th>Fan</th>
											<th>Speed</th>
											<th>Count</th>
											<th>Features</th>
										</tr>
									</thead>
									<tbody>
										<tr v-for="row in fanRows" :key="`${row.fan}-${row.speed}`">
											<td>P{{ row.fan }}</td>
											<td>S{{ row.speed }}</td>
											<td>{{ row.count.toLocaleString() }}</td>
											<td>{{ row.featureLabel }}</td>
										</tr>
									</tbody>
								</v-table>
							</template>
						</v-expansion-panel-text>
					</v-expansion-panel>

					<v-expansion-panel title="Time and filament by feature">
						<v-expansion-panel-text>
							<div v-if="featureRows.length === 0" class="text-medium-emphasis">
								No feature markers in this file.
							</div>
							<template v-else>
								<div v-if="!hasFeatureSeconds" class="text-caption text-medium-emphasis mb-2">
									Filament only — inspect with this machine connected for a time breakdown too.
								</div>
								<v-table density="compact" class="scroll-x">
									<thead>
										<tr>
											<th>Feature</th>
											<th v-if="hasFeatureSeconds">Time</th>
											<th>Filament</th>
											<th>Moves</th>
										</tr>
									</thead>
									<tbody>
										<tr v-for="row in featureRows" :key="row.feature">
											<td>{{ row.label }}</td>
											<td v-if="hasFeatureSeconds">{{ formatDuration(row.seconds) }}</td>
											<td>{{ (row.filamentMm / 1000).toFixed(2) }} m</td>
											<td>{{ row.moves.toLocaleString() }}</td>
										</tr>
									</tbody>
								</v-table>
							</template>
						</v-expansion-panel-text>
					</v-expansion-panel>

					<v-expansion-panel v-if="objectRows.length > 0" title="Time and filament by object">
						<v-expansion-panel-text>
							<v-table density="compact" class="scroll-x">
								<thead>
									<tr>
										<th>Object</th>
										<th v-if="hasFeatureSeconds">Time</th>
										<th>Filament</th>
									</tr>
								</thead>
								<tbody>
									<tr v-for="row in objectRows" :key="row.object">
										<td>{{ row.object }}</td>
										<td v-if="hasFeatureSeconds">{{ formatDuration(row.seconds) }}</td>
										<td>{{ (row.filamentMm / 1000).toFixed(2) }} m</td>
									</tr>
								</tbody>
							</v-table>
						</v-expansion-panel-text>
					</v-expansion-panel>

					<v-expansion-panel v-if="retractionRows.length > 0" title="Retractions by tool">
						<v-expansion-panel-text>
							<div class="text-caption text-medium-emphasis mb-2">
								A proxy for oozing and for wear — not a defect report on its own.
							</div>
							<v-table density="compact" class="scroll-x">
								<thead>
									<tr>
										<th>Tool</th>
										<th>Count</th>
										<th>Total distance</th>
									</tr>
								</thead>
								<tbody>
									<tr v-for="row in retractionRows" :key="row.tool">
										<td>T{{ row.tool }}</td>
										<td>{{ row.count.toLocaleString() }}</td>
										<td>{{ row.totalMm.toFixed(1) }} mm</td>
									</tr>
								</tbody>
							</v-table>
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
import { checkMacros } from "../dwc/macroCheck";
import { machineLimits, machineLimitsComplete, machineSnapshot, simulationStatus } from "../dwc/machineSnapshot";
import type { FileAnalysis } from "../model/analysis";
import { runChecks, type CheckResult } from "../model/checks";
import { featureLabel } from "../model/gcode/features";
import type { SlicerMetadata } from "../model/gcode/metadata";
import { BUSY_STATES, formatBytes, formatDuration } from "../model/io/plan";
import { simulateFile } from "../model/io/simulate";
import { CancelledError, inspectFile, type ProgressUpdate } from "../model/io/transfer";
import type { Stamp } from "../model/recipe";
import { summariseFile } from "../model/summary";

const props = defineProps<{ path: string | null }>();

/**
 * Emitted whenever this component's own verdict on a file changes — the same merged, sorted list the
 * panel renders, not the raw analysis, so a consumer (the preflight gate on the page) cannot end up
 * judging a file by a different set of checks than the one shown here. In particular the macro check
 * is asynchronous and lands after the analysis, so this fires again when it does.
 *
 * The `path` is carried explicitly and is the path the checks were actually computed for. A consumer
 * must compare it against its own current selection before acting: an inspection of a large file
 * takes tens of seconds, and the selection can change while it is in flight.
 */
const emit = defineEmits<{ checked: [checks: Array<CheckResult>, path: string] }>();

const machineStore = useMachineStore();

const analysis = ref<FileAnalysis | null>(null);
const meta = ref<SlicerMetadata | null>(null);
const stamps = ref<Array<Stamp>>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const progress = ref<number | null>(null);
// Snapshotted at inspection time, alongside the limits actually fed to the estimate — the machine's
// own configuration can change between inspections, so this must not be read live when labelling a
// result computed earlier. See docs/tasks/07-audit-defects.md, defect E: a partly-configured machine
// must not have its estimate presented as fully machine-specific.
const limitsWereComplete = ref(true);
let signal = { aborted: false };

const simulateDialog = ref(false);
const simulating = ref(false);
const simulationResult = ref<number | null>(null);
const simulationError = ref<string | null>(null);

const canSimulate = computed(() => {
	if (!machineStore.isConnected || analysis.value === null || simulating.value) return false;
	const status = simulationStatus(machineStore.model).status;
	return status === null || !BUSY_STATES.includes(status);
});

// A new selection invalidates everything: showing the previous file's statistics under a new
// filename would be worse than showing nothing
watch(() => props.path, () => {
	analysis.value = null;
	meta.value = null;
	stamps.value = [];
	error.value = null;
	macroResults.value = [];
	simulationResult.value = null;
	simulationError.value = null;
});

const progressPercent = computed(() => (progress.value === null ? 0 : progress.value * 100));

/** Checking macros needs a file listing, so it runs after the (synchronous) preflight checks and
 *  its results are merged in once they arrive — see the watcher in inspect(). */
const macroResults = ref<Array<CheckResult>>([]);

const CHECK_ORDER: Record<CheckResult["level"], number> = { error: 0, warning: 1, info: 2 };

const checks = computed<Array<CheckResult>>(() => {
	if (analysis.value === null) return [];
	const combined = [...runChecks(analysis.value, machineSnapshot(machineStore.model)), ...macroResults.value];
	return combined.sort((a, b) => CHECK_ORDER[a.level] - CHECK_ORDER[b.level]);
});

// Report the verdict outward whenever it changes — on the initial analysis, and again once the
// asynchronous macro check lands. Never fires for an un-analysed file: an empty list would read as
// "checked, nothing wrong", which is the opposite of "not checked yet".
watch(checks, (value) => {
	if (analysis.value === null || props.path === null) return;
	emit("checked", value, props.path);
});

const commandList = computed(() => (analysis.value === null ? [] : [...analysis.value.commandCounts.entries()]));

// A file mixing 0-255 and 0-1 fan speeds is unusual enough to be worth flagging rather than
// silently rendering "S0.5" next to "S255" with no explanation of why they look so different
const mixedFanScale = computed(() => {
	const settings = analysis.value?.fanSettings ?? [];
	return settings.some((s) => s.speed > 1) && settings.some((s) => s.speed > 0 && s.speed <= 1);
});

const fanRows = computed(() => (analysis.value?.fanSettings ?? []).map((s) => ({
	fan: s.fan,
	speed: s.speed,
	count: s.count,
	featureLabel: s.features.map((f) => `${featureLabel(f.feature)} (${f.count})`).join(", "),
})));

const metaEntries = computed(() => (meta.value === null ? [] : [...meta.value.values.entries()].slice(0, 200)));

const featureRows = computed(() => (analysis.value?.featureStats ?? []).map((f) => ({
	feature: f.feature,
	label: featureLabel(f.feature),
	seconds: f.seconds,
	filamentMm: f.filamentMm,
	moves: f.moves,
})));

// Seconds are always 0 across every feature when no machine limits were supplied (inspecting while
// disconnected, or a partly-configured machine) — showing a column of zeroes reads as "this feature
// takes no time" rather than "time was not measurable", so the column is hidden instead.
const hasFeatureSeconds = computed(() => featureRows.value.some((r) => r.seconds > 0));

const objectRows = computed(() => (analysis.value?.objectStats ?? []).map((o) => ({
	object: o.object,
	seconds: o.seconds,
	filamentMm: o.filamentMm,
})));

const retractionRows = computed(() => analysis.value?.retractionStats ?? []);

const plainEnglishSummary = computed(() => (analysis.value === null ? "" : summariseFile(analysis.value)));

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
		{ label: "Print time (slicer)", value: m.printTimeSeconds === null ? "—" : formatDuration(m.printTimeSeconds) },
		{ label: "Print time (this machine)", value: estimatedTimeLabel(a) },
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

function estimatedTimeLabel(a: FileAnalysis): string {
	if (a.estimatedSeconds === null) return "—";
	const duration = formatDuration(a.estimatedSeconds);
	switch (a.timeSource) {
		case "m73": return `${duration} (from M73 markers)`;
		case "model": return limitsWereComplete.value
			? `${duration} (estimated from this machine's limits)`
			: `${duration} (estimated — this machine's limits are incomplete)`;
		default: return duration;
	}
}

// Suppressed entirely (not merely caveated) when this machine's limits are incomplete — see
// docs/tasks/07-audit-defects.md, defect E. A missing axis limit falls back to "no limit" in the
// model, which would silently understate clamping rather than just being imprecise about it, so
// this comparison is not safe to show even with a caveat.
// Stated purely as a difference, never restating a total (task 10 finding F): "Print time (this
// machine)" above can be sourced from the file's own M73 markers rather than this model, and a
// restated clampedSeconds total here could visibly disagree with it for no reason a reader could
// see. The difference itself does not have that problem — it is the same figure either way.
const clampingLabel = computed(() => {
	const a = analysis.value;
	if (a === null || !limitsWereComplete.value) return null;
	if (a.clampedMoveCount <= 0 || a.clampedSeconds === null || a.unclampedSeconds === null) return null;
	const extra = a.clampedSeconds - a.unclampedSeconds;
	if (extra <= 0) return null;
	const moveCount = a.clampedMoveCount.toLocaleString();
	return `This machine's limits add about ${formatDuration(extra)} to this file, `
		+ `across ${moveCount} move${a.clampedMoveCount === 1 ? "" : "s"} that ask for more than it can do.`;
});

function cancel(): void {
	signal.aborted = true;
}

async function inspect(): Promise<void> {
	if (props.path === null || busy.value) return;
	// Captured up front: inspecting a large file takes tens of seconds, and the selection can change
	// while it runs. Everything below is discarded if it does — otherwise the resolved result would
	// re-populate the state the path watcher just cleared, showing (and reporting) one file's figures
	// under another file's name.
	const inspectedPath = props.path;
	busy.value = true;
	error.value = null;
	progress.value = 0;
	signal = { aborted: false };
	limitsWereComplete.value = machineLimitsComplete(machineStore.model);
	try {
		const result = await inspectFile({
			gateway: createGateway(),
			sourcePath: inspectedPath,
			signal,
			onProgress: (update: ProgressUpdate) => { progress.value = update.fraction; },
			limits: machineLimits(machineStore.model),
		});
		if (props.path !== inspectedPath) return;
		analysis.value = result.analysis;
		meta.value = result.meta;
		stamps.value = result.stamps;
		if (result.analysis.macroRefs.length > 0) {
			// Runs after the rest of the inspection has already reported; a slow or failed macro
			// lookup should never hold up everything else the user is waiting to see. Its results
			// merge into `checks`, which re-emits — see the watcher below.
			checkMacros(createGateway(), result.analysis.macroRefs)
				.then((results) => { if (props.path === inspectedPath) macroResults.value = results; })
				.catch(() => { /* a failed check reports nothing rather than a false positive */ });
		}
	} catch (e) {
		if (!(e instanceof CancelledError)) error.value = (e as Error).message;
	} finally {
		busy.value = false;
		progress.value = null;
	}
}

async function runSimulation(): Promise<void> {
	if (props.path === null || !canSimulate.value) return;
	simulating.value = true;
	simulationError.value = null;
	simulationResult.value = null;
	try {
		const seconds = await simulateFile({
			gateway: createGateway(),
			sourcePath: props.path,
			pollStatus: () => simulationStatus(machineStore.model),
		});
		simulationResult.value = seconds;
		simulateDialog.value = false;
	} catch (e) {
		simulationError.value = (e as Error).message;
	} finally {
		simulating.value = false;
	}
}
</script>
