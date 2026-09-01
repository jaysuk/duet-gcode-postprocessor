import { describe, expect, it } from "vitest";

import { analyseText } from "../model/analysis";
import { restartFromStep, type RestartFromConfig } from "../model/steps/restartFrom";
import type { StepFactoryContext } from "../model/steps/types";
import { runStepsWithAnalysis } from "./helpers";

const FIXTURE = [
	"G28",
	"T0",
	"M104 S200",
	"M140 S60",
	"M190 S60",
	"M109 S200",
	"G90",
	"M83",
	";LAYER_CHANGE",
	"G1 Z0.2 F600",
	"G1 X10 Y10 E1 F1200",
	"M106 S255",
	";LAYER_CHANGE",
	"T1",
	"M104 T1 S210",
	"M486 S0 A\"Cube\"",
	"G1 Z0.4 F600",
	"G1 X20 Y20 E1 F1200",
	";LAYER_CHANGE",
	"G1 Z0.6 F600",
	"G1 X30 Y30 E1 F1200",
].join("\n");

function run(overrides: Partial<RestartFromConfig>, input: string) {
	const config: RestartFromConfig = {
		cutLayer: 2, rehomeZ: false, liftMm: 5,
		liftFeedrateMmPerMin: 600, travelFeedrateMmPerMin: 3000, descendFeedrateMmPerMin: 300,
		...overrides,
	};
	const ctx: StepFactoryContext = { scriptsTrusted: true, stepIndex: 0 };
	const transform = restartFromStep.create(config, ctx);
	const collectors = restartFromStep.analysis?.(config, ctx) ?? [];
	return runStepsWithAnalysis([transform], collectors, input);
}

describe("restartFrom", () => {
	it("restores the tool active at the cut, not tool 0", () => {
		const { output } = run({}, FIXTURE);
		expect(output.split("\n")).toContain("T1");
	});

	it("restores bed and tool temperatures as last commanded, heating the bed before the tool", () => {
		const { output } = run({}, FIXTURE);
		const lines = output.split("\n");
		const bedLine = lines.findIndex((l) => l.startsWith("M140"));
		const toolLine = lines.findIndex((l) => l.startsWith("M104"));
		expect(bedLine).toBeGreaterThanOrEqual(0);
		expect(toolLine).toBeGreaterThan(bedLine);
		expect(lines).toContain("M140 S60");
		expect(lines).toContain("M104 T1 S210");
		expect(lines.some((l) => l.startsWith("M190"))).toBe(true);
		expect(lines.some((l) => l.startsWith("M116 P1"))).toBe(true);
	});

	it("emits G92 E<value> in absolute-E mode, restoring the E position at the cut", () => {
		// M83 makes the fixture relative-E; use an absolute-E variant here
		const absolute = FIXTURE.replace("M83", "M82").replace(/E1/g, "E3"); // absolute E, growing by 3 each move
		const { output } = run({}, absolute);
		expect(output).toMatch(/G92 E3(\.0+)?\b/);
	});

	it("emits no G92 E at all in relative-E mode", () => {
		const { output } = run({}, FIXTURE); // M83 in the fixture
		expect(output).not.toContain("G92 E");
	});

	it("restores M82/M83 and G90/G91 as they were at the cut", () => {
		const { output } = run({}, FIXTURE);
		const lines = output.split("\n");
		expect(lines).toContain("G90");
		expect(lines).toContain("M83");
	});

	it("the first motion after the preamble lifts, then travels in XY, then descends, in that order", () => {
		const { output } = run({}, FIXTURE);
		const moveLines = output.split("\n").filter((l) => /^G1 /.test(l));
		const lift = moveLines.findIndex((l) => /^G1 Z[\d.]+ F600$/.test(l));
		const travel = moveLines.findIndex((l) => /^G1 X20 Y20 F3000$/.test(l));
		const descend = moveLines.findIndex((l) => /^G1 Z0\.4 F300$/.test(l));
		expect(lift).toBeGreaterThanOrEqual(0);
		expect(travel).toBeGreaterThan(lift);
		expect(descend).toBeGreaterThan(travel);
	});

	it("never emits G28 Z unless the opt-in is set", () => {
		const { output } = run({}, FIXTURE);
		expect(output).not.toContain("G28");
	});

	it("emits G28 Z when the opt-in is set", () => {
		const { output } = run({ rehomeZ: true }, FIXTURE);
		expect(output.split("\n")).toContain("G28 Z");
	});

	it("restores the fan speed in force at the cut", () => {
		const { output } = run({}, FIXTURE);
		expect(output.split("\n")).toContain("M106 P0 S255");
	});

	it("names the M486 object active at the cut in the preamble", () => {
		const { output } = run({}, FIXTURE);
		expect(output.split("\n")).toContain("M486 S0 A\"Cube\"");
	});

	it("a cut at layer 0 degenerates to the whole file — the preamble faithfully replaces the dropped start block", () => {
		// Everything before the first ;LAYER_CHANGE is layer -1 (before layer 0 exists at all), so
		// cutting at layer 0 makes the *entire* start block "state before the cut" — the preamble
		// should reconstruct exactly what that start block set up, not invent or omit anything.
		const { output } = run({ cutLayer: 0 }, FIXTURE);
		const lines = output.split("\n");
		expect(lines).toContain("T0");
		expect(lines).toContain("M140 S60");
		expect(lines).toContain("M104 T0 S200");
		expect(lines).toContain("M83");
		// The source's own start block itself (G28, and the ORIGINAL un-generated T0/M104/etc. lines)
		// is still gone — only the generated preamble's equivalents remain
		expect(output).not.toContain("G28");
		expect(lines.filter((l) => l === "T0")).toHaveLength(1); // the preamble's, not a duplicate
		expect(output).toContain("G1 X10 Y10 E1 F1200"); // layer 0's own content survives untouched
	});

	it("drops the source's own start block entirely", () => {
		const { output } = run({}, FIXTURE);
		expect(output).not.toContain("G28\n");
		expect(output.split("\n").filter((l) => l === "T0")).toEqual([]);
	});

	it("reports and produces only the preamble when the cut layer is beyond the file", () => {
		const { output, pipeline } = run({ cutLayer: 99 }, FIXTURE);
		expect(pipeline.stats.warnings.some((w) => w.includes("No lines were found"))).toBe(true);
		expect(output.split("\n").some((l) => /^G1 X\d+ Y\d+ E1/.test(l))).toBe(false);
	});

	it("acceptance: read back through Analyser, the output reports the same tool, mode and temperatures as the source at the cut", () => {
		const { output } = run({}, FIXTURE);
		const analysis = analyseText(output);
		expect(analysis.tools).toContain(1); // the tool active at the cut
		expect(analysis.usesRelativeE).toBe(true); // M83 was in force at the cut
		expect(analysis.maxToolTemp).toBe(210); // T1's restored temperature
		expect(analysis.maxBedTemp).toBe(60);
	});
});
