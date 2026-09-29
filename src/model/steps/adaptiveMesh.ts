/**
 * Adaptive bed mesh: probe only the area the print actually occupies.
 *
 * A full-bed `G29` on a 300 mm bed spends most of its time probing where nothing will be printed.
 * This step reads the print's XY footprint from the file itself (an `analysisPass.ts` collector — the
 * bounds are only knowable after the whole file has been seen) and rewrites the `M557` grid
 * definition to cover just that, plus a margin. Density is either a spacing (`S`) or a number of
 * points per axis (`P`), the two forms RepRapFirmware's own `M557` accepts.
 *
 * Where the new `M557` goes: it replaces any existing grid-form `M557` in the file (keeping a
 * delta's `R` radius, which is orthogonal to the rectangle), or is inserted before the first
 * probing `G29` when the file has none. A file with neither is left alone by default — see
 * `ifNoAnchor`.
 */

import { formatNumber, paramNumber, parseParams } from "dwc-gcode-core";
import type { AnalysisCollector } from "../analysisPass";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

export interface AdaptiveMeshConfig {
	density: "spacing" | "points";
	spacingMm: number;
	points: number;
	marginMm: number;
	firstLayerOnly: boolean;
	ignorePrime: boolean;
	clampToBed: boolean;
	bedMinX: number;
	bedMaxX: number;
	bedMinY: number;
	bedMaxY: number;
	ifNoAnchor: "skip" | "top";
}

export interface Bounds {
	minX: number; maxX: number;
	minY: number; maxY: number;
}

export interface AdaptiveMeshFacts {
	/** Footprint under the configured filters, or null when nothing qualified. */
	bounds: Bounds | null;
	/** Footprint of every extruding move regardless of the filters — only used as a fallback (with a
	 *  warning) when the filters excluded everything, e.g. a file with no layer markers at all. */
	unfiltered: Bounds | null;
	/** True when the file has a grid-form `M557` or a probing `G29` for the new grid to attach to. */
	hasAnchor: boolean;
}

/** RRF's own grid capacity is 441 (21x21) on some boards and 961 (31x31) on others. */
const MIN_GRID_POINT_LIMIT = 441;

const COLLECTOR_ID = "adaptiveMesh";

function collectorId(ctx: StepFactoryContext): string {
	return ctx.stepIndex !== undefined ? `${COLLECTOR_ID}#${ctx.stepIndex}` : COLLECTOR_ID;
}

// #region Line classification

/**
 * True for the grid form of `M557` (`X0:200 Y0:200 S20`, `R150 S15`, `S20`, `P5`), false for the
 * deprecated G32 point form (`M557 P1 X30 Y40.5`), which has a single value per axis and no `S`/`R`.
 */
export function isGridM557(body: string): boolean {
	if (/(^|\s)[A-Za-z][^\s;]*:/.test(body)) return true; // any `X0:200` range, `S20:30` or `P5:5`
	const params = parseParams(body);
	return paramNumber(params, "S") !== null || paramNumber(params, "R") !== null;
}

/** A `G29` that probes: no `S`, or `S0`. `S1` loads a height map, `S2` disables compensation and
 *  `S3` saves one — none of those use the grid. */
export function isProbingG29(body: string): boolean {
	const s = paramNumber(parseParams(body), "S");
	return s === null || s === 0;
}

// #endregion

// #region Bounds

function emptyBounds(): Bounds {
	return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
}

function include(b: Bounds, x: number, y: number): void {
	if (x < b.minX) b.minX = x;
	if (x > b.maxX) b.maxX = x;
	if (y < b.minY) b.minY = y;
	if (y > b.maxY) b.maxY = y;
}

function finish(b: Bounds): Bounds | null {
	return Number.isFinite(b.minX) ? b : null;
}

/** Extend `b` by the axis-extreme points of an arc, which its endpoints alone can fall short of. */
function includeArc(b: Bounds, sx: number, sy: number, ex: number, ey: number, i: number, j: number, clockwise: boolean): void {
	const cx = sx + i;
	const cy = sy + j;
	const r = Math.hypot(sx - cx, sy - cy);
	if (r === 0) return;
	const TAU = Math.PI * 2;
	const mod = (a: number): number => ((a % TAU) + TAU) % TAU;
	const a0 = Math.atan2(sy - cy, sx - cx);
	const a1 = Math.atan2(ey - cy, ex - cx);
	// Angle travelled from start to end in the arc's own direction; a coincident start and end is a full circle
	let sweep = clockwise ? mod(a0 - a1) : mod(a1 - a0);
	if (sweep === 0) sweep = TAU;
	for (const q of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
		const d = clockwise ? mod(a0 - q) : mod(q - a0);
		if (d <= sweep) include(b, cx + r * Math.cos(q), cy + r * Math.sin(q));
	}
}

