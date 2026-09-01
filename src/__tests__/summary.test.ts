import { describe, expect, it } from "vitest";

import { analyseText } from "../model/analysis";
import { parseMetadata } from "../model/gcode/metadata";
import type { MachineLimits } from "../model/gcode/timeModel";
import { summariseFile } from "../model/summary";
import { SAMPLE } from "./helpers";

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
};

describe("summariseFile", () => {
	it("names the slicer and version", () => {
		const analysis = analyseText(SAMPLE, parseMetadata(SAMPLE));
		expect(summariseFile(analysis)).toContain("PrusaSlicer");
	});

	it("says \"an unrecognised slicer\" rather than naming one, when none was found", () => {
		const analysis = analyseText("G1 X10 F6000");
		expect(summariseFile(analysis)).toContain("an unrecognised slicer");
	});

	it("includes the layer count and, when known, the height", () => {
		const analysis = analyseText(SAMPLE, parseMetadata(SAMPLE));
		expect(summariseFile(analysis)).toMatch(/3 layers \(0\.6mm tall\)/);
	});

	it("omits the layer clause entirely for a file with no layers", () => {
		const analysis = analyseText("M104 S210");
		expect(summariseFile(analysis)).not.toContain("layer");
	});

	it("names the tools used", () => {
		const analysis = analyseText(["T0", "G1 X10 E1 F1200", "T1", "G1 X20 E1"].join("\n"));
		expect(summariseFile(analysis)).toContain("T0, T1");
	});

	it("states which source the time estimate came from", () => {
		const withM73 = analyseText("M73 P0 R12", undefined, LIMITS);
		expect(summariseFile(withM73)).toContain("the slicer's own estimate");

		const modelled = analyseText("G28\nG1 X100 Y100 F6000", undefined, LIMITS);
		expect(summariseFile(modelled)).toContain("this machine's own limits");
	});

	it("omits the time clause when no estimate is possible", () => {
		const analysis = analyseText("M104 S210");
		expect(summariseFile(analysis)).not.toContain("estimated");
	});

	it("includes filament length in metres when the slicer states it", () => {
		const analysis = analyseText(SAMPLE, parseMetadata(SAMPLE));
		expect(summariseFile(analysis)).toMatch(/uses 1\.2m of filament/);
	});

	it("includes peak flow only when a figure exists", () => {
		const meta = parseMetadata("; filament_diameter = 1.75");
		const withFlow = analyseText("G1 X10 F3600 E1", meta);
		expect(summariseFile(withFlow)).toMatch(/peak flow of [\d.]+ mm³\/s/);

		const withoutFlow = analyseText("G1 X10 F3600 E1");
		expect(summariseFile(withoutFlow)).not.toContain("peak flow");
	});

	it("mentions labelled objects only when the file has them", () => {
		const withObjects = analyseText('M486 S0 A"Cube"\nG1 X10 E1');
		expect(summariseFile(withObjects)).toContain("1 labelled object");

		const withoutObjects = analyseText("G1 X10 E1");
		expect(summariseFile(withoutObjects)).not.toContain("labelled object");
	});

	it("always ends with exactly one full stop, and starts capitalised", () => {
		const analysis = analyseText("G1 X10 F6000");
		const summary = summariseFile(analysis);
		expect(summary.endsWith(".")).toBe(true);
		expect(summary.endsWith("..")).toBe(false);
		expect(summary[0]).toBe(summary[0].toUpperCase());
	});

	it("never crashes on a file with nothing identifiable at all", () => {
		expect(() => summariseFile(analyseText(""))).not.toThrow();
	});
});
