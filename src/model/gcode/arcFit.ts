/**
 * Fits a single circular arc through a run of XY points — the geometric core of arc welding
 * (collapsing a slicer's polyline approximation of a curve back into `G2`/`G3`). Pure: no G-code
 * tokens, no line text, no knowledge of steps or pipelines. `steps/arcWeld.ts` owns buffering the
 * points and deciding when a run must break for G-code reasons (a tool change, a retraction, a
 * layer boundary); this module only answers "does this set of points form one valid arc".
 *
 * Clean-room reimplementation of the algorithm in FormerLurker's ArcWelderLib
 * (https://github.com/FormerLurker/ArcWelderLib, AGPL-3.0) — described from its published behaviour,
 * not ported from its source. See the attribution policy in `docs/feature-ideas.md`.
 *
 * **Firmware contract, verified against RepRapFirmware source before writing this**
 * (`C:\Users\live\Documents\Github\RRFBuild\RepRapFirmware`, `src/GCodes/GCodes.cpp`'s `DoArcMove`,
 * `src/Config/Configuration.h`):
 *
 * - Centre format (`I`/`J`, relative to the arc's start point) is used here rather than radius
 *   format (`R`): radius format has a short-arc/long-arc sign ambiguity and throws outright when the
 *   radius is fractionally too small to reach the endpoint. At least one of `I`/`J` must be present
 *   and non-zero, or RRF rejects the move with "no I J K or R parameter".
 * - RRF recomputes the radius from the *emitted* numbers and rejects the move if the start-to-centre
 *   and end-to-centre distances differ by more than `MaxNonCncRadiusError` (0.05 mm) in normal mode —
 *   loose specifically, per RRF's own source comment, "because slicers and ArcWelder may not output
 *   coordinates to a resolution of 0.002mm". `arcRadiusWithinTolerance` below is the same check,
 *   run against the rounded numbers actually about to be emitted, so a step can catch a rounding
 *   failure before it becomes a rejected move on the printer.
 */

export interface FitPoint {
	x: number;
	y: number;
}

export interface ArcFitOptions {
	/** Maximum allowed deviation of any buffered point from the fitted circle, mm. */
	resolutionMm: number;
	/** Maximum allowed difference between the fitted arc's length and the original polyline's, as a
	 *  percentage of the polyline length. */
	pathTolerancePercent: number;
	/** Reject a fit whose radius exceeds this — the defence against near-collinear points producing
	 *  a technically-valid but enormous circle. */
	maxRadiusMm: number;
}

export interface FittedArc {
	centreX: number;
	centreY: number;
	radius: number;
	/** true = G2 (clockwise), false = G3 (anticlockwise), matching RRF's XY-plane convention. */
	clockwise: boolean;
}

/** RRF's own tolerance for the non-CNC radius check — `Config/Configuration.h`'s
 *  `MaxNonCncRadiusError`. */
export const MAX_NON_CNC_RADIUS_ERROR_MM = 0.05;

const MIN_RADIUS_MM = 1e-6;

/**
 * Circle through three points via the circumcircle determinant formula. Returns `null` when the
 * points are exactly collinear (the determinant `a` is zero) — a *near*-collinear triple is not
 * specially detected here; it produces a very large, finite radius, which `tryFitArc` rejects via
 * `maxRadiusMm` instead. Deliberately not least-squares: three points, one formula, easy to verify
 * by hand.
 */
function circumcircle(p1: FitPoint, p2: FitPoint, p3: FitPoint): { x: number; y: number; radius: number } | null {
	const a = p1.x * (p2.y - p3.y) - p1.y * (p2.x - p3.x) + p2.x * p3.y - p3.x * p2.y;
	if (a === 0) return null;

	const sq1 = p1.x * p1.x + p1.y * p1.y;
	const sq2 = p2.x * p2.x + p2.y * p2.y;
	const sq3 = p3.x * p3.x + p3.y * p3.y;

	const b = sq1 * (p3.y - p2.y) + sq2 * (p1.y - p3.y) + sq3 * (p2.y - p1.y);
	const c = sq1 * (p2.x - p3.x) + sq2 * (p3.x - p1.x) + sq3 * (p1.x - p2.x);

	const x = -b / (2 * a);
	const y = -c / (2 * a);
	const radius = Math.hypot(x - p1.x, y - p1.y);
	return { x, y, radius };
}