class MeshBoundsCollector implements AnalysisCollector<AdaptiveMeshFacts> {
	private readonly filtered = emptyBounds();
	private readonly all = emptyBounds();
	private hasAnchor = false;
	/** Absolute E tracked independently, same convention (and same G92 handling) as `analysis.ts`. */
	private e = 0;
	/** XY tracked here: `LineContext` types x/y but `syncLineContext` does not copy them, so they are
	 *  undefined at runtime (same reason `analysis.ts` keeps its own). */
	private x: number | null = null;
	private y: number | null = null;

	constructor(readonly id: string, private readonly config: AdaptiveMeshConfig) {}

	onLine(ctx: LineContext): void {
		const token = ctx.token;
		const startX = this.x;
		const startY = this.y;

		if (token.letter === "M" && token.code === "M557") {
			if (isGridM557(token.body)) this.hasAnchor = true;
			return;
		}
		if (token.letter !== "G") return;
		if (token.code === "G29") {
			if (isProbingG29(token.body)) this.hasAnchor = true;
			return;
		}
		if (token.code === "G28") {
			this.x = null;
			this.y = null;
			return;
		}
		if (token.code === "G92") {
			const p = parseParams(token.body);
			const e = paramNumber(p, "E");
			if (e !== null) this.e = e;
			const x = paramNumber(p, "X");
			const y = paramNumber(p, "Y");
			if (x !== null) this.x = x;
			if (y !== null) this.y = y;
			return;
		}
		const isArc = token.code === "G2" || token.code === "G3";
		if (token.code !== "G0" && token.code !== "G1" && !isArc) return;

		const params = parseParams(token.body);
		const px = paramNumber(params, "X");
		const py = paramNumber(params, "Y");
		if (px !== null) this.x = ctx.relativeMoves && startX !== null ? startX + px : px;
		if (py !== null) this.y = ctx.relativeMoves && startY !== null ? startY + py : py;
		const eParam = paramNumber(params, "E");
		let extruding = false;
		if (eParam !== null) {
			const deltaE = ctx.relativeE ? eParam : eParam - this.e;
			this.e = ctx.relativeE ? this.e + eParam : eParam;
			extruding = deltaE > 0;
		}
		if (!extruding || this.x === null || this.y === null) return;

		const endX = this.x;
		const endY = this.y;
		const addTo = (b: Bounds): void => {
			if (startX !== null && startY !== null) include(b, startX, startY);
			include(b, endX, endY);
			if (isArc && startX !== null && startY !== null) {
				const i = paramNumber(params, "I");
				const j = paramNumber(params, "J");
				if (i !== null || j !== null) includeArc(b, startX, startY, endX, endY, i ?? 0, j ?? 0, token.code === "G2");
			}
		};
		addTo(this.all);

		if (this.config.firstLayerOnly && ctx.layer > 0) return;
		if (this.config.ignorePrime) {
			if (ctx.layer < 0) return; // start-gcode purge and prime lines happen before the first layer marker
			if (ctx.featureType !== null && ctx.featureType.toLowerCase() === "custom") return; // slicer-tagged purge line
		}
		addTo(this.filtered);
	}

	result(): AdaptiveMeshFacts {
		return { bounds: finish(this.filtered), unfiltered: finish(this.all), hasAnchor: this.hasAnchor };
	}
}

// #endregion

// #region Grid

export interface MeshGrid {
	minX: number; maxX: number;
	minY: number; maxY: number;
}

/**
 * Turn print bounds into the probe rectangle: pad by the margin, clip to the probeable area, then
 * make sure each axis is wide enough that the firmware ends up with at least two points on it.
 * Returns null when the clipped area is empty (the print lies entirely outside the probeable area).
 */
