import { describe, expect, it } from "vitest";

import { clampFeedrateStep, type ClampFeedrateConfig } from "../model/steps/clampFeedrate";
import type { MachineLimits } from "../model/gcode/timeModel";
import { getStepDefinition } from "../model/steps/registry";
import { withDefaults } from "../model/steps/types";
import { runSteps } from "./helpers";

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
};

// Goes through the registry's own (erased-generic) definition for defaults, the way `helpers.ts`'s
// `makeStep` does — the concretely-typed `clampFeedrateStep` export does not structurally satisfy
// `withDefaults`'s `Record<string, unknown>` parameter, since an `interface` config type has no
// index signature of its own.
function run(overrides: Partial<ClampFeedrateConfig>, input: string, limits: MachineLimits | "none" = LIMITS) {
	const def = getStepDefinition("clampFeedrate")!;
	const config = { ...withDefaults(def, {}), ...overrides } as ClampFeedrateConfig;
	const transform = clampFeedrateStep.create(config, { scriptsTrusted: true, machineLimits: limits === "none" ? undefined : limits });
	return runSteps([transform], input);
}

describe("clampFeedrate", () => {
	it("rewrites a move above the limit down to it", () => {
		// X's limit is 200 mm/s = 12000 mm/min; ask for double that
		const { output } = run({}, "G1 X100 F24000");
		expect(output).toBe("G1 X100 F12000");
	});

	it("leaves a move already within the limit byte-identical", () => {
		const input = "G1 X100 F6000";
		const { output } = run({}, input);
		expect(output).toBe(input);
	});

	it("clamps an X-only move against X's own limit, not the tighter of X and Y", () => {
		const tightY: MachineLimits = { ...LIMITS, maxSpeed: { ...LIMITS.maxSpeed, Y: 1 } };
		const input = "G1 X100 F6000"; // 100 mm/s, within X's 200 mm/s but far above Y's 1 mm/s
		const { output } = run({}, input, tightY);
		expect(output).toBe(input);
	});

	it("clamps a diagonal move to the tighter of the two axes involved", () => {
		const tightY: MachineLimits = { ...LIMITS, maxSpeed: { ...LIMITS.maxSpeed, Y: 10 } };
		const { output } = run({}, "G1 X100 Y100 F60000", tightY);
		expect(output).toBe("G1 X100 Y100 F600");
	});

	it("only clamps printing moves when applyToMoves is \"printing\"", () => {
		const travel = "G1 X100 F24000";
		const printing = "G1 X200 Y0 E5 F24000";
		const { output } = run({ applyToMoves: "printing" }, [travel, printing].join("\n"));
		const lines = output.split("\n");
		expect(lines[0]).toBe(travel); // travel move left alone
		expect(lines[1]).not.toBe(printing); // printing move clamped
	});

	it("only clamps travel moves when applyToMoves is \"travel\"", () => {
		const travel = "G1 X100 F24000";
		const printing = "G1 X200 Y0 E5 F24000";
		const { output } = run({ applyToMoves: "travel" }, [travel, printing].join("\n"));
		const lines = output.split("\n");
		expect(lines[0]).not.toBe(travel); // travel move clamped
		expect(lines[1]).toBe(printing); // printing move left alone
	});

	it("is byte-identical for a file needing no clamping, and says so in the report", () => {
		const input = ["G28", "G1 X10 Y10 F6000", "G1 X20 Y20 F6000"].join("\n");
		const { output, pipeline } = run({}, input);
		expect(output).toBe(input);
		expect(pipeline.stats.warnings).toEqual([]);
	});

	it("reports how many moves were clamped", () => {
		const { pipeline } = run({}, ["G1 X100 F24000", "G1 X0 F24000"].join("\n"));
		expect(pipeline.stats.warnings.some((w) => w.includes("Clamped 2 moves"))).toBe(true);
	});

	it("does nothing, and warns, when this machine's limits are not available", () => {
		const input = "G1 X100 F24000";
		const { output, pipeline } = run({}, input, "none");
		expect(output).toBe(input);
		expect(pipeline.stats.warnings.some((w) => w.includes("not available"))).toBe(true);
	});

	it("clamps a Z-only move against Z's own limit (task 10 finding D)", () => {
		// Z's limit is 20 mm/s = 1200 mm/min
		const { output } = run({}, "G1 Z10 F30000");
		expect(output).toBe("G1 Z10 F1200");
	});

	it("clamps an E-only move against E's own limit, gated by applyToMoves like any other move", () => {
		// E's limit is 50 mm/s = 3000 mm/min; a retraction (negative E) is a travel move
		const input = ["M83", "G1 E-5 F30000"].join("\n");
		const { output } = run({ applyToMoves: "printing" }, input);
		expect(output.split("\n")[1]).toBe(input.split("\n")[1]); // retraction is travel, not printing: untouched
		const clamped = run({ applyToMoves: "travel" }, input).output;
		expect(clamped.split("\n")[1]).toBe("G1 E-5 F3000");
	});

	it("leaves a move already at exactly Z's or E's limit byte-identical", () => {
		const input = ["G1 Z10 F1200", "M83", "G1 E-5 F3000"].join("\n");
		const { output } = run({}, input);
		expect(output).toBe(input);
	});

	it("tracks G92 as an absolute position set, not a move to clamp (task 10 finding C)", () => {
		const input = ["G92 X0 Y0 E0", "G1 X10 F24000"].join("\n");
		const { output } = run({}, input);
		expect(output.split("\n")[0]).toBe("G92 X0 Y0 E0"); // never rewritten
		expect(output.split("\n")[1]).toBe("G1 X10 F12000"); // still correctly clamped afterwards
	});

	it("keeps tracking extrusion across a G92 E0, as an absolute-E file emits constantly", () => {
		const input = ["M82", "G1 X10 E5 F24000", "G92 E0", "G1 X20 E0.5 F24000"].join("\n");
		const out = run({ applyToMoves: "printing" }, input).output.split("\n");
		// Both moves extrude and both are above X's 12000 mm/min limit
		expect([out[1], out[3]]).toEqual(["G1 X10 E5 F12000", "G1 X20 E0.5 F12000"]);
	});

	it("G92 sets a tracked axis absolutely even under G91, not by adding to the current position", () => {
		const input = ["G90", "G1 X50 F1200", "G91", "G92 X0", "G90", "G1 X50 F24000"].join("\n");
		const { output } = run({}, input);
		// Correct: G92 resets X to 0 regardless of the active G91, so the final absolute move to X50
		// is a real 50mm move and gets clamped. If G92 wrongly went through the relative-move path
		// (current + value = 50 + 0 = 50, unchanged), the final move would compute a zero-length dx
		// against the stale X50 and be left untouched at F24000 — a real move silently not clamped.
		expect(output.split("\n")[5]).toBe("G1 X50 F12000");
	});

	describe("alsoClampAcceleration", () => {
		it("leaves M204 alone by default", () => {
			const input = "M204 P5000 T5000";
			const { output } = run({}, input);
			expect(output).toBe(input);
		});

		it("clamps M204 P/T down to this machine's configured acceleration when enabled", () => {
			const { output } = run({ alsoClampAcceleration: true }, "M204 P5000 T5000");
			expect(output).toBe("M204 P1000 T1500");
		});

		it("leaves an M204 already within limits byte-identical", () => {
			const input = "M204 P500 T800";
			const { output } = run({ alsoClampAcceleration: true }, input);
			expect(output).toBe(input);
		});
	});
});
