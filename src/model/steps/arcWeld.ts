/**
 * Arc welding: collapses runs of `G0`/`G1` moves that trace a circle back into a single `G2`/`G3`,
 * the way a slicer's own polyline approximation of a curve could have been expressed in the first
 * place. The geometry lives in `gcode/arcFit.ts`, pure and independently tested; this module owns
 * the G-code-specific bookkeeping arcFit deliberately knows nothing about — buffering points,
 * deciding when a run must break, and reconstructing the emitted command.
 *
 * **The pipeline contract needs care here.** `Transform.onLine` returns one line's replacement and
 * cannot retroactively edit lines already emitted — so welding *withholds* lines while a candidate
 * run is being buffered (`onLine` returns `null`/`undefined` for each one taken into the buffer) and
 * only emits once the run closes: either `[arcCommand]` or, when the run never became weldable, the
 * buffered lines verbatim — both followed by whatever line forced the close, unless that line was
 * itself absorbed into a freshly-restarted run (see `extendOrRestart`). `onEnd` flushes whatever is
 * still buffered when the file ends, or the last run in the file is silently dropped.
 *
 * **Ordering matters.** This step changes line counts and coordinates, so it should run *last* in a
 * recipe: a `findReplace` targeting `G1` will not match a welded arc, and a step that inserts lines
 * (`preheat`) needs to run before this one sees the file, not after.
 *
 * **`F` is carried onto the arc, not treated as a break.** RRF applies one feedrate to the whole
 * `G2`/`G3` move regardless of the original per-segment feedrates, so a feedrate change mid-run does
 * not end it — the arc is emitted with whichever `F` was last in effect when the run closed.
 *
 * See `gcode/arcFit.ts`'s own module comment for the firmware contract this relies on
 * (`DoArcMove`'s parameter handling and RRF's own radius-tolerance check) and the attribution for the
 * algorithm, reimplemented clean-room from FormerLurker's ArcWelderLib.
 */

import { arcRadiusWithinTolerance, tryFitArc, type FitPoint, type FittedArc } from "../gcode/arcFit";
import { formatNumber, paramNumber, parseParams } from "../gcode/tokenise";
import type { LineContext, RunContext, StepDefinition, Transform } from "./types";

export interface ArcWeldConfig {
	resolutionMm: number;
	pathTolerancePercent: number;
	maxRadiusMm: number;
	minSegments: number;
	allow3dArcs: boolean;
	extrusionRateVariancePercent: number;
}

type ExtrusionCharacter = "extrude" | "retract" | "travel";

function classify(deltaE: number): ExtrusionCharacter {
	if (deltaE > 0) return "extrude";
	if (deltaE < 0) return "retract";
	return "travel";
}

interface BufferedPoint {
	x: number;
	y: number;
	z: number;
	/** Absolute running E value at this point (tracked regardless of M82/M83 — the mode only decides
	 *  what gets *emitted*, never how position is tracked, exactly like `x`/`y`). */
	e: number;
	/** The line that produced this point. Absent for the anchor: a run's first entry is a position,
	 *  not a line waiting to be emitted. */
	line?: string;
	feedrate: number | null;
}

/** Read one axis's new absolute position from a line's parameters, mirroring `timeModel.ts`'s own
 *  `TimeEstimator` — `null` when the axis was not mentioned on this line at all. */
function applyAxis(
	params: ReturnType<typeof parseParams>, letter: string, current: number, relative: boolean,
): number | null {
	const value = paramNumber(params, letter);
	if (value === null) return null;
	return relative ? current + value : value;
}

const DECIMALS_TO_TRY = [3, 4, 5, 6];

/**
 * Build the `G2`/`G3` command for a closed run, escalating decimal precision until RRF's own radius
 * check (recomputed from the *rounded* numbers) passes — rounding coordinates can push a fit that
 * was valid on the raw numbers outside RRF's 0.05mm tolerance. Returns `null` on the rare case that
 * no precision up to 6 decimals satisfies it, in which case the run is not welded at all.
 */