export function computeGrid(bounds: Bounds, config: AdaptiveMeshConfig): MeshGrid | null {
	const minSpan = config.density === "spacing" ? config.spacingMm : 1;
	const axis = (lo: number, hi: number, bedLo: number, bedHi: number): [number, number] | null => {
		let a = lo - config.marginMm;
		let b = hi + config.marginMm;
		if (config.clampToBed) {
			a = Math.max(a, bedLo);
			b = Math.min(b, bedHi);
			if (b <= a) return null;
		}
		if (b - a < minSpan) {
			const mid = (a + b) / 2;
			a = mid - minSpan / 2;
			b = mid + minSpan / 2;
			if (config.clampToBed) {
				// Slide back inside the probeable area rather than shrinking below the minimum span
				if (a < bedLo) { b += bedLo - a; a = bedLo; }
				if (b > bedHi) { a -= b - bedHi; b = bedHi; }
				a = Math.max(a, bedLo);
			}
		}
		// Round first: an arc extreme like sin(pi) is 1e-16, which ceil would push up a whole 0.1
		const tenths = (v: number): number => Math.round(v * 1e6) / 1e5;
		return [Math.floor(tenths(a)) / 10, Math.ceil(tenths(b)) / 10];
	};
	const x = axis(bounds.minX, bounds.maxX, config.bedMinX, config.bedMaxX);
	const y = axis(bounds.minY, bounds.maxY, config.bedMinY, config.bedMaxY);
	if (x === null || y === null) return null;
	return { minX: x[0], maxX: x[1], minY: y[0], maxY: y[1] };
}

/** The `M557` command for a grid, with `R` carried over from a line being replaced. */
export function buildM557(grid: MeshGrid, config: AdaptiveMeshConfig, radius: number | null): string {
	const range = (lo: number, hi: number): string => `${formatNumber(lo, 1)}:${formatNumber(hi, 1)}`;
	const density = config.density === "spacing"
		? `S${formatNumber(config.spacingMm, 2)}`
		: `P${Math.round(config.points)}:${Math.round(config.points)}`;
	const r = radius !== null ? ` R${formatNumber(radius, 2)}` : "";
	return `M557 X${range(grid.minX, grid.maxX)} Y${range(grid.minY, grid.maxY)}${r} ${density} ; adaptive mesh`;
}

/** Approximate probe-point count, for the firmware-capacity warning. */
export function estimatePoints(grid: MeshGrid, config: AdaptiveMeshConfig): number {
	if (config.density === "points") return Math.round(config.points) ** 2;
	const nx = Math.floor((grid.maxX - grid.minX) / config.spacingMm) + 1;
	const ny = Math.floor((grid.maxY - grid.minY) / config.spacingMm) + 1;
	return nx * ny;
}

// #endregion

