/**
 * Rewrites a `G0`/`G1` feedrate down to this machine's own limit when the file asks for more than
 * it can actually do — the same problem `gcode/timeModel.ts` estimates around, applied while the
 * file is being written instead of only reported after the fact.
 *
 * **Per-axis-combination, not global.** An X-only move is checked against X's own limit, not the
 * tighter of X and Y — reuses `timeModel.ts`'s own `axisLetters`/`combinedAxisLimits` rather than a
 * second copy that could drift from the estimate the inspector already shows. A Z-only move (a lift)
 * or an E-only move (a retraction or wipe) is checked against that axis's own limit in the same way
 * — `TimeEstimator`'s clamped-move count already includes these (task 10 finding D), so this step
 * must actually clamp them or the inspector's "adding this step removes the difference" claim is
 * false for any file with fast Z or E moves.
 *
 * **`G92` is tracked, not skipped** (task 10 finding C). It sets a position absolutely regardless of
 * `G90`/`G91`, and an absolute-extrusion file (Cura's default) emits `G92 E0` constantly — missing it
 * makes every extrusion delta after the first one wrong, silently misclassifying real printing moves
 * as travel under "printing moves only". `G92` is never itself rewritten.
 *
 * **Byte-identical when nothing needs clamping.** A move whose F is already within limits is
 * returned as `undefined` (unchanged), not reformatted — a diff should only ever show what actually
 * moved.
 *
 * **Acceleration clamping is a separate, off-by-default concern.** `alsoClampAcceleration` rewrites
 * an `M204 P`/`T` down to this machine's own configured `printAccel`/`travelAccel` when the file
 * asks for more — the file's own stated acceleration exceeding what this machine is actually
 * configured for, the same "the slicer assumed a different machine" problem as the feedrate case.
 */

import { combinedAxisLimits } from "../gcode/timeModel";
import { formatNumber, paramNumber, parseParams, setParam, withBody } from "../gcode/tokenise";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

export type ApplyToMoves = "printing" | "travel" | "both";

export interface ClampFeedrateConfig {
	applyToMoves: ApplyToMoves;
	alsoClampAcceleration: boolean;
}

/** Mirrors `timeModel.ts`'s own `TimeEstimator.applyAxis` — this step needs its own running X/Y/E
 *  position (not exposed by `LineContext`), the same reason `arcWeld.ts` keeps its own copy. */
function applyAxis(
	params: ReturnType<typeof parseParams>, letter: string, current: number, relative: boolean,
): number | null {
	const value = paramNumber(params, letter);
	if (value === null) return null;
	return relative ? current + value : value;
}

