/**
 * Detects a pocket that gets roofed over between two consecutive layers — the one moment a magnet
 * or a nut can be dropped in before it becomes permanently inaccessible.
 *
 * Pure geometry: takes per-layer extruding segments, knows nothing about G-code, tokens or steps.
 * `sparseInfill` segments are excluded by the caller-supplied `Feature` on each segment — infill is
 * not solid, and treating its own internal gaps as "enclosed" is the single largest source of false
 * positives this detector would otherwise have.
 *
 * **This is genuinely an enclosure test, not a naive "empty here, occupied there" diff.** A plain
 * per-cell diff fires on every ordinary overhang and every wall that grows outward between layers —
 * ubiquitous in real prints, and not a pocket at all. What actually distinguishes a pocket is that
 * its empty cells are *unreachable from outside the layer's own cross-section*: a flood fill from a
 * padded ring around the layer's occupied cells, through every unoccupied cell, marks everything
 * that is open to the outside; whatever the fill never reaches is enclosed.
 *
 * **Memory:** the detector keeps only the *previous* layer's occupancy grid to rasterise the current
 * one against, plus a summary of currently-open regions (their member cells and the layer they were
 * first seen enclosed) — not every layer's full grid. A region's cell count is bounded by the size
 * of the hole it represents, not by the file's layer count, so this stays small on any real file.
 *
 * **This is the speculative half of task 12, and its own stop point is now resolved: stop here.**
 * Checked against a real, densely-toolpathed 250-layer PrusaSlicer file — not just the synthetic
 * geometry in this module's own tests, and not this repo's bundled fixtures, which are too thin to
 * answer the question — the detector produced 16 candidates at a 2mm grid, 42 at 1mm, and 1,139 at
 * 0.5mm, on a single object with no intentional cavities at all. Most trace the curved outline of a
 * thin ring wall: rasterising a curve onto a grid leaves small gaps between its inner and outer edge
 * that read as "enclosed" purely from quantisation, not real 3D geometry — an artefact that finer
 * resolution makes *worse*, not better, since a finer grid resolves the curve more faithfully. That
 * is exactly the failure mode this task's own acceptance criteria named as disqualifying, so this
 * stays a pure, tested, unwired module: no collector, no step, no UI. See
 * `docs/tasks/12-geometry-analysis.md` §4 and `src/__tests__/voids.test.ts`'s own describe block for
 * the full account.
 */

import type { Feature } from "./features";

export interface VoidSegment {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	feature: Feature;
}

export interface VoidCandidate {
	/** The layer index whose own extrusion closed the pocket over. */
	layer: number;
	/** Centroid of the enclosed region, in the same coordinates as the input segments. */
	x: number;
	y: number;
	/** How many layers the pocket was open (enclosed but not yet covered) before this one closed it.
	 *  Always at least 1. */
	depthLayers: number;
}

export interface VoidDetectorOptions {
	/** Grid cell size. Coarser misses small pockets; finer costs more cells per layer. */
	resolutionMm: number;
}

interface TrackedRegion {
	cells: Set<string>;
	sinceLayer: number;
	x: number;
	y: number;
}

/** A region is treated as "the same one" across layers, or as "closed", by cell overlap rather than
 *  requiring an exact match — a pocket's own cross-section drifts slightly layer to layer. */
const OVERLAP_THRESHOLD = 0.5;
/** A region counts as covered once this much of it has been printed over. */
const CLOSED_THRESHOLD = 0.8;

function cellKey(cx: number, cy: number): string {
	return `${cx},${cy}`;
}

/** Rasterises one segment into a set of occupied cell keys, sampling finely enough that a diagonal
 *  segment cannot skip the cell it passes through. Not a true Bresenham line — this is a detection
 *  heuristic, not a firmware-facing computation, and does not need to be exact. */
function rasteriseSegment(occupied: Set<string>, seg: VoidSegment, resolutionMm: number): void {
	const dx = seg.x1 - seg.x0;
	const dy = seg.y1 - seg.y0;
	const length = Math.hypot(dx, dy);
	const steps = Math.max(1, Math.ceil(length / (resolutionMm / 2)));
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const x = seg.x0 + dx * t;
		const y = seg.y0 + dy * t;
		occupied.add(cellKey(Math.floor(x / resolutionMm), Math.floor(y / resolutionMm)));
	}
}

interface Grid {
	occupied: Set<string>;
	minCx: number; maxCx: number;
	minCy: number; maxCy: number;
}

