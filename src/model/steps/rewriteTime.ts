/**
 * Rewrites existing `M73 P<percent> R<minutes>` markers using this machine's own motion limits
 * instead of the slicer's assumed ones — the same move-time model built for the inspector's estimate
 * (see `gcode/timeModel.ts`), applied while the file is being written.
 *
 * `P` needs the file's total estimated time before its very first marker can be given a percentage,
 * which a single forward pass cannot know about itself. `RewriteTimeCollector` (below) runs ahead of
 * the transform pass as this step's `analysis()` collector (see `analysisPass.ts`); the transform
 * itself reads the result back out of `RunContext.analysis` in `onStart`.
 *
 * Never inserts a marker where none existed — see the module's own task notes for why that is out of
 * scope. A file with no `M73` markers is passed through unchanged, with a warning.
 */

import { formatNumber, setParam, withBody } from "../gcode/tokenise";
import { TimeEstimator, type MachineLimits } from "../gcode/timeModel";
import type { AnalysisCollector } from "../analysisPass";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

export interface RewriteTimeTotals {
	totalSeconds: number;
	markerCount: number;
}

const COLLECTOR_ID = "rewriteTime";

/**
 * Namespace the collector id by this step's position in the recipe, so two `rewriteTime` steps in
 * one recipe don't collide on the same key in the merged analysis results map (see
 * `docs/tasks/07-audit-defects.md`, defect A). Falls back to the bare id when `stepIndex` is not set
 * — a direct unit-test call that passes one shared context to both `analysis()` and `create()` still
 * computes the same key both times.
 */
function collectorId(ctx: StepFactoryContext): string {
	return ctx.stepIndex !== undefined ? `${COLLECTOR_ID}#${ctx.stepIndex}` : COLLECTOR_ID;
}

class RewriteTimeCollector implements AnalysisCollector<RewriteTimeTotals> {
	private readonly estimator: TimeEstimator;
	private markerCount = 0;

	constructor(readonly id: string, limits: MachineLimits) {
		this.estimator = new TimeEstimator(limits);
	}

	onLine(ctx: LineContext): void {
		this.estimator.line(ctx.token, ctx);
		if (ctx.token.letter === "M" && ctx.token.code === "M73") this.markerCount++;
	}

	result(): RewriteTimeTotals {
		return { totalSeconds: this.estimator.elapsed, markerCount: this.markerCount };
	}
}

export const rewriteTimeStep: StepDefinition<Record<string, never>> = {
	id: "rewriteTime",
	label: "Rewrite M73 print time",
	description: "Recomputes existing M73 progress/remaining-time markers from this machine's own motion limits.",
	icon: "mdi-progress-clock",
	fields: [],

	analysis(_config: Record<string, never>, ctx: StepFactoryContext): Array<AnalysisCollector> {
		if (ctx.machineLimits === undefined) return [];
		return [new RewriteTimeCollector(collectorId(ctx), ctx.machineLimits)];
	},

	create(_config: Record<string, never>, ctx: StepFactoryContext): Transform {
		const limits = ctx.machineLimits;
		const estimator = limits !== undefined ? new TimeEstimator(limits) : null;
		const resultKey = collectorId(ctx);

		let totals: RewriteTimeTotals | null = null;
		let seen = 0;
		let sawMarker = false;

		return {
			id: "rewriteTime",

			onStart(runCtx: RunContext): void {
				totals = (runCtx.analysis.get(resultKey) as RewriteTimeTotals | undefined) ?? null;
			},

			onLine(lineCtx: LineContext): string | undefined {
				estimator?.line(lineCtx.token, lineCtx);

				const token = lineCtx.token;
				if (token.letter !== "M" || token.code !== "M73") return undefined;
				sawMarker = true;

				const usable = estimator !== null && totals !== null && totals.totalSeconds > 0 && totals.markerCount > 0;
				if (!usable) return undefined;
				const known = totals as RewriteTimeTotals;

				seen++;
				const last = seen >= known.markerCount;
				const elapsed = (estimator as TimeEstimator).elapsed;
				const percent = last ? 100 : Math.min(100, Math.round((elapsed / known.totalSeconds) * 100));
				const minutesLeft = last ? 0 : Math.max(0, Math.round((known.totalSeconds - elapsed) / 60));

				let body = setParam(token.body, "P", formatNumber(percent, 0));
				body = setParam(body, "R", formatNumber(minutesLeft, 0));
				return withBody(token, body);
			},

			onEnd(runCtx: RunContext): void {
				if (!sawMarker) {
					runCtx.warn("No M73 markers found in the file — rewriteTime does not insert new ones.");
				} else if (totals === null || totals.totalSeconds <= 0 || totals.markerCount <= 0) {
					runCtx.warn("Could not recompute M73 markers: this machine's motion limits were not available.");
				}
			},
		};
	},
};