export const clampFeedrateStep: StepDefinition<ClampFeedrateConfig> = {
	id: "clampFeedrate",
	label: "Clamp feedrate to machine limits",
	description: "Rewrites a commanded feedrate down to this machine's own speed limit for the axes involved.",
	icon: "mdi-speedometer-slow",
	fields: [
		{
			key: "applyToMoves", label: "Apply to", type: "select", default: "both",
			options: [
				{ value: "both", label: "Printing and travel moves" },
				{ value: "printing", label: "Printing moves only" },
				{ value: "travel", label: "Travel moves only" },
			],
			help: "A move is \"printing\" when it extrudes. Default: both.",
		},
		{
			key: "alsoClampAcceleration", label: "Also clamp M204 acceleration", type: "boolean", default: false,
			help: "Rewrite an M204 P/T down to this machine's own configured printing/travel acceleration when the file asks for more. Off by default.",
		},
	],

	create(config: ClampFeedrateConfig, ctx: StepFactoryContext): Transform {
		const limits = ctx.machineLimits;

		let x = 0;
		let y = 0;
		let z = 0;
		let e = 0;
		let clampedCount = 0;
		let secondsAdded = 0;
		let accelClamped = 0;

		return {
			id: "clampFeedrate",

			onLine(lineCtx: LineContext, line: string): string | undefined {
				const token = lineCtx.token;

				if (token.letter === "G" && token.code === "G92") {
					// Sets position absolutely, regardless of G90/G91 — must not go through applyAxis,
					// which would add to the current position under G91. Never rewritten.
					const params = parseParams(token.body);
					const gx = paramNumber(params, "X");
					const gy = paramNumber(params, "Y");
					const gz = paramNumber(params, "Z");
					const ge = paramNumber(params, "E");
					if (gx !== null) x = gx;
					if (gy !== null) y = gy;
					if (gz !== null) z = gz;
					if (ge !== null) e = ge;
					return undefined;
				}

				if (config.alsoClampAcceleration && limits !== undefined && token.letter === "M" && token.code === "M204") {
					const params = parseParams(token.body);
					const p = paramNumber(params, "P");
					const t = paramNumber(params, "T");
					let body = token.body;
					let changed = false;
					if (p !== null && limits.printAccel !== null && p > limits.printAccel) {
						body = setParam(body, "P", formatNumber(limits.printAccel, 0));
						changed = true;
					}
					if (t !== null && limits.travelAccel !== null && t > limits.travelAccel) {
						body = setParam(body, "T", formatNumber(limits.travelAccel, 0));
						changed = true;
					}
					if (changed) {
						accelClamped++;
						return withBody(token, body);
					}
					return undefined;
				}

				if (limits === undefined) return undefined;
				if (token.letter !== "G" || (token.code !== "G0" && token.code !== "G1")) return undefined;

				const params = parseParams(token.body);
				const relative = lineCtx.relativeMoves;
				const prevX = x;
				const prevY = y;
				const prevZ = z;
				const prevE = e;
				const nextX = applyAxis(params, "X", x, relative);
				const nextY = applyAxis(params, "Y", y, relative);
				const nextZ = applyAxis(params, "Z", z, relative);
				const nextE = applyAxis(params, "E", e, lineCtx.relativeE);
				if (nextX !== null) x = nextX;
				if (nextY !== null) y = nextY;
				if (nextZ !== null) z = nextZ;
				if (nextE !== null) e = nextE;

				const dx = nextX !== null ? x - prevX : 0;
				const dy = nextY !== null ? y - prevY : 0;
				const dz = nextZ !== null ? z - prevZ : 0;
				const deltaE = e - prevE;
				const isPrinting = deltaE > 0;
				if (config.applyToMoves === "printing" && !isPrinting) return undefined;
				if (config.applyToMoves === "travel" && isPrinting) return undefined;

				const f = paramNumber(params, "F");
				if (f === null) return undefined; // no commanded feedrate on this line to clamp
				const nominal = f / 60;

				// Same three mutually-exclusive cases as TimeEstimator.line: XY (per-axis-combination),
				// then Z-only, then E-only — a diagonal XY+Z move is timed (and here, clamped) on its XY
				// component only, matching the model this step is meant to make good on.
				let maxSpeed: number;
				let distance: number;
				if (dx !== 0 || dy !== 0) {
					const involved: Array<string> = [];
					if (nextX !== null) involved.push("X");
					if (nextY !== null) involved.push("Y");
					maxSpeed = combinedAxisLimits(limits, involved).maxSpeed;
					distance = Math.hypot(dx, dy);
				} else if (dz !== 0) {
					maxSpeed = limits.maxSpeed.Z ?? Infinity;
					distance = Math.abs(dz);
				} else if (deltaE !== 0) {
					maxSpeed = limits.maxSpeed.E ?? Infinity;
					distance = Math.abs(deltaE);
				} else {
					return undefined; // zero-length move: nothing to clamp
				}
				if (!Number.isFinite(maxSpeed) || nominal <= maxSpeed) return undefined;

				if (distance > 0) secondsAdded += distance / maxSpeed - distance / nominal;
				clampedCount++;
				const body = setParam(token.body, "F", formatNumber(maxSpeed * 60, 0));
				return withBody(token, body);
			},

			onEnd(runCtx: RunContext): void {
				if (limits === undefined) {
					runCtx.warn("This machine's motion limits were not available: no feedrate was clamped.");
					return;
				}
				if (clampedCount > 0) {
					runCtx.warn(
						`Clamped ${clampedCount} move${clampedCount === 1 ? "" : "s"} to this machine's speed `
						+ `limit, adding about ${Math.round(secondsAdded)}s to the estimated print time.`,
					);
				}
				if (accelClamped > 0) {
					runCtx.warn(`Clamped ${accelClamped} M204 command${accelClamped === 1 ? "" : "s"} to this machine's configured acceleration.`);
				}
			},
		};
	},
};
