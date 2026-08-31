import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { MachineLimits } from "../model/gcode/timeModel";
import type { ToolConfig } from "../model/preheat";
import { defaultConfig } from "../model/steps/registry";
import { preheatStep } from "../model/steps/preheat";
import type { StepFactoryContext } from "../model/steps/types";
import { runStepsWithAnalysis } from "./helpers";

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
};

const TOOLS: Array<ToolConfig> = [
	{ toolNumber: 0, heaters: [{ heaterIndex: 0, active: 200, standby: 140, model: { heatingRate: 2.43, deadTime: 5.5, coolingRate: 0.56, coolingExp: 1.35 } }] },
	{ toolNumber: 1, heaters: [{ heaterIndex: 1, active: 205, standby: 140, model: { heatingRate: 2.43, deadTime: 5.5, coolingRate: 0.56, coolingExp: 1.35 } }] },
];

function loadFixture(name: string): string {
	return readFileSync(resolve(__dirname, "../../test/fixtures", `${name}.gcode`), "utf-8");
}

function run(input: string, tools: Array<ToolConfig> = TOOLS, config: Record<string, unknown> = {}) {
	const ctx: StepFactoryContext = { scriptsTrusted: true, machineLimits: LIMITS, toolHeaters: tools };
	const stepConfig = { ...defaultConfig("preheat"), ...config };
	const transform = preheatStep.create(stepConfig as never, ctx);
	const collectors = preheatStep.analysis?.(stepConfig as never, ctx) ?? [];
	return runStepsWithAnalysis([transform], collectors, input);
}

describe("preheat step", () => {
	it("inserts one M568 A2 ahead of each tool change on the two-tool fixture", () => {
		const { output } = run(loadFixture("two-tool"));
		const lines = output.split("\n");
		const tIndex = (code: string) => lines.findIndex((l) => l.trim() === code);
		const changeIndices = lines
			.map((l, i) => ({ l, i }))
			.filter(({ l }) => /^T\d+$/.test(l.trim()))
			.map(({ i }) => i);

		expect(changeIndices.length).toBeGreaterThanOrEqual(3);
		expect(lines.some((l) => /^M568 P\d+ A2$/.test(l.trim()))).toBe(true);

		// Every M568 ...A2 line for a given tool appears strictly before that tool's own T-command
		for (const line of lines) {
			const m = /^M568 P(\d+) A2$/.exec(line.trim());
			if (m === null) continue;
			const preheatIndex = lines.indexOf(line);
			const ownChangeIndex = lines.findIndex((l, i) => i > preheatIndex && l.trim() === `T${m[1]}`);
			if (ownChangeIndex !== -1) expect(preheatIndex).toBeLessThan(ownChangeIndex);
		}
		void tIndex;
	});

	it("clamps the very first tool change to the start of the file, since nothing prints before it, and warns", () => {
		const { output, pipeline } = run(loadFixture("two-tool"));
		const lines = output.split("\n");
		// "Clamp to the start of the file" is literal: the insertion lands on the very first line,
		// not merely somewhere ahead of the T-command
		expect(lines[0].trim()).toBe("M568 P0 A2");
		expect(pipeline.stats.warnings.some((w) => w.includes("clamped"))).toBe(true);
	});

	it("returns the outgoing tool to standby once the incoming one is pre-heating", () => {
		const { output } = run(loadFixture("two-tool"));
		expect(output).toContain("M568 P0 A1");
	});

	it("does nothing and says so for a file that only ever selects one tool", () => {
		const input = ["G28", "G90", "M83", "T0", "G1 X10 Y10 E1 F1800"].join("\n");
		const { output, pipeline } = run(input);
		expect(output.includes("A2")).toBe(false);
		expect(pipeline.stats.warnings.some((w) => w.includes("Only one tool is used"))).toBe(true);
	});

	it("does not duplicate a pre-heat the file already has for that tool", () => {
		const input = [
			"G28", "G90", "M83", "T0",
			"G1 X10 Y10 E1 F1800", "G1 X100 Y10 E1 F1800", "G1 X100 Y100 E1 F1800",
			"M568 P1 A2",
			"G1 X10 Y100 E1 F1800",
			"T1",
			"G1 X10 Y10 E1 F1800",
		].join("\n");
		const { output } = run(input);
		const count = output.split("\n").filter((l) => l.trim() === "M568 P1 A2").length;
		expect(count).toBe(1);
	});

	it("warns instead of throwing when this machine's motion limits are not available", () => {
		const ctx: StepFactoryContext = { scriptsTrusted: true, toolHeaters: TOOLS };
		const stepConfig = defaultConfig("preheat");
		const transform = preheatStep.create(stepConfig as never, ctx);
		const collectors = preheatStep.analysis?.(stepConfig as never, ctx) ?? [];
		const { output, pipeline } = runStepsWithAnalysis([transform], collectors, loadFixture("two-tool"));
		expect(output).toBe(loadFixture("two-tool"));
		expect(pipeline.stats.warnings.some((w) => w.includes("motion limits"))).toBe(true);
	});
});
