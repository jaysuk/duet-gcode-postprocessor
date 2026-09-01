import { describe, expect, it } from "vitest";

import { advance, createState } from "../model/gcode/state";
import { tokenise } from "../model/gcode/tokenise";
import { moveTime, TimeEstimator, type MachineLimits } from "../model/gcode/timeModel";

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
};

/** Drive lines through a shared state, the way the real chunked reader would. */
function runLines(lines: Array<string>, limits: MachineLimits = LIMITS): TimeEstimator {
	const state = createState();
	const estimator = new TimeEstimator(limits);
	for (const raw of lines) {
		const token = tokenise(raw);
		advance(state, token);
		estimator.line(token, state);
	}
	return estimator;
}

describe("moveTime", () => {
	it("matches the closed-form trapezoid formula for a long move from and to rest", () => {
		const v = 100; // mm/s
		const a = 500; // mm/s^2
		const d = 50; // mm
		const expected = v / a + (d - (v * v) / a) / v + v / a;
		expect(moveTime({ distance: d, nominalSpeed: v, accel: a, entrySpeed: 0, exitSpeed: 0 }))
			.toBeCloseTo(expected, 9);
	});

	it("uses the triangular peak formula for a move too short to reach nominal speed", () => {
		const v = 200;
		const a = 1000;
		const d = 1; // far too short to reach 200 mm/s at 1000 mm/s^2 (needs 20mm to reach it from rest)
		const vPeak = Math.sqrt((2 * a * d + 0 + 0) / 2);
		const expected = vPeak / a + vPeak / a;
		expect(moveTime({ distance: d, nominalSpeed: v, accel: a, entrySpeed: 0, exitSpeed: 0 }))
			.toBeCloseTo(expected, 9);
	});

	it("is zero for zero distance", () => {
		expect(moveTime({ distance: 0, nominalSpeed: 100, accel: 500, entrySpeed: 0, exitSpeed: 0 })).toBe(0);
	});

	it("is zero, not NaN, for a negative distance", () => {
		expect(moveTime({ distance: -5, nominalSpeed: 100, accel: 500, entrySpeed: 0, exitSpeed: 0 })).toBe(0);
	});

	it("falls back to d/v when acceleration is zero, rather than dividing by zero", () => {
		expect(moveTime({ distance: 50, nominalSpeed: 25, accel: 0, entrySpeed: 0, exitSpeed: 0 })).toBe(2);
		expect(Number.isFinite(moveTime({ distance: 50, nominalSpeed: 25, accel: -1, entrySpeed: 0, exitSpeed: 0 }))).toBe(true);
	});

	it("never produces a negative time when entry or exit speed exceeds nominal", () => {
		const t1 = moveTime({ distance: 10, nominalSpeed: 20, accel: 500, entrySpeed: 500, exitSpeed: 0 });
		const t2 = moveTime({ distance: 10, nominalSpeed: 20, accel: 500, entrySpeed: 0, exitSpeed: 500 });
		const t3 = moveTime({ distance: 10, nominalSpeed: 20, accel: 500, entrySpeed: 500, exitSpeed: 500 });
		expect(t1).toBeGreaterThanOrEqual(0);
		expect(t2).toBeGreaterThanOrEqual(0);
		expect(t3).toBeGreaterThanOrEqual(0);
		expect(Number.isNaN(t1)).toBe(false);
	});

	it("clamps an over-nominal entry/exit speed rather than extrapolating past it", () => {
		// Entry at 10x nominal must behave identically to entry at exactly nominal — the documented
		// approximation, not a runaway value
		const clamped = moveTime({ distance: 10, nominalSpeed: 20, accel: 500, entrySpeed: 20, exitSpeed: 0 });
		const overNominal = moveTime({ distance: 10, nominalSpeed: 20, accel: 500, entrySpeed: 200, exitSpeed: 0 });
		expect(overNominal).toBeCloseTo(clamped, 9);
	});

	it("reduces time as acceleration increases on a short move, never below the cruise floor", () => {
		const d = 5;
		const v = 100;
		const floor = d / v; // the time if the move could travel at v instantaneously
		const slow = moveTime({ distance: d, nominalSpeed: v, accel: 200, entrySpeed: 0, exitSpeed: 0 });
		const fast = moveTime({ distance: d, nominalSpeed: v, accel: 4000, entrySpeed: 0, exitSpeed: 0 });
		expect(fast).toBeLessThan(slow);
		expect(fast).toBeGreaterThanOrEqual(floor - 1e-9);
		expect(slow).toBeGreaterThanOrEqual(floor - 1e-9);
	});

	it("is zero when nominal speed is zero", () => {
		expect(moveTime({ distance: 10, nominalSpeed: 0, accel: 500, entrySpeed: 0, exitSpeed: 0 })).toBe(0);
	});

	it("a full stop at both ends is the slowest case for a given distance", () => {
		const withStops = moveTime({ distance: 20, nominalSpeed: 100, accel: 500, entrySpeed: 0, exitSpeed: 0 });
		const flowing = moveTime({ distance: 20, nominalSpeed: 100, accel: 500, entrySpeed: 50, exitSpeed: 50 });
		expect(flowing).toBeLessThan(withStops);
	});
});

