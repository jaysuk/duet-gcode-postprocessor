import { describe, expect, it } from "vitest";

import { analyseText } from "../model/analysis";
import { detectDialect } from "../model/gcode/dialect";
import { emptySnapshot, runChecks, type MachineSnapshot } from "../model/checks";
import { parseMetadata } from "../model/gcode/metadata";
import { SAMPLE } from "./helpers";

const MACHINE: MachineSnapshot = {
	axes: [
		{ letter: "X", min: 0, max: 300 },
		{ letter: "Y", min: 0, max: 300 },
		{ letter: "Z", min: 0, max: 400 },
	],
	tools: [0, 1],
	fanCount: 2,
	heaterMaxTemps: [120, 285, 285],
	toolHeaters: [[1], [2]],
	bedHeaters: [0],
	anyAxisHomed: true,
};

describe("analyseText", () => {
	it("summarises a normal file", () => {
		const analysis = analyseText(SAMPLE, parseMetadata(SAMPLE));
		expect(analysis.layers).toBe(3);
		expect(analysis.tools).toEqual([0]);
		expect(analysis.maxToolTemp).toBe(210);
		expect(analysis.maxBedTemp).toBe(60);
		expect(analysis.maxFeedrate).toBe(9000);
		expect(analysis.homes).toBe(true);
		expect(analysis.usesRelativeE).toBe(true);
	});

	it("counts commands, most frequent first", () => {
		const analysis = analyseText(SAMPLE);
		expect(analysis.commandCounts.get("G1")).toBe(7);
		expect([...analysis.commandCounts.keys()][0]).toBe("G1");
	});

	it("measures the extents", () => {
		const analysis = analyseText(SAMPLE);
		expect(analysis.extents).toEqual({ minX: 10, maxX: 20, minY: 10, maxY: 20, minZ: 0.2, maxZ: 0.6 });
	});

	it("follows relative moves when measuring extents", () => {
		const analysis = analyseText("G90\nG1 X10 Y10\nG91\nG1 X5 Y5\nG1 X5 Y5");
		expect(analysis.extents?.maxX).toBe(20);
	});

	it("counts Klipper macros that are not G-code commands", () => {
		const analysis = analyseText("SET_PRESSURE_ADVANCE ADVANCE=0.05\nG28");
		expect(analysis.commandCounts.get("SET_PRESSURE_ADVANCE")).toBe(1);
		expect(analysis.dialect.flavour).toBe("klipper");
	});

	it("returns null extents for a file with no coordinates", () => {
		expect(analyseText("; nothing here\nM104 S200").extents).toBeNull();
	});
});

describe("detectDialect", () => {
	it("calls a file with M572 and M566 RepRapFirmware", () => {
		const report = detectDialect(new Map([["M572", 1], ["M566", 1], ["G1", 100]]));
		expect(report.flavour).toBe("rrf");
	});

	it("calls a file with M900 and M205 Marlin, and flags them as unsupported", () => {
		const report = detectDialect(new Map([["M900", 1], ["M205", 2], ["G1", 100]]));
		expect(report.flavour).toBe("marlin");
		expect(report.unsupported.map((u) => u.code)).toEqual(["M205", "M900"]);
	});

	it("says nothing about a file with no distinguishing commands", () => {
		const report = detectDialect(new Map([["G1", 100], ["G28", 1], ["M106", 4]]));
		expect(report.flavour).toBe("unknown");
		expect(report.evidence).toEqual([]);
	});
});

describe("preflight checks", () => {
	it("passes a clean file on a matching machine", () => {
		const results = runChecks(analyseText(SAMPLE, parseMetadata(SAMPLE)), MACHINE);
		expect(results.filter((r) => r.level === "error")).toEqual([]);
	});

	it("reports a command RepRapFirmware does not implement", () => {
		const results = runChecks(analyseText("M900 K0.05\nG28"), MACHINE);
		expect(results.some((r) => r.code === "unsupported:M900" && r.level === "error")).toBe(true);
	});

	it("reports moves outside the machine limits", () => {
		const results = runChecks(analyseText("G28\nG1 X500 Y10"), MACHINE);
		const issue = results.find((r) => r.code === "extents:X");
		expect(issue?.level).toBe("error");
		expect(issue?.detail).toContain("500");
	});

	it("reports a tool that is not configured", () => {
		const results = runChecks(analyseText("G28\nT5\nG1 X1"), MACHINE);
		expect(results.some((r) => r.code === "tools:missing")).toBe(true);
	});

	it("reports a temperature above the heater limit", () => {
		const results = runChecks(analyseText("G28\nM104 S320"), MACHINE);
		expect(results.some((r) => r.code === "temp:tool" && r.level === "error")).toBe(true);
	});

	it("reports a bed temperature above the bed limit", () => {
		const results = runChecks(analyseText("G28\nM140 S150"), MACHINE);
		expect(results.some((r) => r.code === "temp:bed")).toBe(true);
	});

	it("reports a fan that does not exist", () => {
		const results = runChecks(analyseText("G28\nM106 P7 S255"), MACHINE);
		expect(results.some((r) => r.code === "fans:missing" && r.level === "warning")).toBe(true);
	});

	it("notices a file with no homing", () => {
		const results = runChecks(analyseText("G1 X10 Y10"), MACHINE);
		expect(results.some((r) => r.code === "structure:noHoming")).toBe(true);
	});

	it("checks nothing machine-specific when the machine is unknown", () => {
		// Disconnected, or an object model that has not populated — must not invent failures
		const results = runChecks(analyseText("G28\nG1 X5000 Y10\nM104 S400"), emptySnapshot());
		expect(results.filter((r) => r.level === "error")).toEqual([]);
	});

	it("sorts errors above warnings above information", () => {
		const results = runChecks(analyseText("M900 K0.05\nG1 X10"), MACHINE);
		const levels = results.map((r) => r.level);
		expect(levels).toEqual([...levels].sort((a, b) => ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]));
	});
});
