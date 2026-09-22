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
			<v-btn icon="mdi-skip-previous" size="small" variant="text" :disabled="currentLine <= 1"
				   title="Step back one line" @click="emit('update:currentLine', currentLine - 1)" />
			<v-slider :model-value="currentLine" :min="1" :max="Math.max(1, totalLines)" :step="1" hide-details
					  density="compact" class="flex-grow-1"
					  @update:model-value="(v: number) => emit('update:currentLine', Math.round(v))" />
			<v-btn icon="mdi-skip-next" size="small" variant="text" :disabled="currentLine >= totalLines"
				   title="Step forward one line" @click="emit('update:currentLine', currentLine + 1)" />
			<span class="text-caption text-medium-emphasis" style="min-width: 6rem; text-align: right">
				Line {{ currentLine }} / {{ totalLines }}
			</span>
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
			<span v-else class="font-italic">No state derived yet at this line.</span>
		</div>
	</div>
</template>

<script setup lang="ts">
/**
 * Purely presentational: the offline file-stepper's scrub bar + step buttons + a readout of the
 * machine state {@link MachineState} derives at the current line. Owns no state of its own beyond the
 * slider's live drag value - `GcodeEditor.vue` (the wiring layer) supplies `currentLine`/`totalLines`/
 * `state` and applies `update:currentLine` back to its own source of truth (which also drives
 * `dwc-gcode-editor`'s `setCurrentLine` highlight - this component has no opinion on that, or on
 * anything involving the live `EditorView`).
 */
import type { MachineState } from "../model/gcode/state";

defineProps<{
	currentLine: number;
	totalLines: number;
	state: MachineState | null;
}>();
const emit = defineEmits<{ "update:currentLine": [number] }>();
</script>