function buildArcCommand(
	start: BufferedPoint,
	end: BufferedPoint,
	fit: FittedArc,
	feedrate: number | null,
	deltaE: number,
	relativeE: boolean,
	allow3dArcs: boolean,
): string | null {
	for (const decimals of DECIMALS_TO_TRY) {
		const sx = Number(formatNumber(start.x, decimals));
		const sy = Number(formatNumber(start.y, decimals));
		const ex = Number(formatNumber(end.x, decimals));
		const ey = Number(formatNumber(end.y, decimals));
		const i = Number(formatNumber(fit.centreX - start.x, decimals));
		const j = Number(formatNumber(fit.centreY - start.y, decimals));
		if (!arcRadiusWithinTolerance(sx, sy, ex, ey, i, j)) continue;

		const parts = [
			fit.clockwise ? "G2" : "G3",
			`X${formatNumber(ex, decimals)}`,
			`Y${formatNumber(ey, decimals)}`,
		];
		if (allow3dArcs && end.z !== start.z) parts.push(`Z${formatNumber(end.z, decimals)}`);
		parts.push(`I${formatNumber(i, decimals)}`, `J${formatNumber(j, decimals)}`);
		if (feedrate !== null) parts.push(`F${formatNumber(feedrate, 0)}`);
		if (deltaE !== 0) {
			const eValue = relativeE ? deltaE : end.e;
			parts.push(`E${formatNumber(eValue, 5)}`);
		}
		return parts.join(" ");
	}
	return null;
}

