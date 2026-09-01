import { describe, expect, it } from "vitest";

import { objectLabelsStep } from "../model/steps/objectLabels";
import type { StepFactoryContext } from "../model/steps/types";
import { runStepsWithAnalysis } from "./helpers";

function run(input: string, ctx: StepFactoryContext = { scriptsTrusted: true }) {
	const transform = objectLabelsStep.create({}, ctx);
	const collectors = objectLabelsStep.analysis?.({}, ctx) ?? [];
	return runStepsWithAnalysis([transform], collectors, input);
}

describe("objectLabels", () => {
	it("converts a define/start/end triple to correct M486", () => {
		const input = [
			"EXCLUDE_OBJECT_DEFINE NAME=Cube CENTER=10,10 POLYGON=[[0,0],[20,0],[20,20],[0,20]]",
			"EXCLUDE_OBJECT_START NAME=Cube",
			"G1 X10 Y10 E1",
			"EXCLUDE_OBJECT_END NAME=Cube",
		].join("\n");
		const { output } = run(input);
		const lines = output.split("\n");
		expect(lines).toEqual([
			"M486 S0 A\"Cube\"",
			"G1 X10 Y10 E1",
			"M486 S-1",
		]);
	});

	it("gives the same name the same index if it is started more than once", () => {
		const input = [
			"EXCLUDE_OBJECT_START NAME=Cube",
			"EXCLUDE_OBJECT_END NAME=Cube",
			"EXCLUDE_OBJECT_START NAME=Sphere",
			"EXCLUDE_OBJECT_END NAME=Sphere",
			"EXCLUDE_OBJECT_START NAME=Cube",
			"EXCLUDE_OBJECT_END NAME=Cube",
		].join("\n");
		const { output } = run(input);
		const starts = output.split("\n").filter((l) => l.startsWith("M486 S") && l.includes("A"));
		expect(starts[0]).toBe("M486 S0 A\"Cube\"");
		expect(starts[1]).toBe("M486 S1 A\"Sphere\"");
		expect(starts[2]).toBe("M486 S0 A\"Cube\""); // same name, same index as before
	});

	it("converts EXCLUDE_OBJECT_END to M486 S-1 regardless of its own NAME", () => {
		const { output } = run("EXCLUDE_OBJECT_END NAME=Cube");
		expect(output).toBe("M486 S-1");
	});

	it("drops EXCLUDE_OBJECT_DEFINE entirely — RRF's M486 has no separate define step", () => {
		const { output } = run("EXCLUDE_OBJECT_DEFINE NAME=Cube CENTER=10,10");
		expect(output).toBe("");
	});

	it("registers a DEFINE's name so a later START gets the same index without redefining", () => {
		const input = [
			"EXCLUDE_OBJECT_DEFINE NAME=Cube CENTER=10,10",
			"EXCLUDE_OBJECT_DEFINE NAME=Sphere CENTER=20,20",
			"EXCLUDE_OBJECT_START NAME=Sphere",
		].join("\n");
		const { output } = run(input);
		expect(output).toBe("M486 S1 A\"Sphere\"");
	});

	it("leaves a file that already uses M486 completely untouched, and warns instead of double-labelling", () => {
		const input = [
			"M486 S0 A\"Existing\"",
			"G1 X10 E1",
			"EXCLUDE_OBJECT_START NAME=Cube", // a hypothetical mixed file — must not be converted either
		].join("\n");
		const { output, pipeline } = run(input);
		expect(output).toBe(input);
		expect(pipeline.stats.warnings.some((w) => w.includes("already uses M486"))).toBe(true);
	});

	it("respects the collector's own stepIndex namespacing (does not silently no-op in a real recipe)", () => {
		// Regression: the collector must be registered and looked up under the SAME (namespaced) key.
		// A mismatch here would make hasExistingM486 always read as false, silently disabling the
		// "never touch a file that already uses M486" guard in every real (indexed) recipe run.
		const ctx: StepFactoryContext = { scriptsTrusted: true, stepIndex: 2 };
		const input = ["M486 S0 A\"Existing\"", "EXCLUDE_OBJECT_START NAME=Cube"].join("\n");
		const { output } = run(input, ctx);
		expect(output).toBe(input);
	});

	it("reports an unresolved EXCLUDE_OBJECT_START with no NAME, and leaves it untouched", () => {
		const { output, pipeline } = run("EXCLUDE_OBJECT_START");
		expect(output).toBe("EXCLUDE_OBJECT_START");
		expect(pipeline.stats.warnings.some((w) => w.includes("no"))).toBe(true);
	});

	it("is byte-identical for a file with no object markers at all", () => {
		const input = ["G28", "G1 X10 E1"].join("\n");
		const { output } = run(input);
		expect(output).toBe(input);
	});

	it("un-escapes a quoted NAME containing a space", () => {
		const { output } = run("EXCLUDE_OBJECT_START NAME=\"Left Bracket\"");
		expect(output).toBe("M486 S0 A\"Left Bracket\"");
	});
});