export const adaptiveMeshStep: StepDefinition<AdaptiveMeshConfig> = {
	id: "adaptiveMesh",
	label: "Adaptive bed mesh",
	description: "Rewrites M557 so G29 only probes the area the print occupies, at a mesh density you choose.",
	tip: "Reads the print's XY footprint (by default the first layer, ignoring the start-gcode purge "
		+ "line) and rewrites the M557 grid to that area plus a margin, so G29 skips the rest of the "
		+ "bed. Set the density as a probe spacing in mm or as a number of points per axis. An "
		+ "existing M557 in the file is replaced; otherwise one is inserted just before the first G29 "
		+ "that probes. If the file has neither (the probing happens in a macro), the default is to "
		+ "leave it alone and say so — choose 'insert at the top of the file' to put M557 first "
		+ "instead. Set the probeable area if the probe cannot reach the whole bed: the print bounds "
		+ "are nozzle positions, and the probe is offset from the nozzle.",
	docsAnchor: "adaptive-bed-mesh",
	icon: "mdi-grid",
	fields: [
		{
			key: "density", label: "Mesh density by", type: "select", default: "spacing",
			options: [
				{ value: "spacing", label: "Probe spacing (mm)" },
				{ value: "points", label: "Points per axis" },
			],
			help: "Spacing keeps the density constant however big the print is; points gives a fixed grid size that gets finer on a small print. Default: spacing.",
		},
		{
			key: "spacingMm", label: "Probe spacing (mm)", type: "number", default: 25, min: 1, step: 1,
			showWhen: { key: "density", equals: ["spacing"] },
			help: "Distance between probe points (M557 S). Smaller is denser and slower. Default: 25.",
		},
		{
			key: "points", label: "Points per axis", type: "number", default: 5, min: 2, max: 31, step: 1,
			showWhen: { key: "density", equals: ["points"] },
			help: "Number of probe points along each axis (M557 P). Default: 5.",
		},
		{
			key: "marginMm", label: "Margin around the print (mm)", type: "number", default: 5, min: 0, step: 1,
			help: "Extends the probed area beyond the print's edge on every side. Default: 5.",
		},
		{
			key: "firstLayerOnly", label: "Use the first layer only", type: "boolean", default: true,
			help: "The mesh only matters where the first layer touches the bed. Turn off to cover the whole print's footprint (a raft-less overhang, say). Default: on.",
		},
		{
			key: "ignorePrime", label: "Ignore purge and prime lines", type: "boolean", default: true,
			help: "Skips extrusion before the first layer marker and anything the slicer tags as ';TYPE:Custom', so a purge line at the bed edge does not stretch the mesh. Default: on.",
		},
		{
			key: "clampToBed", label: "Limit to the probeable area", type: "boolean", default: false,
			help: "Clips the mesh to the area your probe can actually reach. Default: off.",
		},
		{
			key: "bedMinX", label: "Probeable X min (mm)", type: "number", default: 0, step: 1,
			showWhen: { key: "clampToBed", equals: [true] },
		},
		{
			key: "bedMaxX", label: "Probeable X max (mm)", type: "number", default: 300, step: 1,
			showWhen: { key: "clampToBed", equals: [true] },
		},
		{
			key: "bedMinY", label: "Probeable Y min (mm)", type: "number", default: 0, step: 1,
			showWhen: { key: "clampToBed", equals: [true] },
		},
		{
			key: "bedMaxY", label: "Probeable Y max (mm)", type: "number", default: 300, step: 1,
			showWhen: { key: "clampToBed", equals: [true] },
		},
		{
			key: "ifNoAnchor", label: "If the file has no M557 or G29", type: "select", default: "skip",
			options: [
				{ value: "skip", label: "Leave the file unchanged" },
				{ value: "top", label: "Insert M557 at the top of the file" },
			],
			help: "Where the probing happens in a macro the file only calls, there is nothing here to attach the grid to. Default: leave unchanged.",
		},
	],

	analysis(config: AdaptiveMeshConfig, ctx: StepFactoryContext): Array<AnalysisCollector> {
		return [new MeshBoundsCollector(collectorId(ctx), config)];
	},

	create(config: AdaptiveMeshConfig, ctx: StepFactoryContext): Transform {
		const resultKey = collectorId(ctx);
		let line: string | null = null;
		let grid: MeshGrid | null = null;
		let facts: AdaptiveMeshFacts | null = null;
		let handled = false;
		let warned = false;

		const gridLine = (radius: number | null): string | null =>
			grid === null ? null : buildM557(grid, config, radius);

		return {
			id: "adaptiveMesh",

			onStart(runCtx: RunContext): Array<string> | void {
				facts = (runCtx.analysis.get(resultKey) as AdaptiveMeshFacts | undefined) ?? null;
				if (facts === null) {
					runCtx.warn("Adaptive mesh: the analysis pass did not run, so M557 was not changed.");
					return;
				}
				let bounds = facts.bounds;
				if (bounds === null && facts.unfiltered !== null) {
					bounds = facts.unfiltered;
					runCtx.warn("Adaptive mesh: no extrusion matched the first-layer / ignore-purge filters (no layer markers in this file?), so every extruding move was used for the bounds.");
				}
				if (bounds === null) {
					runCtx.warn("Adaptive mesh: the file has no extruding XY moves, so M557 was not changed.");
					return;
				}
				grid = computeGrid(bounds, config);
				if (grid === null) {
					runCtx.warn("Adaptive mesh: the print lies outside the probeable area, so M557 was not changed.");
					return;
				}
				const points = estimatePoints(grid, config);
				if (points > MIN_GRID_POINT_LIMIT) {
					runCtx.warn(`Adaptive mesh: about ${points} probe points, more than the ${MIN_GRID_POINT_LIMIT} some Duet boards support. Increase the spacing or lower the points per axis.`);
				}
				line = gridLine(null);
				if (!facts.hasAnchor) {
					if (config.ifNoAnchor === "top") {
						handled = true;
						return [line as string];
					}
					warned = true;
					runCtx.warn("Adaptive mesh: no M557 or G29 in this file to attach the grid to, so nothing was changed. Choose 'Insert M557 at the top of the file' if the probing is in a macro.");
				}
			},

			onLine(ctx: LineContext, text: string) {
				if (grid === null) return undefined;
				const token = ctx.token;
				if (token.letter === "M" && token.code === "M557" && isGridM557(token.body)) {
					handled = true;
					return gridLine(paramNumber(parseParams(token.body), "R"));
				}
				if (!handled && token.letter === "G" && token.code === "G29" && isProbingG29(token.body)) {
					handled = true;
					return [line as string, text];
				}
				return undefined;
			},

			onEnd(runCtx: RunContext): void {
				if (grid !== null && !handled && !warned) {
					runCtx.warn("Adaptive mesh: no M557 or G29 was reached, so the grid was not written.");
				}
			},
		};
	},

	validate(config: AdaptiveMeshConfig): Array<string> {
		const errors: Array<string> = [];
		if (config.clampToBed) {
			if (config.bedMaxX <= config.bedMinX) errors.push("Probeable X max must be greater than X min");
			if (config.bedMaxY <= config.bedMinY) errors.push("Probeable Y max must be greater than Y min");
		}
		return errors;
	},
};