export const arcWeldStep: StepDefinition<ArcWeldConfig> = {
	id: "arcWeld",
	label: "Weld G1 runs into arcs",
	description: "Collapses runs of straight moves that trace a circle back into a single G2/G3.",
	tip: "Reverses what most slicers do to every curve: approximate it as a run of short straight "
		+ "segments, because that is all classic G-code has. RepRapFirmware executes G2/G3 natively "
		+ "(verified against its own source, not assumed), so a genuine curve as one arc command "
		+ "means fewer, smaller lines and smoother motion through it than a jerk-limited polyline of "
		+ "the same shape — an arc-welded file is typically the same length or faster to print, never "
		+ "slower, for a correctly-fitted arc. Run it last in a recipe: it changes line counts and "
		+ "coordinates outright, so an earlier find/replace or insertion sees the file as the slicer "
		+ "wrote it, not as this step rewrote it. Filament use is exactly conserved — the arc carries "
		+ "the same total extrusion as the run it replaces, whichever E mode (M82/M83) the file uses. "
		+ "After applying, it is worth a quick \"Simulate on this machine\" and comparing the result "
		+ "against the un-welded file's own simulated time before trusting either number blindly.",
	docsAnchor: "weld-curves-into-arcs",
	icon: "mdi-vector-curve",
	fields: [
		{
			key: "resolutionMm", label: "Resolution", type: "number", default: 0.05, min: 0.001, max: 5, step: 0.01,
			help: "How far the fitted arc is allowed to stray from the original points, in mm — "
				+ "tighter catches fewer, more genuinely circular runs; looser welds more aggressively "
				+ "but risks a visibly-off curve on a run that was only approximately circular. "
				+ "Default: 0.05, well under a typical 0.4mm nozzle's own line width.",
		},
		{
			key: "pathTolerancePercent", label: "Path tolerance", type: "number", default: 5, min: 0.1, max: 50, step: 0.5,
			help: "How much the fitted arc's own length may differ from the original polyline's, as a "
				+ "percent — a second, independent check alongside 'Resolution': a fit can hug every "
				+ "point closely yet still trace a meaningfully longer or shorter path (e.g. a "
				+ "near-collinear run fit to a huge, gently-curving arc). Default: 5.",
		},
		{
			key: "maxRadiusMm", label: "Maximum radius", type: "number", default: 9999, min: 1, max: 1000000,
			help: "Reject a fit larger than this — catches a near-straight run of points from being "
				+ "fit to a technically-valid but enormous circle, which 'Path tolerance' alone would "
				+ "not always catch. Default: 9999 (effectively no limit) — lower it only if a "
				+ "specific file is welding runs you can see should have stayed straight.",
		},
		{
			key: "minSegments", label: "Minimum segments", type: "number", default: 3, min: 3, max: 100,
			help: "Fewest source moves worth replacing with one arc — three is the geometric minimum "
				+ "(an arc needs three points to fit at all). Raising this skips welding very short "
				+ "runs, where one G2/G3 saves little over the handful of G1 lines it would replace. Default: 3.",
		},
		{
			key: "allow3dArcs", label: "Allow 3D arcs (vase mode)", type: "boolean", default: false,
			help: "Let Z change across an arc, for a helical (vase-mode) print with no layer changes "
				+ "to break a run at. Off by default because most prints have layer boundaries "
				+ "already ending each run naturally, and a 3D arc is a less common firmware path "
				+ "worth opting into deliberately rather than by default.",
		},
		{
			key: "extrusionRateVariancePercent", label: "Extrusion rate variance", type: "number", default: 5, min: 0, max: 100, step: 0.5,
			help: "Abort a run if mm of filament per mm of travel varies more than this percent from "
				+ "how the run started — protects against welding across a real flow change (a "
				+ "seam, a rate-varying feature) into one arc that would then extrude at a single, "
				+ "wrong average rate for its whole length. Default: 5.",
		},
	],

	create(config: ArcWeldConfig): Transform {
		let x = 0;
		let y = 0;
		let z = 0;
		let e = 0;

		// Empty until the first candidate move of the file establishes an anchor.
		let buffer: Array<BufferedPoint> = [];
		let lastGoodFit: FittedArc | null = null;
		let runCharacter: ExtrusionCharacter | null = null;
		let runFeedrate: number | null = null;
		/** The E-axis mode in effect when the run started. A run can never span an M82/M83 change —
		 *  either line closes whatever was buffered before it takes effect (see the `!isXYMove`
		 *  branch below) — so one flag per run is enough; it just has to be threaded to `closeRun`,
		 *  which has no `LineContext` of its own to read it from. */
		let runRelativeE = false;
		/** The first extruding segment's mm-of-filament-per-mm-of-travel in the current run — the
		 *  reference every later segment's own rate is compared against. `null` when the run has not
		 *  extruded yet (a travel-only or retraction-only run has nothing to check a rate against). */
		let referenceRate: number | null = null;

		let arcsEmitted = 0;
		let sourceMovesWelded = 0;
		let rejectedForRadiusCheck = 0;

		/** Start a brand new run: `anchor` is the position *before* `point`'s own move. */
		function establishRun(anchor: BufferedPoint, point: BufferedPoint, distance: number, relativeE: boolean): void {
			buffer = [anchor, point];
			const deltaE = point.e - anchor.e;
			runCharacter = classify(deltaE);
			runFeedrate = point.feedrate;
			runRelativeE = relativeE;
			referenceRate = runCharacter === "extrude" && distance > 0 ? Math.abs(deltaE) / distance : null;
			lastGoodFit = null;
		}

		/** Close whatever is currently buffered: the fitted arc if one exists, otherwise every
		 *  buffered point's own original line, verbatim, in order. Resets the buffer to empty. */
		function closeRun(): Array<string> {
			let out: Array<string> = [];
			if (buffer.length >= 2) {
				if (lastGoodFit !== null) {
					const start = buffer[0];
					const end = buffer[buffer.length - 1];
					const deltaE = end.e - start.e;
					const command = buildArcCommand(start, end, lastGoodFit, runFeedrate, deltaE, runRelativeE, config.allow3dArcs);
					if (command !== null) {
						out = [command];
						arcsEmitted++;
						sourceMovesWelded += buffer.length - 1;
					} else {
						rejectedForRadiusCheck++;
						out = buffer.slice(1).map((p) => p.line as string);
					}
				} else {
					out = buffer.slice(1).map((p) => p.line as string);
				}
			}
			buffer = [];
			lastGoodFit = null;
			runCharacter = null;
			runFeedrate = null;
			runRelativeE = false;
			referenceRate = null;
			return out;
		}

		/**
		 * Try to add `point` (a real, XY-moving candidate whose position is already reflected in the
		 * running `x`/`y`/`z`/`e`) to the run. `anchorBefore` is the position immediately before
		 * `point`'s own move — needed here, not read from the outer position variables, because those
		 * already reflect `point` itself by the time this runs.
		 *
		 * Closes and re-emits the current run first if `point` cannot extend it, whether because it
		 * broke the geometric fit or one of the non-geometric compatibility rules. `point` is always
		 * either absorbed into the (possibly fresh) buffer or is not a candidate at all, so it is
		 * never itself part of the returned lines — restarting a run *at* the point that broke the
		 * previous one is what "restart the buffer from the last emitted endpoint" means in practice.
		 */
		function extendOrRestart(
			anchorBefore: BufferedPoint, point: BufferedPoint, compatible: boolean, distance: number, relativeE: boolean,
		): Array<string> {
			if (buffer.length === 0) {
				establishRun(anchorBefore, point, distance, relativeE);
				return [];
			}

			if (compatible) {
				const tentative = [...buffer, point];
				if (tentative.length - 1 < config.minSegments) {
					buffer = tentative;
					if (point.feedrate !== null) runFeedrate = point.feedrate;
					return [];
				}
				const fit = tryFitArc(tentative.map((p): FitPoint => ({ x: p.x, y: p.y })), config);
				if (fit !== null) {
					buffer = tentative;
					lastGoodFit = fit;
					if (point.feedrate !== null) runFeedrate = point.feedrate;
					return [];
				}
			}

			const emitted = closeRun();
			establishRun(anchorBefore, point, distance, relativeE);
			return emitted;
		}

		return {
			id: "arcWeld",

			onLine(lineCtx: LineContext, line: string): string | Array<string> | null | undefined {
				const token = lineCtx.token;
				const params = parseParams(token.body);

				const prevX = x;
				const prevY = y;
				const prevZ = z;
				const prevE = e;
				const nextX = applyAxis(params, "X", x, lineCtx.relativeMoves);
				const nextY = applyAxis(params, "Y", y, lineCtx.relativeMoves);
				const nextE = applyAxis(params, "E", e, lineCtx.relativeE);
				if (nextX !== null) x = nextX;
				if (nextY !== null) y = nextY;
				if (nextE !== null) e = nextE;
				z = lineCtx.z ?? z;

				const isG0G1 = token.letter === "G" && (token.code === "G0" || token.code === "G1");
				const dx = nextX !== null ? x - prevX : 0;
				const dy = nextY !== null ? y - prevY : 0;
				const isXYMove = isG0G1 && (dx !== 0 || dy !== 0);

				if (!isXYMove) {
					const emitted = closeRun();
					if (emitted.length === 0) return undefined;
					return [...emitted, line];
				}

				const distance = Math.hypot(dx, dy);
				const deltaE = e - prevE;
				const character = classify(deltaE);

				let compatible = true;
				if (buffer.length > 0) {
					if (lineCtx.layerChanged) compatible = false;
					else if (!config.allow3dArcs && z !== buffer[0].z) compatible = false;
					else if (runCharacter !== null && character !== runCharacter) compatible = false;
					else if (runCharacter === "extrude" && referenceRate !== null && distance > 0) {
						const rate = Math.abs(deltaE) / distance;
						const percentDiff = (Math.abs(rate - referenceRate) / referenceRate) * 100;
						if (percentDiff > config.extrusionRateVariancePercent) compatible = false;
					}
				}

				const anchorBefore: BufferedPoint = { x: prevX, y: prevY, z: prevZ, e: prevE, feedrate: null };
				const point: BufferedPoint = { x, y, z, e, line, feedrate: lineCtx.feedrate };
				const emitted = extendOrRestart(anchorBefore, point, compatible, distance, lineCtx.relativeE);

				// A candidate move is always absorbed into the (possibly fresh) buffer here, never
				// passed through as itself — `undefined` would wrongly keep it as well as whatever
				// got flushed, so an empty flush must drop it (`null`), not leave it (`undefined`)
				return emitted.length === 0 ? null : emitted;
			},

			onEnd(runCtx: RunContext): Array<string> | void {
				const emitted = closeRun();
				if (arcsEmitted > 0) {
					runCtx.warn(
						`Welded ${sourceMovesWelded} moves into ${arcsEmitted} arc${arcsEmitted === 1 ? "" : "s"}.`,
					);
				}
				if (rejectedForRadiusCheck > 0) {
					runCtx.warn(
						`${rejectedForRadiusCheck} candidate run${rejectedForRadiusCheck === 1 ? "" : "s"} fit an arc `
						+ "but no rounding of the coordinates satisfied the firmware's own radius check, so "
						+ (rejectedForRadiusCheck === 1 ? "it was" : "they were") + " left unwelded.",
					);
				}
				return emitted.length === 0 ? undefined : emitted;
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (config.minSegments < 3) errors.push("Minimum segments must be at least 3 — an arc needs three points to fit");
		return errors;
	},
};
