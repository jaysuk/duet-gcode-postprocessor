import { describe, expect, it } from "vitest";

import { defaultConfig } from "../model/steps/registry";
import { timelapseTopLayerStep } from "../model/steps/timelapseTopLayer";
import type { StepFactoryContext } from "../model/steps/types";
import { runStepsWithAnalysis } from "./helpers";

function run(input: string, config: Record<string, unknown> = {}, ctx: StepFactoryContext = { scriptsTrusted: true }) {
	const stepConfig = { ...defaultConfig("timelapseTopLayer"), ...config };
	const transform = timelapseTopLayerStep.create(stepConfig as never, ctx);
	const collectors = timelapseTopLayerStep.analysis?.(stepConfig as never, ctx) ?? [];
	return runStepsWithAnalysis([transform], collectors, input);
}

const CALL = 'M98 P"0:/macros/timelapse.g"';

describe("timelapseTopLayer", () => {
	it("fires exactly twice for two objects that finish on different layers", () => {
		// Object 0's last extrusion is under the layer-1 marker (top layer 1); object 1 keeps going
		// into layer 2, the file's own last layer (top layer 2).
		const input = [
			"M83",
			";LAYER_CHANGE", // layer 0
			"M486 S0", "G1 X0 Y0 E1 F1200",
			"M486 S1", "G1 X10 Y10 E1 F1200",
			";LAYER_CHANGE", // layer 1 -- object 0's last extrusion is in this section
			"M486 S0", "G1 X0 Y1 E1 F1200",
			"M486 S1", "G1 X10 Y11 E1 F1200",
			";LAYER_CHANGE", // layer 2 -- object 0 has nothing more; object 1 keeps going
			"M486 S1", "G1 X10 Y12 E1 F1200",
		].join("\n");

		const { output } = run(input);
		const lines = output.split("\n");
		const callIndexes = lines.reduce<Array<number>>((acc, l, i) => (l === CALL ? [...acc, i] : acc), []);
		expect(callIndexes).toHaveLength(2);

		// First call: right after the layer-2 marker (object 0's own top layer, layer 1, just ended)
		// -- all 3 markers precede it, since object 0's own last extrusion is in the layer-1 section
		expect(lines[callIndexes[0] - 1]).toBe(";LAYER_CHANGE");
		expect(lines.slice(0, callIndexes[0]).filter((l) => l === ";LAYER_CHANGE")).toHaveLength(3);

		// Second call: at the very end of the file (object 1's top layer, layer 2, is the file's last
		// — there is no further layer-change event to catch it on, so onEnd must supply it)
		expect(callIndexes[1]).toBe(lines.length - 1);
	});

	it("fires zero times, and warns, for a file with no M486 labels at all", () => {
		const input = [";LAYER_CHANGE", "G1 X0 Y0 E1 F1200", ";LAYER_CHANGE", "G1 X10 Y10 E1 F1200"].join("\n");
		const { output, pipeline } = run(input);
		expect(output).toBe(input);
		expect(pipeline.stats.warnings.some((w) => w.includes("no M486 object labels"))).toBe(true);
	});

	it("fires once, not once per object, when several objects share the same top layer", () => {
		const input = [
			"M83",
			";LAYER_CHANGE",
			"M486 S0", "G1 X0 Y0 E1 F1200",
			"M486 S1", "G1 X10 Y10 E1 F1200",
			";LAYER_CHANGE", // both objects' last layer
			"M486 S0", "G1 X0 Y1 E1 F1200",
			"M486 S1", "G1 X10 Y11 E1 F1200",
		].join("\n");
		const { output } = run(input);
		expect(output.split("\n").filter((l) => l === CALL)).toHaveLength(1);
	});

	it("does not treat a non-extruding move under an object as reaching a new top layer", () => {
		// Object 0 only travels (no E) on layer 1 -- its real top layer is still 0
		const input = [
			"M83",
			";LAYER_CHANGE",
			"M486 S0", "G1 X0 Y0 E1 F1200",
			";LAYER_CHANGE",
			"M486 S0", "G1 X50 Y50 F6000", // travel only, no extrusion
		].join("\n");
		const { output } = run(input);
		// The call must land after the FIRST layer change (top layer 0), not only at file end
		const lines = output.split("\n");
		expect(lines.indexOf(CALL)).toBeGreaterThan(0);
		expect(lines.indexOf(CALL)).toBeLessThan(lines.length - 1);
	});

	it("two instances of this step in one recipe do not collide on the same collector key", () => {
		const input = [
			";LAYER_CHANGE",
			"M486 S0", "G1 X0 Y0 E1 F1200",
			";LAYER_CHANGE",
			"M486 S0", "G1 X0 Y1 E1 F1200",
		].join("\n");

		const ctxA: StepFactoryContext = { scriptsTrusted: true, stepIndex: 0 };
		const ctxB: StepFactoryContext = { scriptsTrusted: true, stepIndex: 1 };
		const configA = { ...defaultConfig("timelapseTopLayer"), macroPath: "0:/macros/a.g" };
		const configB = { ...defaultConfig("timelapseTopLayer"), macroPath: "0:/macros/b.g" };

		const transformA = timelapseTopLayerStep.create(configA as never, ctxA);
		const transformB = timelapseTopLayerStep.create(configB as never, ctxB);
		const collectors = [
			...(timelapseTopLayerStep.analysis?.(configA as never, ctxA) ?? []),
			...(timelapseTopLayerStep.analysis?.(configB as never, ctxB) ?? []),
		];
		const { output } = runStepsWithAnalysis([transformA, transformB], collectors, input);

		expect(output).toContain('M98 P"0:/macros/a.g"');
		expect(output).toContain('M98 P"0:/macros/b.g"');
	});
});
