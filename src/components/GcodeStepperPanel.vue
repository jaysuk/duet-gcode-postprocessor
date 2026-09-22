<style scoped>
.stepper-state {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem;
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
}
</style>

<template>
	<div>
		<div class="d-flex align-center ga-2">
			<v-btn icon="mdi-skip-previous" size="small" variant="text" :disabled="currentStep <= 0"
				   title="Step back" @click="emit('update:currentStep', currentStep - 1)" />
			<v-slider :model-value="currentStep" :min="0" :max="Math.max(0, totalSteps - 1)" :step="1" hide-details
					  density="compact" class="flex-grow-1"
					  @update:model-value="(v: number) => emit('update:currentStep', Math.round(v))" />
			<v-btn icon="mdi-skip-next" size="small" variant="text" :disabled="currentStep >= totalSteps - 1"
				   title="Step forward" @click="emit('update:currentStep', currentStep + 1)" />
			<span class="text-caption text-medium-emphasis" style="min-width: 9rem; text-align: right">
				Step {{ totalSteps === 0 ? 0 : currentStep + 1 }} / {{ totalSteps }}<template v-if="line !== null"> (line {{ line }})</template>
			</span>
		</div>

		<div v-if="simulatedValues.length > 0" class="d-flex align-center ga-1 flex-wrap mt-1">
			<span class="text-caption text-medium-emphasis">Simulated:</span>
			<v-chip v-for="sv in simulatedValues" :key="sv.path" size="x-small" closable
					title="Click × to forget this simulated value" @click:close="emit('remove-simulated-value', sv.path)">
				{{ sv.path }} = {{ sv.display }}
			</v-chip>
			<v-btn icon="mdi-refresh" size="x-small" variant="text" title="Clear all simulated values"
				   @click="emit('reset-simulated-values')" />
		</div>

		<div class="stepper-state text-caption text-medium-emphasis mt-1">
			<template v-if="state !== null">
				<span v-if="state.layer >= 0">Layer {{ state.layer }}</span>
				<span v-if="state.x !== null">X{{ state.x.toFixed(2) }}</span>
				<span v-if="state.y !== null">Y{{ state.y.toFixed(2) }}</span>
				<span v-if="state.z !== null">Z{{ state.z.toFixed(2) }}</span>
				<span v-if="state.e !== null">E{{ state.e.toFixed(3) }}</span>
				<span v-if="state.tool >= 0">Tool {{ state.tool }}</span>
				<span v-if="state.feedrate !== null">F{{ state.feedrate }}</span>
				<span v-if="state.relativeMoves">G91 (relative)</span>
				<span v-if="state.object !== null">Object {{ state.object }}</span>
				<span v-if="state.featureType !== null">{{ state.featureType }}</span>
			</template>
			<span v-else class="font-italic">No state derived yet at this step.</span>
		</div>

		<v-alert v-if="status === 'paused' && pendingPath !== null" type="warning" variant="tonal" density="compact" class="mt-2">
			<div class="d-flex align-center ga-2 flex-wrap">
				<span>Execution depends on <code>{{ pendingPath }}</code>, which has no known value offline — what should the simulation use?</span>
				<v-text-field v-model="promptValue" density="compact" hide-details variant="outlined" style="max-width: 10rem"
							  placeholder="e.g. 1, true, ..." @keyup.enter="submitPrompt" />
				<v-btn size="small" color="warning" variant="tonal" :disabled="promptValue.trim() === ''" @click="submitPrompt">Apply</v-btn>
			</div>
		</v-alert>
		<v-alert v-else-if="status === 'error' && errorMessage !== null" type="error" variant="tonal" density="compact" class="mt-2">
			{{ errorMessage }}
		</v-alert>
	</div>
</template>

<script setup lang="ts">
/**
 * Purely presentational: the offline stepper's scrub bar + step buttons + a readout of the machine
 * state {@link MachineState} derives at the current EXECUTION STEP (not physical line — a false
 * `if`/`while` branch contributes no steps, a loop body contributes one step per iteration; see
 * `executionIndex.ts`), plus the "paused, needs a simulated value" prompt for a condition that
 * references an object-model path this offline simulation can't know (no live machine), and the list
 * of simulated values currently in effect, each individually removable. Owns no state of its own
 * beyond the slider's live drag value and the prompt's text input — `GcodeEditor.vue` (the wiring
 * layer) supplies everything else and applies `update:currentStep`/`resolve-path`/
 * `remove-simulated-value`/`reset-simulated-values` back to its own source of truth.
 */
import { ref, watch } from "vue";
import type { MachineState } from "../model/gcode/state";

const props = defineProps<{
	currentStep: number;
	totalSteps: number;
	/** 1-based physical line the current step executes, for display and editor highlighting — null
	 *  when there's no step to show yet (e.g. an empty file, or paused before any step completed). */
	line: number | null;
	state: MachineState | null;
	status: "complete" | "paused" | "error";
	pendingPath: string | null;
	errorMessage: string | null;
	/** Every simulated value currently in effect, `display` already formatted for read-only display —
	 *  this component stays free of `dwc-gcode-core`'s `EvalValue` formatting concerns. */
	simulatedValues: ReadonlyArray<{ path: string; display: string }>;
}>();
const emit = defineEmits<{
	"update:currentStep": [number];
	"resolve-path": [path: string, rawValue: string];
	"remove-simulated-value": [path: string];
	"reset-simulated-values": [];
}>();

const promptValue = ref("");
watch(() => props.pendingPath, () => { promptValue.value = ""; });

function submitPrompt(): void {
	if (props.pendingPath === null || promptValue.value.trim() === "") return;
	emit("resolve-path", props.pendingPath, promptValue.value);
}
</script>
