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

type HeaterState = "off" | "standby" | "active" | "unknown";

/**
 * Walk the output and track each tool's heater state through the `M568 A<n>` commands, recording
 * the state at every `T` selection — the invariant that actually matters (every tool ACTIVE when
 * selected), rather than the exact line position of any one inserted command. This is what caught
 * defect B in the original audit: the earlier assertions here (`toContain("M568 P0 A1")`,
 * `lines[0] === "M568 P0 A2"`) passed *because of* the bug.
 */
function traceToolStates(output: string): Array<{ tool: number; lineIndex: number; state: HeaterState }> {
	const state = new Map<number, HeaterState>();
	const rows: Array<{ tool: number; lineIndex: number; state: HeaterState }> = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const pre = /^M568 P(\d+) A(\d)$/.exec(line);
		if (pre !== null) {
			const tool = Number(pre[1]);
			state.set(tool, pre[2] === "2" ? "active" : pre[2] === "1" ? "standby" : "off");
			continue;
		}
		const sel = /^T(\d+)$/.exec(line);
		if (sel !== null) {
			rows.push({ tool: Number(sel[1]), lineIndex: i, state: state.get(Number(sel[1])) ?? "unknown" });
		}
	}
	return rows;
}

/** Line index of the first `M568 P<tool>` carrying an `R` or `S` parameter — the file's own
 *  temperature setup for that tool. */
function tempSetupLine(output: string, tool: number): number {
	const lines = output.split("\n");
	return lines.findIndex((l) => {
		const m = new RegExp(`^M568 P${tool}\\b`).exec(l.trim());
		return m !== null && /[RS]-?\d/.test(l);
	});
}

describe("preheat step", () => {
	it("on a fixture with genuine lead, every tool is ACTIVE at every selection", () => {
		const { output } = run(loadFixture("two-tool-long"));
		const trace = traceToolStates(output);
		expect(trace.length).toBeGreaterThanOrEqual(3);
		for (const row of trace) expect(row.state).toBe("active");
	});

	it("never emits a pre-heat before the file's own temperature setup for that tool", () => {
		for (const fixture of ["two-tool", "two-tool-long"]) {
			const { output } = run(loadFixture(fixture));
			const lines = output.split("\n");
			lines.forEach((line, i) => {
				const m = /^M568 P(\d+) A2$/.exec(line.trim());
				if (m === null) return;
				const setupLine = tempSetupLine(output, Number(m[1]));
				expect(setupLine).toBeGreaterThanOrEqual(0);
				expect(i).toBeGreaterThanOrEqual(setupLine);
			});
		}
	});

	it("returns the outgoing tool to standby once the incoming one is genuinely pre-heating", () => {
		const { output } = run(loadFixture("two-tool-long"));
		expect(output).toContain("M568 P0 A1");
		expect(output).toContain("M568 P1 A1");
	});

	it("reports a pre-heated count matching the number of pre-heats that actually survive", () => {
		const { output, pipeline } = run(loadFixture("two-tool-long"));
		const emitted = output.split("\n").filter((l) => /^M568 P\d+ A2$/.test(l.trim())).length;
		const reported = pipeline.stats.warnings.find((w) => w.startsWith("Pre-heated"));
		expect(reported).toBeDefined();
		const n = Number(/^Pre-heated (\d+)/.exec(reported!)?.[1]);
		expect(n).toBe(emitted);
	});

	it("on the short fixture, where nothing has enough lead, drops or clamps rather than misbehaving", () => {
		// This fixture spans only ~20s total while every heat-up needs far more — the regression case
		// for defects B and C: everything is either clamped to the earliest legitimate point or
		// dropped for having none at all, but the invariant (ACTIVE at every selection, or explicitly
		// reported as not pre-heated) must still hold
		const { output, pipeline } = run(loadFixture("two-tool"));
		const trace = traceToolStates(output);
		for (const row of trace) {
			// A selection is only allowed to be non-ACTIVE if the step said, in its report, that this
			// change could not be pre-heated at all
			if (row.state !== "active") {
				expect(pipeline.stats.warnings.some((w) => w.includes("could not be pre-heated"))).toBe(true);
			}
		}
		// The pathologically short fixture is exactly the case defect C's "no legitimate lead" and
		// defect C's "never stack two pre-heats at once" branches exist for
		expect(
			pipeline.stats.warnings.some((w) => w.includes("could not be pre-heated"))
			|| pipeline.stats.warnings.some((w) => w.includes("was dropped")),
		).toBe(true);
	});

	it("does nothing and says so for a file that only ever selects one tool", () => {
		const input = ["G28", "G90", "M83", "T0", "G1 X10 Y10 E1 F1800"].join("\n");
		const { output, pipeline } = run(input);
		expect(output.includes("A2")).toBe(false);
		expect(pipeline.stats.warnings.some((w) => w.includes("Only one tool is used"))).toBe(true);
	});

	it("does not duplicate a pre-heat the file already has for that tool", () => {
		const input = [
			"M568 P0 R140 S200", "M568 P1 R140 S205",
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
		const { output, pipeline } = runStepsWithAnalysis([transform], collectors, loadFixture("two-tool-long"));
		expect(output).toBe(loadFixture("two-tool-long"));
		expect(pipeline.stats.warnings.some((w) => w.includes("motion limits"))).toBe(true);
	});
});
