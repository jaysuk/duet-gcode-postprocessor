/**
 * Rewrites existing `M73 P<percent> R<minutes>` markers using this machine's own motion limits
 * instead of the slicer's assumed ones — the same move-time model built for the inspector's estimate
 * (see `gcode/timeModel.ts`), applied while the file is being written.
 *
 * `P` needs the file's total estimated time before its very first marker can be given a percentage,
 * which a single forward pass cannot know about itself. The transfer layer runs a small pre-pass
 * ahead of the main one whenever a recipe enables this step (see `estimateRewriteTimeTotals` in
 * `io/transfer.ts`) and hands the result in through {@link StepFactoryContext} rather than through
 * step config — a machine-derived, per-run number is not something a user configures.
 *
 * Never inserts a marker where none existed — see the module's own task notes for why that is out of
 * scope. A file with no `M73` markers is passed through unchanged, with a warning.
 */

import { formatNumber, setParam, withBody } from "../gcode/tokenise";
import { TimeEstimator } from "../gcode/timeModel";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

export const rewriteTimeStep: StepDefinition<Record<string, never>> = {
	id: "rewriteTime",
	label: "Rewrite M73 print time",
	description: "Recomputes existing M73 progress/remaining-time markers from this machine's own motion limits.",
	icon: "mdi-progress-clock",
	fields: [],

	create(_config: Record<string, never>, ctx: StepFactoryContext): Transform {
		const limits = ctx.machineLimits;
		const totalSeconds = ctx.totalEstimatedSeconds ?? null;
		const totalMarkers = ctx.totalMarkerCount ?? 0;
		const estimator = limits !== undefined ? new TimeEstimator(limits) : null;
		const usable = estimator !== null && totalSeconds !== null && totalSeconds > 0 && totalMarkers > 0;

		let seen = 0;
		let sawMarker = false;

		return {
			id: "rewriteTime",

			onLine(lineCtx: LineContext, line: string): string | undefined {
				estimator?.line(lineCtx.token, lineCtx);

				const token = lineCtx.token;
				if (token.letter !== "M" || token.code !== "M73") return undefined;
				sawMarker = true;
				if (!usable) return undefined;

				seen++;
				const last = seen >= totalMarkers;
				const elapsed = (estimator as TimeEstimator).elapsed;
				const percent = last ? 100 : Math.min(100, Math.round((elapsed / (totalSeconds as number)) * 100));
				const minutesLeft = last ? 0 : Math.max(0, Math.round(((totalSeconds as number) - elapsed) / 60));

				let body = setParam(token.body, "P", formatNumber(percent, 0));
				body = setParam(body, "R", formatNumber(minutesLeft, 0));
				return withBody(token, body);
			},

			onEnd(runCtx: RunContext): void {
				if (!sawMarker) {
					runCtx.warn("No M73 markers found in the file — rewriteTime does not insert new ones.");
				} else if (!usable) {
					runCtx.warn("Could not recompute M73 markers: this machine's motion limits were not available.");
				}
			},
		};
	},
};
