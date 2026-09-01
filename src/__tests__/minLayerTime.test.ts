import { describe, expect, it } from "vitest";

import { analyseText } from "../model/analysis";
import type { MachineLimits } from "../model/gcode/timeModel";
import { minLayerTimeStep, type MinLayerTimeConfig } from "../model/steps/minLayerTime";
import { getStepDefinition } from "../model/steps/registry";
import { withDefaults, type StepFactoryContext } from "../model/steps/types";
import { runStepsWithAnalysis } from "./helpers";

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
};

// Layer 0: a long enough move (200mm) to be cruise-dominated, so slowing it scales its time close
// to linearly — clamped to ~2.07s at F6000. Layer 1: much slower already (X1000 at F1200), well
// above any target used below, to prove an already-slow layer is left alone.
const FIXTURE = [
	";LAYER_CHANGE",
	"G1 X200 F6000",
	";LAYER_CHANGE",
	"G1 X1000 F1200",
].join("\n");

function run(overrides: Partial<MinLayerTimeConfig>, input: string, limits: MachineLimits | "none" = LIMITS) {
	const def = getStepDefinition("minLayerTime")!;
	const config = { ...withDefaults(def, {}), ...overrides } as MinLayerTimeConfig;
	const ctx: StepFactoryContext = { scriptsTrusted: true, machineLimits: limits === "none" ? undefined : limits };
	const transform = minLayerTimeStep.create(config, ctx);
	const collectors = minLayerTimeStep.analysis?.(config, ctx) ?? [];
	return runStepsWithAnalysis([transform], collectors, input);
}

describe("minLayerTime", () => {
	describe("slow", () => {
		it("slows a layer clamped faster than the target", () => {
			const { output } = run({ minSeconds: 4 }, FIXTURE);
			expect(output.split("\n")[1]).not.toBe("G1 X200 F6000");
		});

		it("leaves an already-slow layer byte-identical", () => {
			const { output } = run({ minSeconds: 4 }, FIXTURE);
			expect(output.split("\n")[3]).toBe("G1 X1000 F1200");
		});

		it("is entirely byte-identical when every layer already meets the target", () => {
			const { output, pipeline } = run({ minSeconds: 0.001 }, FIXTURE);
			expect(output).toBe(FIXTURE);
			expect(pipeline.stats.warnings).toEqual([]);
		});

		it("the slowed layer's recomputed duration meets the target", () => {
			const { output } = run({ minSeconds: 4 }, FIXTURE);
			// Re-measure the OUTPUT with the same limits (using task 12 §1's own per-layer stats as
			// the oracle) rather than hand-deriving an expected F from the trapezoid formula. The
			// scaling is an approximation (module comment), so this allows a small margin.
			const after = analyseText(output, undefined, LIMITS);
			const layer0 = after.slowestLayers.find((l) => l.layer === 0);
			expect(layer0?.seconds).toBeGreaterThanOrEqual(4 - 0.3);
		});

		it("never slows below the configured floor, and reports the layer instead of mangling it", () => {
			// An unreachable target: even the floor cannot make a 200mm move take 1000 seconds
			const { output, pipeline } = run({ minSeconds: 1000, minFeedrateMmPerMin: 300 }, FIXTURE);
			expect(output.split("\n")[1]).toBe("G1 X200 F300");
			expect(pipeline.stats.warnings.some((w) => w.includes("could not reach"))).toBe(true);
		});

		it("stamps an explicit F onto a move that inherited its feedrate, rather than leaving it untouched", () => {
			const fixture = [";LAYER_CHANGE", "G1 X200 F6000", "G1 X210"].join("\n");
			const { output } = run({ minSeconds: 4 }, fixture);
			const lines = output.split("\n");
			expect(lines[2]).not.toBe("G1 X210");
			expect(lines[2]).toMatch(/F\d+/);
		});

		it("reports how many moves and layers were slowed", () => {
			const { pipeline } = run({ minSeconds: 4 }, FIXTURE);
			expect(pipeline.stats.warnings.some((w) => /Slowed 1 move across 1 layer/.test(w))).toBe(true);
		});
	});

	describe("dwell", () => {
		it("leaves the original move untouched and inserts a park move plus a G4 before the next layer", () => {
			const { output } = run({ method: "dwell", minSeconds: 4, parkX: 100, parkY: 80 }, FIXTURE);
			const lines = output.split("\n");
			expect(lines[1]).toBe("G1 X200 F6000"); // never touches F
			expect(lines[2]).toBe("G1 X100 Y80");
			expect(lines[3]).toMatch(/^G4 P\d+$/);
			expect(lines[4]).toBe(";LAYER_CHANGE");
		});

		it("flushes a trailing dwell for the last layer in the file, via onEnd", () => {
			// Both layers move somewhere new (X5 then X10 — never a zero-length second move), and
			// both are short, so the last one — which never sees a following layer-change line to
			// trigger on — must still get its dwell, from onEnd
			const fixture = [";LAYER_CHANGE", "G1 X5 F6000", ";LAYER_CHANGE", "G1 X10 F6000"].join("\n");
			const { output } = run({ method: "dwell", minSeconds: 0.5 }, fixture);
			const lines = output.split("\n");
			expect(lines[lines.length - 1]).toMatch(/^G4 P\d+$/);
		});

		it("never rewrites F in dwell mode, even on a fast layer", () => {
			const { output } = run({ method: "dwell", minSeconds: 4 }, FIXTURE);
			expect(output).toContain("G1 X200 F6000");
		});
	});

	it("is a no-op with no machine limits, and says so", () => {
		const { output, pipeline } = run({}, FIXTURE, "none");
		expect(output).toBe(FIXTURE);
		expect(pipeline.stats.warnings.some((w) => w.includes("not available"))).toBe(true);
	});
});