function buildGrid(segments: ReadonlyArray<VoidSegment>, resolutionMm: number): Grid | null {
	const occupied = new Set<string>();
	for (const seg of segments) {
		if (seg.feature === "sparseInfill") continue;
		rasteriseSegment(occupied, seg, resolutionMm);
	}
	if (occupied.size === 0) return null;
	let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
	for (const key of occupied) {
		const [cx, cy] = key.split(",").map(Number);
		if (cx < minCx) minCx = cx;
		if (cx > maxCx) maxCx = cx;
		if (cy < minCy) minCy = cy;
		if (cy > maxCy) maxCy = cy;
	}
	return { occupied, minCx, maxCx, minCy, maxCy };
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Every unoccupied cell reachable from a padded ring around the grid's own bounding box — "open to
 *  the outside" of this layer's cross-section, the complement of "enclosed". */
function floodFillOutside(grid: Grid): Set<string> {
	const lo = { x: grid.minCx - 1, y: grid.minCy - 1 };
	const hi = { x: grid.maxCx + 1, y: grid.maxCy + 1 };
	const outside = new Set<string>();
	const queue: Array<[number, number]> = [];

	function tryVisit(cx: number, cy: number): void {
		if (cx < lo.x || cx > hi.x || cy < lo.y || cy > hi.y) return;
		const key = cellKey(cx, cy);
		if (grid.occupied.has(key) || outside.has(key)) return;
		outside.add(key);
		queue.push([cx, cy]);
	}

	for (let cx = lo.x; cx <= hi.x; cx++) {
		tryVisit(cx, lo.y);
		tryVisit(cx, hi.y);
	}
	for (let cy = lo.y; cy <= hi.y; cy++) {
		tryVisit(lo.x, cy);
		tryVisit(hi.x, cy);
	}
	while (queue.length > 0) {
		const [cx, cy] = queue.pop() as [number, number];
		for (const [dx, dy] of NEIGHBOURS) tryVisit(cx + dx, cy + dy);
	}
	return outside;
}

/** Connected components of enclosed cells (unoccupied, and not reached by {@link floodFillOutside}),
 *  each with its own centroid in world coordinates. */
function enclosedRegions(grid: Grid, outside: Set<string>, resolutionMm: number): Array<TrackedRegion> {
	const enclosed = new Set<string>();
	for (let cx = grid.minCx; cx <= grid.maxCx; cx++) {
		for (let cy = grid.minCy; cy <= grid.maxCy; cy++) {
			const key = cellKey(cx, cy);
			if (!grid.occupied.has(key) && !outside.has(key)) enclosed.add(key);
		}
	}

	const regions: Array<TrackedRegion> = [];
	const visited = new Set<string>();
	for (const start of enclosed) {
		if (visited.has(start)) continue;
		const cells = new Set<string>();
		const queue: Array<string> = [start];
		visited.add(start);
		while (queue.length > 0) {
			const key = queue.pop() as string;
			cells.add(key);
			const [cx, cy] = key.split(",").map(Number);
			for (const [dx, dy] of NEIGHBOURS) {
				const nKey = cellKey(cx + dx, cy + dy);
				if (enclosed.has(nKey) && !visited.has(nKey)) {
					visited.add(nKey);
					queue.push(nKey);
				}
			}
		}
		let sumX = 0, sumY = 0;
		for (const key of cells) {
			const [cx, cy] = key.split(",").map(Number);
			sumX += (cx + 0.5) * resolutionMm;
			sumY += (cy + 0.5) * resolutionMm;
		}
		regions.push({ cells, sinceLayer: -1, x: sumX / cells.size, y: sumY / cells.size });
	}
	return regions;
}

/** Overlap relative to whichever set is smaller — a region that splits into two (a bridge crossing
 *  a pocket) or merges from two into one must still match its earlier self on *each* side, which a
 *  fraction taken only of the larger set's size would systematically miss. */
function overlapFraction(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const key of a) {
		if (b.has(key)) shared++;
	}
	return shared / Math.min(a.size, b.size);
}

/** Fraction of `region`'s own cells that are occupied in `grid` — "how much of this pocket has now
 *  been printed over". */
function occupiedFraction(region: TrackedRegion, grid: Grid): number {
	let occupied = 0;
	for (const key of region.cells) {
		if (grid.occupied.has(key)) occupied++;
	}
	return occupied / region.cells.size;
}

export class VoidDetector {
	private readonly resolutionMm: number;
	private openRegions: Array<TrackedRegion> = [];

	constructor(options: VoidDetectorOptions) {
		this.resolutionMm = options.resolutionMm;
	}

	/**
	 * Feed one layer's extruding segments, in order (not necessarily sorted by anything but source
	 * order — rasterisation does not care). Returns every pocket this layer's own extrusion covered
	 * over: enclosed in an earlier layer, occupied now.
	 */
	layer(index: number, segments: ReadonlyArray<VoidSegment>): Array<VoidCandidate> {
		const grid = buildGrid(segments, this.resolutionMm);
		const closed: Array<VoidCandidate> = [];

		if (grid === null) {
			// Nothing extruded this layer (a travel-only or fully-support layer, after exclusions):
			// nothing can have been covered, and nothing new can have become enclosed either.
			return closed;
		}

		const stillOpen: Array<TrackedRegion> = [];
		const currentRegions = enclosedRegions(grid, floodFillOutside(grid), this.resolutionMm);
		const matchedCurrent = new Set<number>();

		for (const previous of this.openRegions) {
			if (occupiedFraction(previous, grid) >= CLOSED_THRESHOLD) {
				closed.push({
					layer: index, x: previous.x, y: previous.y,
					depthLayers: Math.max(1, index - previous.sinceLayer),
				});
				continue;
			}
			// Still enclosed? Find the current-layer region (if any) that best represents the same
			// pocket, so its tracked shape can drift with the pocket rather than being pinned to the
			// first layer's own outline.
			let bestIndex = -1;
			let bestOverlap = 0;
			for (let i = 0; i < currentRegions.length; i++) {
				if (matchedCurrent.has(i)) continue;
				const overlap = overlapFraction(previous.cells, currentRegions[i].cells);
				if (overlap > bestOverlap) {
					bestOverlap = overlap;
					bestIndex = i;
				}
			}
			if (bestIndex >= 0 && bestOverlap >= OVERLAP_THRESHOLD) {
				matchedCurrent.add(bestIndex);
				stillOpen.push({ ...currentRegions[bestIndex], sinceLayer: previous.sinceLayer });
			}
			// Neither closed nor still enclosed: the pocket opened up to the outside (a window, not
			// a hole) — simply stop tracking it. Not a void; nothing to report.
		}

		for (let i = 0; i < currentRegions.length; i++) {
			if (!matchedCurrent.has(i)) stillOpen.push({ ...currentRegions[i], sinceLayer: index });
		}

		this.openRegions = stillOpen;
		return closed;
	}
}