/**
 * Every buffered point must sit within `resolutionMm` of the fitted circle, checked two ways:
 *
 * 1. **Radial** — the point's own distance from the centre must be close to the radius.
 * 2. **Perpendicular** — for each consecutive pair, the closest point on that *segment* to the
 *    centre (not just its endpoints) must also be close to the radius. Without this, a chord that
 *    cuts across the circle passes the radial test at both of its endpoints while bowing away from
 *    the arc in the middle — exactly the failure mode the perpendicular test exists to catch.
 */
function withinDeviation(
	points: ReadonlyArray<FitPoint>,
	centre: { x: number; y: number },
	radius: number,
	resolutionMm: number,
): boolean {
	for (const p of points) {
		if (Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius) > resolutionMm) return false;
	}
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const lengthSquared = dx * dx + dy * dy;
		if (lengthSquared === 0) continue;
		const t = ((centre.x - a.x) * dx + (centre.y - a.y) * dy) / lengthSquared;
		// Only the interior of the segment is checked here — its own endpoints are already points in
		// `points` and were just checked by the radial test above
		if (t <= 0 || t >= 1) continue;
		const px = a.x + t * dx;
		const py = a.y + t * dy;
		if (Math.abs(Math.hypot(px - centre.x, py - centre.y) - radius) > resolutionMm) return false;
	}
	return true;
}

/** Signed angle from `a` to `b` about the origin, wrapped to `(-PI, PI]`. */
function angleDelta(a: number, b: number): number {
	let d = b - a;
	while (d > Math.PI) d -= 2 * Math.PI;
	while (d <= -Math.PI) d += 2 * Math.PI;
	return d;
}

/**
 * Total signed angle swept from the first point to the last, accumulated step by step rather than
 * read directly off the start and end angles — the only way to tell a short arc from one that goes
 * the long way round (over 180°), since the endpoints alone cannot distinguish the two. Negative is
 * clockwise (G2), positive is anticlockwise (G3), matching `atan2`'s own convention.
 */
function totalSweep(points: ReadonlyArray<FitPoint>, centre: { x: number; y: number }): number {
	let angle = Math.atan2(points[0].y - centre.y, points[0].x - centre.x);
	let sweep = 0;
	for (let i = 1; i < points.length; i++) {
		const next = Math.atan2(points[i].y - centre.y, points[i].x - centre.x);
		sweep += angleDelta(angle, next);
		angle = next;
	}
	return sweep;
}

function polylineLength(points: ReadonlyArray<FitPoint>): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	}
	return total;
}

/**
 * Try to fit one arc through every point in `points`, in order. Returns `null` when any constraint
 * fails — the points are collinear, one strays beyond `resolutionMm`, the fitted radius exceeds
 * `maxRadiusMm`, or the arc's own length is not within `pathTolerancePercent` of the original
 * polyline's (the check that catches a circle that is geometrically plausible but travels the wrong
 * way round it). Needs at least 3 points; fewer always returns `null`.
 */
