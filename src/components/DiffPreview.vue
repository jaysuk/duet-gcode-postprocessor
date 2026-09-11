<style scoped>
.diff {
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
	font-size: 0.8125rem;
	line-height: 1.5;
	overflow-x: auto;
}

.diff-row {
	display: flex;
	gap: 0.75rem;
	white-space: pre;
}

.diff-line-no {
	min-width: 4.5rem;
	text-align: right;
	opacity: 0.5;
	user-select: none;
}

@media (max-width: 600px) {
	.diff-row {
		gap: 0.375rem;
	}

	.diff-line-no {
		min-width: 2.25rem;
	}
}

.removed {
	background: rgba(var(--v-theme-error), 0.12);
}

.added {
	background: rgba(var(--v-theme-success), 0.12);
}

.hunk-gap {
	opacity: 0.4;
	padding: 0.25rem 0;
}
</style>

<template>
	<div class="pa-3">
		<div v-if="stats === null" class="text-medium-emphasis">
			Run a preview to see what a recipe would change. Nothing is written until you apply it.
		</div>

		<template v-else>
			<v-row dense class="mb-2">
				<v-col v-for="stat in summary" :key="stat.label" cols="6" sm="3">
					<div class="text-caption" style="opacity: 0.7">{{ stat.label }}</div>
					<div class="text-h6">{{ stat.value }}</div>
				</v-col>
			</v-row>

			<v-alert v-if="stats.warnings.length > 0" type="warning" variant="tonal" density="compact" class="mb-3">
				<div v-for="(warning, index) in stats.warnings" :key="index">{{ warning }}</div>
			</v-alert>

			<v-alert v-if="perStep.length > 0" type="info" variant="tonal" density="compact" class="mb-3">
				<div v-for="row in perStep" :key="row.label">
					<strong>{{ row.label }}</strong> touched {{ row.count.toLocaleString() }}
					{{ row.count === 1 ? "line" : "lines" }}
				</div>
			</v-alert>

			<!-- The report download sits outside the "did anything change" branch on purpose: a run
				 that changed nothing is exactly when the report is most useful, because it carries the
				 per-step zero counts and the skipped-by-condition reasons that explain why. -->
			<div class="d-flex align-center mb-2">
				<span class="text-caption text-medium-emphasis">
					<template v-if="diff.length === 0">No changes</template>
					<template v-else>
						Showing {{ diff.length.toLocaleString() }}
						{{ diff.length === 1 ? "change" : "changes" }}<template v-if="stats.diffTruncated">
							(capped — the run made more)</template>
					</template>
				</span>
				<v-spacer />
				<v-btn size="small" variant="text" prepend-icon="mdi-download" @click="downloadReport">
					Download the run report
				</v-btn>
			</div>

			<v-alert v-if="diff.length === 0" type="warning" variant="tonal" density="compact">
				This recipe changes nothing in this file. Check the patterns and the layer ranges — the
				run report lists what each step matched and any step a condition skipped.
			</v-alert>

			<template v-else>
				<v-card variant="tonal" class="pa-2 diff">
					<template v-for="(entry, index) in visible" :key="entry.lineNo">
						<div v-if="index > 0 && entry.lineNo > visible[index - 1].lineNo + 1" class="hunk-gap">
							…
						</div>
						<div v-if="entry.before !== null" class="diff-row removed">
							<span class="diff-line-no">{{ entry.lineNo }}</span>
							<span>- {{ entry.before }}</span>
						</div>
						<div v-for="(line, i) in entry.after ?? []" :key="i" class="diff-row added">
							<span class="diff-line-no" />
							<span>+ {{ line }}</span>
						</div>
					</template>
				</v-card>

				<v-btn v-if="visible.length < diff.length" class="mt-2" variant="text" block
					   @click="shown += PAGE">
					Show more ({{ (diff.length - visible.length).toLocaleString() }} remaining)
				</v-btn>
			</template>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { downloadBlob } from "dwc-plugin-runtime/download";

import { formatBytes } from "../model/io/plan";
import type { ProcessResult } from "../model/io/transfer";
import type { RunStats } from "../model/pipeline";
import { buildRunReport, stepLabel } from "../model/runReport";
import { type Recipe } from "../model/recipe";

const props = defineProps<{
	result: ProcessResult | null;
	recipe: Recipe | null;
	sourceName: string;
}>();

const stats = computed(() => props.result?.stats ?? null);
const diff = computed(() => props.result?.diff ?? []);

const PAGE = 200;
const shown = ref(PAGE);

watch(diff, () => { shown.value = PAGE; });

const visible = computed(() => diff.value.slice(0, shown.value));

const summary = computed(() => {
	const s = stats.value;
	if (s === null) return [];
	return [
		{ label: "Lines changed", value: s.linesChanged.toLocaleString() },
		{ label: "Lines added", value: s.linesAdded.toLocaleString() },
		{ label: "Lines removed", value: s.linesRemoved.toLocaleString() },
		{ label: "Size change", value: describeSizeChange(s) },
	];
});

function describeSizeChange(s: RunStats): string {
	const delta = s.bytesOut - s.bytesIn;
	if (delta === 0) return "none";
	return `${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))}`;
}

const perStep = computed(() => {
	if (stats.value === null || props.recipe === null) return [];
	const recipe = props.recipe;
	return stats.value.perStep.map((count, index) => ({ label: stepLabel(recipe, index), count }));
});

function downloadReport(): void {
	if (props.result === null || props.recipe === null) return;
	const report = buildRunReport({ result: props.result, recipe: props.recipe, sourcePath: props.sourceName });
	downloadBlob("gcode-postprocessor-run-report.md", report, "text/markdown");
}
</script>
