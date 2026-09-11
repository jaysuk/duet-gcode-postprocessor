/**
 * The run report: everything a run's `ProcessResult` and its `Recipe` already know, assembled into
 * one downloadable Markdown document — F2. Pure and dependency-free beyond `ProcessResult`/`Recipe`
 * themselves: string in, string out, no I/O, so it is exactly as testable as everything else in
 * `model/`.
 *
 * `stats.warnings` already carries the skipped-by-condition lines (`io/transfer.ts` pushes them
 * there right after building the pipeline), so "which steps were skipped and why" comes out of the
 * warnings section for free.
 */

import type { DiffEntry, RunStats } from "./pipeline";
import { effectiveSteps, recipeHash, type Recipe } from "./recipe";
import { getStepDefinition } from "./steps/registry";
import { formatBytes } from "./io/plan";
import type { ProcessResult } from "./io/transfer";

/**
 * Label for the step at `index` among `recipe`'s effective steps, matching how `DiffPreview.vue`
 * has always labelled the per-step counts: the step's own note in parentheses when it has one, and
 * a bare "Step N" fallback for a step whose type is no longer in the registry (an import from a
 * newer version of the plugin, or a step type since removed).
 */
export function stepLabel(recipe: Recipe, index: number): string {
	const steps = effectiveSteps(recipe);
	const step = steps[index];
	if (step === undefined) return `Step ${index + 1}`;
	const definitionLabel = getStepDefinition(step.type)?.label ?? step.type;
	return step.note !== undefined && step.note !== "" ? `${definitionLabel} (${step.note})` : definitionLabel;
}

/** Uses the shared `formatBytes` rather than a local copy, so the figure in a downloaded report is
 *  formatted identically to the one `DiffPreview` shows on screen for the same run. */
function formatSizeChange(stats: RunStats): string {
	const delta = stats.bytesOut - stats.bytesIn;
	if (delta === 0) return "none";
	return `${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))}`;
}

export interface RunReportInput {
	result: ProcessResult;
	recipe: Recipe;
	sourcePath: string;
}

/** Build the report as Markdown. `diffLimit` caps how many diff entries are rendered (default: all
 *  of `result.diff`, which is already capped by the pipeline's own `maxDiffEntries`). */
export function buildRunReport({ result, recipe, sourcePath }: RunReportInput, diffLimit = Infinity): string {
	const lines: Array<string> = [];
	const stats = result.stats;

	lines.push(`# Run report: ${recipe.name}`, "");
	lines.push(`- File: \`${sourcePath}\``);
	lines.push(`- ${result.dryRun ? "Dry run (preview only, nothing written)" : `Applied — wrote \`${result.targetPath}\``}`);
	if (!result.dryRun && result.backupPath !== null) lines.push(`- Backup: \`${result.backupPath}\``);
	lines.push(`- Recipe hash: \`${recipeHash(recipe)}\``);
	lines.push("");

	lines.push("## Totals", "");
	lines.push(`- Lines changed: ${stats.linesChanged.toLocaleString()}`);
	lines.push(`- Lines added: ${stats.linesAdded.toLocaleString()}`);
	lines.push(`- Lines removed: ${stats.linesRemoved.toLocaleString()}`);
	lines.push(`- Size change: ${formatSizeChange(stats)}`);
	lines.push("");

	lines.push("## Per-step changes", "");
	if (stats.perStep.length === 0) {
		lines.push("(no steps ran)");
	} else {
		for (let i = 0; i < stats.perStep.length; i++) {
			const count = stats.perStep[i];
			lines.push(`- ${stepLabel(recipe, i)}: ${count.toLocaleString()} line${count === 1 ? "" : "s"}`);
		}
	}
	lines.push("");

	lines.push("## Warnings", "");
	if (stats.warnings.length === 0) {
		lines.push("(none)");
	} else {
		for (const warning of stats.warnings) lines.push(`- ${warning}`);
	}
	lines.push("");

	lines.push("## Timings", "");
	lines.push(`- Total: ${(result.durationMs / 1000).toFixed(1)} s`);
	if (result.analysisMs !== null) {
		lines.push(`- Analysing: ${(result.analysisMs / 1000).toFixed(1)} s`);
		lines.push(`- Applying the recipe: ${(result.transformMs / 1000).toFixed(1)} s`);
	}
	lines.push("");

	lines.push("## Changes", "");
	if (result.diff.length === 0) {
		lines.push("(no changes)");
	} else {
		const shown = result.diff.slice(0, diffLimit);
		for (const entry of shown) lines.push(...diffEntryLines(entry));
		if (stats.diffTruncated || shown.length < result.diff.length) {
			lines.push("", "_The list was capped; the run made more changes than are shown here._");
		}
	}

	return lines.join("\n");
}

function diffEntryLines(entry: DiffEntry): Array<string> {
	const lines: Array<string> = [];
	if (entry.before !== null) lines.push(`${entry.lineNo}\t- ${entry.before}`);
	for (const line of entry.after ?? []) lines.push(`${entry.lineNo}\t+ ${line}`);
	return lines;
}
