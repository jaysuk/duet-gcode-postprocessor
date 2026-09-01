import { describe, expect, it } from "vitest";

import { arcRadiusWithinTolerance, tryFitArc, type ArcFitOptions, type FitPoint } from "../model/gcode/arcFit";

const OPTIONS: ArcFitOptions = { resolutionMm: 0.05, pathTolerancePercent: 5, maxRadiusMm: 9999 };

/**
 * Points on a circle of the given centre/radius, at the given angles in degrees, in order.
 *
 * The perpendicular deviation between two points `theta` degrees apart on a circle of radius `r` is
 * its sagitta, `r * (1 - cos(theta/2))`. For the default 0.05mm resolution that caps the step between
 * adjacent points at roughly `2 * acos(1 - 0.05/r)` degrees — a few degrees for the radii used below.
 * Every "should fit" fixture in this file keeps well inside that; the tests that expect rejection use
 * a deliberately wide step instead.
 */
function onCircle(cx: number, cy: number, r: number, anglesDeg: Array<number>): Array<FitPoint> {
	return anglesDeg.map((deg) => {
		const rad = (deg * Math.PI) / 180;
		return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
	});
}

describe("tryFitArc", () => {
	it("fits points sampled exactly on a known circle, recovering its centre, radius and direction", () => {
		const points = onCircle(10, 10, 5, [0, 5, 10, 15, 20, 25, 30]);
		const fit = tryFitArc(points, OPTIONS);
		expect(fit).not.toBeNull();
		expect(fit!.centreX).toBeCloseTo(10, 6);
		expect(fit!.centreY).toBeCloseTo(10, 6);
		expect(fit!.radius).toBeCloseTo(5, 6);
		// Increasing angle is anticlockwise -> G3
		expect(fit!.clockwise).toBe(false);
	});

	it("rejects three collinear points rather than returning a huge arc", () => {
		const points: Array<FitPoint> = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }];
		expect(tryFitArc(points, OPTIONS)).toBeNull();
	});

	it("rejects near-collinear points via maxRadiusMm rather than a special-cased epsilon", () => {
		// A minuscule bow in an otherwise straight line fits a circle with an enormous radius
		const points: Array<FitPoint> = [{ x: 0, y: 0 }, { x: 5, y: 0.0001 }, { x: 10, y: 0 }];
		const permissive = tryFitArc(points, { ...OPTIONS, maxRadiusMm: 1e12, pathTolerancePercent: 100 });
		expect(permissive).not.toBeNull();
		expect(permissive!.radius).toBeGreaterThan(10000);
		// The same points never fit with the default, realistic cap
		expect(tryFitArc(points, OPTIONS)).toBeNull();
	});

	it("breaks when a point is nudged beyond resolutionMm, and holds when nudged within it", () => {
		// n=5 points fit a circle through indices 0, 2 (floor(5/2)) and 4 -- nudge index 1 instead, a
		// point that is *tested against* that circle rather than one that helps define it. The nudge
		// is applied radially (centre is the origin here, so this is a simple scale) so its magnitude
		// maps directly onto the radial deviation the test checks against, rather than a Cartesian
		// offset whose effect on radial distance depends on the point's own angle.
		const radius = 20;
		const points = onCircle(0, 0, radius, [0, 3, 6, 9, 12]);
		const radialNudge = (p: FitPoint, amount: number): FitPoint => {
			const scale = (radius + amount) / radius;
			return { x: p.x * scale, y: p.y * scale };
		};
		const nudgedOut = points.map((p, i) => (i === 1 ? radialNudge(p, 0.06) : p));
		const nudgedIn = points.map((p, i) => (i === 1 ? radialNudge(p, 0.02) : p));
		expect(tryFitArc(nudgedOut, OPTIONS)).toBeNull();
		expect(tryFitArc(nudgedIn, OPTIONS)).not.toBeNull();
	});

	it("rejects a chord that bows away from the arc even though both its endpoints lie exactly on the circle", () => {
		// p0 (0deg) and p1 (90deg) both sit exactly on the r=10 circle -- the radial test alone would
		// pass both -- but the straight chord between them dips to a distance of ~7.07 from the
		// centre at its midpoint, far outside the 0.05mm default resolution
		const points = onCircle(0, 0, 10, [0, 90, 135, 180]);
		expect(tryFitArc(points, OPTIONS)).toBeNull();

		// The same shape, sampled finely enough that no single chord bows away, holds fine
		const evenlySpaced = onCircle(0, 0, 10, [0, 1, 2, 3]);
		expect(tryFitArc(evenlySpaced, OPTIONS)).not.toBeNull();
	});

	it("rejects a path that backtracks, since it covers more distance than the arc it nets out to", () => {
		// Every point lies exactly on a r=10 circle and each step is 5 degrees or less, so every
		// per-point and per-segment deviation is negligible (well under 0.05mm) -- but the path
		// wobbles forward and back (0 -> 5 -> 3 -> 8 -> 12 -> 10 -> 15 degrees), covering noticeably
		// more ground than the net 15-degree arc from start to end. Deviation alone cannot catch
		// this; the arc-length-vs-polyline-length check exists specifically for it.
		const wobbly = onCircle(0, 0, 10, [0, 5, 3, 8, 12, 10, 15]);
		expect(tryFitArc(wobbly, OPTIONS)).toBeNull();

		// The same net rotation, sampled monotonically, holds fine
		const monotonic = onCircle(0, 0, 10, [0, 2, 5, 8, 11, 13, 15]);
		expect(tryFitArc(monotonic, OPTIONS)).not.toBeNull();
	});

	it("produces G2 for a clockwise run and G3 for an anticlockwise one", () => {
		const cw = onCircle(0, 0, 10, [12, 9, 6, 3, 0]);
		const ccw = onCircle(0, 0, 10, [0, 3, 6, 9, 12]);
		expect(tryFitArc(cw, OPTIONS)!.clockwise).toBe(true);
		expect(tryFitArc(ccw, OPTIONS)!.clockwise).toBe(false);
	});

	it("gives a centre whose offset from the start point (I/J) has at least one non-zero component", () => {
		const points = onCircle(5, -5, 8, [10, 12, 14, 16]);
		const fit = tryFitArc(points, OPTIONS)!;
		expect(fit).not.toBeNull();
		const i = fit.centreX - points[0].x;
		const j = fit.centreY - points[0].y;
		expect(i !== 0 || j !== 0).toBe(true);
	});

	it("needs at least 3 points", () => {
		expect(tryFitArc([], OPTIONS)).toBeNull();
		expect(tryFitArc([{ x: 0, y: 0 }], OPTIONS)).toBeNull();
		expect(tryFitArc([{ x: 0, y: 0 }, { x: 1, y: 1 }], OPTIONS)).toBeNull();
	});
});

describe("arcRadiusWithinTolerance", () => {
	it("accepts a fitted arc's rounded coordinates", () => {
		const points = onCircle(12.3456, -7.891, 15, [0, 2, 4, 6, 8]);
		const fit = tryFitArc(points, OPTIONS)!;
		expect(fit).not.toBeNull();
		const start = points[0];
		const end = points[points.length - 1];
		const round = (n: number) => Math.round(n * 1000) / 1000; // 3 decimals, this codebase's norm

		const i = round(fit.centreX - start.x);
		const j = round(fit.centreY - start.y);
		expect(
			arcRadiusWithinTolerance(round(start.x), round(start.y), round(end.x), round(end.y), i, j),
		).toBe(true);
	});

	it("rejects an end point that is not actually on the circle the centre and start describe", () => {
		expect(arcRadiusWithinTolerance(0, 0, 100, 100, 10, 0)).toBe(false);
	});
});
