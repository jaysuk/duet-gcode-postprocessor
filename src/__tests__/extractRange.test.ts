import { describe, expect, it } from "vitest";

import { extractRangeStep } from "../model/steps/extractRange";
import { makeStep, runStep, runSteps } from "./helpers";

/** `layers` layers, each one `;LAYER_CHANGE` marker plus a Z move and one identifiable XY move. */
function fixture(layers: number): string {
	const lines: Array<string> = ["G28", "G90", "M83"];
	for (let i = 0; i < layers; i++) {
		lines.push(";LAYER_CHANGE", `G1 Z${(i * 0.2).toFixed(1)} F600`, `G1 X${10 + i} Y10 E1 F1200`);
	}
	return lines.join("\n");
}

describe("extractRange", () => {
	it("extracts exactly the requested layer range, nothing from outside it", () => {
		const output = runStep("extractRange", { layerFrom: 5, layerTo: 10 }, fixture(20));
		expect(output).not.toContain("X14 "); // layer 4
		expect(output).not.toContain("X21 "); // layer 11
		expect(output).toContain("X15 "); // layer 5 (first kept)
		expect(output).toContain("X20 "); // layer 10 (last kept)
		expect(output.split("\n").filter((l) => l === ";LAYER_CHANGE")).toHaveLength(6);
	});

	it("carries a generated preamble and drops the source's own start block", () => {
		const output = runStep("extractRange", { layerFrom: 5, layerTo: 10 }, fixture(20));
		expect(output).not.toContain("G28");
		expect(output).not.toContain("M83");
		expect(output.split("\n")[0]).toMatch(/^; --- Extracted/);
	});

	it("from beyond the file's layer count produces an empty body and a warning, not a crash", () => {
		const { output, pipeline } = runSteps([makeStep("extractRange", { layerFrom: 50, layerTo: 60 })], fixture(20));
		const body = output.split("\n").filter((l) => !l.startsWith(";"));
		expect(body).toEqual([]);
		expect(pipeline.stats.warnings.some((w) => w.includes("empty"))).toBe(true);
	});

	it("a file with no layer markers still extracts, and warns that layers were inferred", () => {
		const noMarkers = [
			"G28", "G90", "M83",
			"G1 Z0.2 F600", "G1 X10 Y10 E1",
			"G1 Z0.4 F600", "G1 X20 Y10 E1",
		].join("\n");
		const { output, pipeline } = runSteps([makeStep("extractRange", { layerFrom: 0, layerTo: 0 })], noMarkers);
		expect(output).toContain("X10 Y10 E1");
		expect(output).not.toContain("X20 Y10 E1");
		expect(pipeline.stats.warnings.some((w) => w.includes("inferred"))).toBe(true);
	});

	it("a single-layer extraction works", () => {
		const output = runStep("extractRange", { layerFrom: 5, layerTo: 5 }, fixture(20));
		expect(output.split("\n").filter((l) => l === ";LAYER_CHANGE")).toHaveLength(1);
		expect(output).toContain("X15 ");
		expect(output).not.toContain("X16 ");
	});

	it("rejects layerFrom after layerTo", () => {
		expect(extractRangeStep.validate?.({ layerFrom: 10, layerTo: 5 })).toEqual([
			"From layer must not be after to layer",
		]);
	});

	it("accepts the -1 (unbounded) sentinel on either side without flagging it", () => {
		expect(extractRangeStep.validate?.({ layerFrom: -1, layerTo: 5 })).toEqual([]);
		expect(extractRangeStep.validate?.({ layerFrom: 5, layerTo: -1 })).toEqual([]);
	});

	it("does not warn about an empty result on a range that legitimately matches something", () => {
		const { pipeline } = runSteps([makeStep("extractRange", { layerFrom: 0, layerTo: -1 })], fixture(3));
		expect(pipeline.stats.warnings.some((w) => w.includes("empty"))).toBe(false);
	});
});