describe("TimeEstimator", () => {
	it("times an XY move", () => {
		const estimator = runLines(["G1 X100 Y0 F6000"]);
		expect(estimator.elapsed).toBeGreaterThan(0);
	});

	it("accumulates across multiple moves", () => {
		const one = runLines(["G1 X50 F6000"]).elapsed;
		const two = runLines(["G1 X50 F6000", "G1 X100 F6000"]).elapsed;
		expect(two).toBeGreaterThan(one);
	});

	it("treats G0 the same as G1", () => {
		const g0 = runLines(["G0 X100 F6000"]).elapsed;
		const g1 = runLines(["G1 X100 F6000"]).elapsed;
		expect(g0).toBeCloseTo(g1, 9);
	});

	it("adds no time for a non-move command", () => {
		expect(runLines(["M104 S210", "G28"]).elapsed).toBe(0);
	});

	it("times a Z-only move against the Z limits, not the XY ones", () => {
		const estimator = runLines(["G1 Z10 F300"]);
		expect(estimator.elapsed).toBeGreaterThan(0);
		// Z's own max speed (20 mm/s = 1200 mm/min) is well below the commanded F300 mm/min = 5mm/s,
		// so this is not asserting much beyond "it used some sensible number" — the real check is
		// that it does not throw and produces a positive, finite time
		expect(Number.isFinite(estimator.elapsed)).toBe(true);
	});

	it("times an E-only relative move (a retraction) against the extruder limits", () => {
		const estimator = runLines(["M83", "G1 E-2 F1800"]);
		expect(estimator.elapsed).toBeGreaterThan(0);
	});

	it("uses the tighter of two axes when a diagonal move would exceed one of them", () => {
		const limits: MachineLimits = { ...LIMITS, maxSpeed: { ...LIMITS.maxSpeed, Y: 10 } };
		const estimator = runLines(["G1 X100 Y100 F60000"], limits);
		// A commanded 1000 mm/s diagonal must be capped by Y's 10 mm/s ceiling, not X's 200 mm/s —
		// covering ~141mm at 10 mm/s or slower takes at least ~14s
		expect(estimator.elapsed).toBeGreaterThan(10);
	});

	it("resolves a relative XY move against the running position", () => {
		const absolute = runLines(["G90", "G1 X50 F6000", "G1 X100 F6000"]).elapsed;
		const relative = runLines(["G90", "G1 X50 F6000", "G91", "G1 X50 F6000"]).elapsed;
		expect(relative).toBeCloseTo(absolute, 6);
	});

	it("is zero for a file with no moves at all", () => {
		expect(runLines(["M104 S210", "M140 S60"]).elapsed).toBe(0);
	});

	describe("arcs (task 10 finding A: an arc used to contribute zero time)", () => {
		it("times a G2/G3 arc rather than treating it as zero-duration", () => {
			// Half circle r=10 from (0,0) to (20,0) at F600 (10 mm/s): ~31.4mm of travel, so ~3s
			const estimator = runLines(["G1 X0 Y0 F600", "G3 X20 Y0 I10 J0"]);
			expect(estimator.elapsed).toBeGreaterThan(1);
		});

		it("gives a G2 and a G3 covering the same chord different times when the sweep differs", () => {
			// From (10,0): G3 to (0,10) is a short (90 degree) arc; G2 to the same point is the long
			// (270 degree) way round. Same chord, very different distance actually travelled.
			const short = runLines(["G1 X10 Y0 F600", "G3 X0 Y10 I-10 J0"]).elapsed;
			const long = runLines(["G1 X10 Y0 F600", "G2 X0 Y10 I-10 J0"]).elapsed;
			expect(long).toBeGreaterThan(short);
		});

		it("gives a full-circle arc (identical start and end point) real, non-zero time", () => {
			// The chord is exactly zero here; the move is not
			const estimator = runLines(["G1 X10 Y0 F600", "G2 X10 Y0 I-10 J0"]);
			expect(estimator.elapsed).toBeGreaterThan(1);
		});

		it("falls back to the chord for an R-format arc, rather than guessing a sweep", () => {
			// Not zero (the chord is still a real distance) but does not attempt arc-length accuracy
			const estimator = runLines(["G1 X0 Y0 F600", "G2 X20 Y0 R10"]);
			expect(estimator.elapsed).toBeGreaterThan(0);
		});

		it("times an arc against the tighter of X and Y, using both even with no net Y displacement", () => {
			const limits: MachineLimits = { ...LIMITS, maxSpeed: { ...LIMITS.maxSpeed, Y: 1 } };
			// A full circle has zero net X and Y displacement but moves through both axes throughout
			const withTightY = runLines(["G1 X10 Y0 F60000", "G2 X10 Y0 I-10 J0"], limits).elapsed;
			const withLooseY = runLines(["G1 X10 Y0 F60000", "G2 X10 Y0 I-10 J0"], LIMITS).elapsed;
			expect(withTightY).toBeGreaterThan(withLooseY);
		});
	});

	describe("lastMoveSeconds", () => {
		it("is zero before any move", () => {
			const state = createState();
			const estimator = new TimeEstimator(LIMITS);
			estimator.line(tokenise("M104 S210"), state);
			expect(estimator.lastMoveSeconds).toBe(0);
		});

		it("reports just the most recent move's own time, not the running total", () => {
			const estimator = runLines(["G1 X50 F6000", "G1 X100 F6000"]);
			expect(estimator.lastMoveSeconds).toBeLessThan(estimator.elapsed);
			expect(estimator.lastMoveSeconds).toBeGreaterThan(0);
		});

		it("drops back to zero on a line that adds no time", () => {
			const estimator = runLines(["G1 X50 F6000", "M104 S210"]);
			expect(estimator.lastMoveSeconds).toBe(0);
		});

		it("sums across every line to the running total", () => {
			const state = createState();
			const estimator = new TimeEstimator(LIMITS);
			const lines = ["G1 X50 F6000", "G1 X100 F6000", "G1 Z5 F300"];
			let sum = 0;
			for (const raw of lines) {
				const token = tokenise(raw);
				advance(state, token);
				estimator.line(token, state);
				sum += estimator.lastMoveSeconds;
			}
			expect(sum).toBeCloseTo(estimator.elapsed, 9);
		});
	});

	describe("clamping report", () => {
		it("matches unclamped when every move is within limits, and clamps nothing", () => {
			const estimator = runLines(["G1 X100 Y0 F1200"]); // 20 mm/s, well under X's 200 mm/s limit
			expect(estimator.clampedSeconds).toBeCloseTo(estimator.unclampedSeconds, 6);
			expect(estimator.clampedMoveCount).toBe(0);
		});

		it("takes measurably longer clamped than unclamped when a move asks for double the limit", () => {
			// X's own limit is 200 mm/s (12000 mm/min); ask for double that
			const estimator = runLines(["G1 X1000 F24000"]);
			expect(estimator.clampedSeconds).toBeGreaterThan(estimator.unclampedSeconds);
			expect(estimator.clampedMoveCount).toBe(1);
		});

		it("counts moves, not lines — a non-move line never increments the count", () => {
			const estimator = runLines(["G1 X1000 F24000", "M104 S210", "G28"]);
			expect(estimator.clampedMoveCount).toBe(1);
		});

		it("clamps an X-only move against X's own limit, not the tighter of X and Y", () => {
			const limits: MachineLimits = { ...LIMITS, maxSpeed: { ...LIMITS.maxSpeed, Y: 1 } };
			// X-only, well within X's 200 mm/s limit; Y's tiny limit must not apply since Y never moved
			const estimator = runLines(["G1 X100 F6000"], limits);
			expect(estimator.clampedMoveCount).toBe(0);
		});

		it("unclampedSeconds ignores this machine's limits entirely", () => {
			const tight: MachineLimits = { ...LIMITS, maxSpeed: { ...LIMITS.maxSpeed, X: 1 } };
			const loose = runLines(["G1 X100 F6000"], LIMITS).unclampedSeconds;
			const withTightLimit = runLines(["G1 X100 F6000"], tight).unclampedSeconds;
			expect(withTightLimit).toBeCloseTo(loose, 6);
		});
	});
});