export function tryFitArc(points: ReadonlyArray<FitPoint>, options: ArcFitOptions): FittedArc | null {
	if (points.length < 3) return null;

	const p1 = points[0];
	const p2 = points[Math.floor(points.length / 2)];
	const p3 = points[points.length - 1];

	const circle = circumcircle(p1, p2, p3);
	if (circle === null) return null;
	if (!Number.isFinite(circle.radius) || circle.radius < MIN_RADIUS_MM || circle.radius > options.maxRadiusMm) {
		return null;
	}

	if (!withinDeviation(points, circle, circle.radius, options.resolutionMm)) return null;

	const sweep = totalSweep(points, circle);
	if (sweep === 0) return null;

	const arcLength = circle.radius * Math.abs(sweep);
	const straightLength = polylineLength(points);
	if (straightLength === 0) return null;
	const percentDiff = (Math.abs(arcLength - straightLength) / straightLength) * 100;
	if (percentDiff > options.pathTolerancePercent) return null;

	// I/J are the centre relative to the arc's own start point; RRF requires at least one non-zero
	const i = circle.x - p1.x;
	const j = circle.y - p1.y;
	if (i === 0 && j === 0) return null;

	return { centreX: circle.x, centreY: circle.y, radius: circle.radius, clockwise: sweep < 0 };
}

/**
 * Whether RRF's own non-CNC radius check would accept this arc once emitted — recomputed from the
 * exact numbers about to be written (after rounding), the same way `DoArcMove` recomputes it from
 * the command it just parsed. Call this *after* formatting `startX`/`startY`/`i`/`j`/`endX`/`endY`
 * to their final decimal precision; rounding can push a fit that passed on the raw numbers outside
 * RRF's tolerance.
 */
export function arcRadiusWithinTolerance(
	startX: number, startY: number, endX: number, endY: number, i: number, j: number,
): boolean {
	const centreX = startX + i;
	const centreY = startY + j;
	const startRadius = Math.hypot(i, j);
	const endRadius = Math.hypot(endX - centreX, endY - centreY);
	return Math.abs(endRadius - startRadius) <= MAX_NON_CNC_RADIUS_ERROR_MM;
}

/**
 * The angle (radians, always in `[0, 2*PI]`) actually swept by a `G2`/`G3` move going from its start
 * point around to its end point **the way the command travels**, not the shorter of the two possible
 * directions — a chord-based distance is not the same thing, and using it understates both time and
 * flow on anything but a very shallow arc. Mirrors RepRapFirmware's own computation exactly
 * (`GCodes::DoArcMove`, `src/GCodes/GCodes.cpp` — the `wholeCircle`/`totalArc` block, verified against
 * `C:\Users\live\Documents\Github\RRFBuild\RepRapFirmware`):
 *
 * - a start point identical to the end point is a full circle (`2*PI`) — RRF's own comment says
 *   plainly "CNC machines usually do a full circle if the initial and final XY coordinates are the
 *   same", regardless of direction;
 * - otherwise it is the angle from the centre to the start minus the angle from the centre to the end
 *   (or the reverse, for the other direction), wrapped into `[0, 2*PI)` by adding a full turn if that
 *   subtraction came out negative — RRF does the identical wrap (`if (totalArc < 0.0) totalArc += TwoPi`).
 */
export function arcSweepAngle(
	startX: number, startY: number, endX: number, endY: number, i: number, j: number, clockwise: boolean,
): number {
	if (startX === endX && startY === endY) return 2 * Math.PI;
	const centreX = startX + i;
	const centreY = startY + j;
	const startAngle = Math.atan2(startY - centreY, startX - centreX);
	const endAngle = Math.atan2(endY - centreY, endX - centreX);
	let sweep = clockwise ? startAngle - endAngle : endAngle - startAngle;
	if (sweep < 0) sweep += 2 * Math.PI;
	return sweep;
}

/**
 * Distance actually travelled by a `G2`/`G3` move — radius times the swept angle. **Not** the chord
 * between its endpoints, which is what naively measuring `hypot(dx, dy)` gives and is wrong for
 * anything but a very shallow arc (and wrong by an unbounded amount as the sweep approaches a full
 * circle, where the chord tends to zero while the real distance does not).
 */
export function arcMoveLength(
	startX: number, startY: number, endX: number, endY: number, i: number, j: number, clockwise: boolean,
): number {
	const radius = Math.hypot(i, j);
	return radius * arcSweepAngle(startX, startY, endX, endY, i, j, clockwise);
}
