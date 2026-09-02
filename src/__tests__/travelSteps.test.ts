import { describe, expect, it } from "vitest";

import { makeStep, runSteps, runStep } from "./helpers";

describe("zHop", () => {
	it("hops a travel at or above the threshold, restoring the original Z", () => {
		const out = runStep(
			"zHop", { thresholdMm: 5, hopHeightMm: 0.4 },
			"G90\nG1 X0 Y0 F6000\nG1 X50 Y50 F6000",
		);
		expect(out).toBe("G90\nG1 X0 Y0 F6000\nG1 Z0.4 F600\nG1 X50 Y50 F6000\nG1 Z0 F600");
	});

	it("does not hop a travel below the threshold", () => {
		const input = "G90\nG1 X0 Y0 F6000\nG1 X1 Y1 F6000";
		expect(runStep("zHop", { thresholdMm: 5, hopHeightMm: 0.4 }, input)).toBe(input);
	});

	it("skips a travel already preceded by an explicit Z-rise, and reports it", () => {
		const input = "G90\nG1 X0 Y0 F6000\nG1 Z0.6 F600\nG1 X50 Y50 F6000\nG1 Z0.2 F600";
		const result = runSteps([makeStep("zHop", { thresholdMm: 5, hopHeightMm: 0.4 })], input);
		expect(result.output).toBe(input);
		expect(result.pipeline.stats.warnings.some((w) => w.includes("skipped 1"))).toBe(true);
	});

	it("skips the rest of the file once it sees firmware retraction (G10/G11)", () => {
		// Two genuine travels: (0,0)->(50,50) and, after returning to X0 Y0, ->(80,80) again
		const input = [
			"G90", "G10", "G1 X50 Y50 F6000", "G11",
			"G1 X0 Y0 F6000", "G10", "G1 X80 Y80 F6000", "G11",
		].join("\n");
		const result = runSteps([makeStep("zHop", { thresholdMm: 5, hopHeightMm: 0.4 })], input);
		expect(result.output).toBe(input);
		// The return-to-origin move ("G1 X0 Y0") is itself a third genuine travel — 3 skips total
		expect(result.pipeline.stats.warnings.some((w) => w.includes("skipped 3"))).toBe(true);
	});

	it("round-trips correctly in relative-move mode (G91)", () => {
		const out = runStep(
			"zHop", { thresholdMm: 5, hopHeightMm: 0.4 },
			"G91\nG1 X0 Y0 F6000\nG1 X50 Y50 F6000\nG1 X0 Y0 F6000",
		);
		const lines = out.split("\n");
		// A relative hop is +0.4 up, then -0.4 down — the two must cancel exactly regardless of Z
		const zLines = lines.filter((l) => l.startsWith("G1 Z"));
		expect(zLines).toEqual(["G1 Z0.4 F600", "G1 Z-0.4 F600"]);
	});

	it("does not mistake a real layer-change Z move for an existing hop", () => {
		// A genuine layer-change Z rise is far larger than a hop and has nothing to do with the
		// travel that follows several lines later with an extrusion move in between
		const input = "G90\nG1 Z0.4 F9000\nG1 X10 Y10 E1 F1200\nG1 X60 Y60 F6000";
		const out = runStep("zHop", { thresholdMm: 5, hopHeightMm: 0.4 }, input);
		expect(out).toContain("G1 Z0.8 F600"); // 0.4 + 0.4 hop up
	});
});

describe("oozeControl", () => {
	it("retracts before and after a travel at or above the threshold, in absolute E mode", () => {
		const out = runStep(
			"oozeControl", { thresholdMm: 5, retractMm: 0.4 },
			"G90\nM82\nG1 X0 Y0 E10 F1200\nG1 X50 Y50 F6000",
		);
		expect(out).toBe(
			"G90\nM82\nG1 X0 Y0 E10 F1200\nG1 E9.6 F1800\nG1 X50 Y50 F6000\nG1 E10 F1800",
		);
	});

	it("retracts in relative-E mode using a plain negative/positive delta", () => {
		const out = runStep(
			"oozeControl", { thresholdMm: 5, retractMm: 0.4 },
			"G90\nM83\nG1 X0 Y0 F6000\nG1 X50 Y50 F6000",
		);
		expect(out).toBe(
			"G90\nM83\nG1 X0 Y0 F6000\nG1 E-0.4 F1800\nG1 X50 Y50 F6000\nG1 E0.4 F1800",
		);
	});

	it("does not retract a travel below the threshold", () => {
		const input = "G90\nM83\nG1 X0 Y0 F6000\nG1 X1 Y1 F6000";
		expect(runStep("oozeControl", { thresholdMm: 5, retractMm: 0.4 }, input)).toBe(input);
	});

	it("skips a travel already preceded by a retraction, and reports it", () => {
		const input = "G90\nM83\nG1 X0 Y0 F6000\nG1 E-1 F1800\nG1 X50 Y50 F6000";
		const result = runSteps([makeStep("oozeControl", { thresholdMm: 5, retractMm: 0.4 })], input);
		expect(result.output).toBe(input);
		expect(result.pipeline.stats.warnings.some((w) => w.includes("skipped 1"))).toBe(true);
	});

	it("skips the rest of the file once it sees firmware retraction (G10/G11)", () => {
		const input = ["G90", "G10", "G1 X50 Y50 F6000", "G11", "G1 X80 Y80 F6000"].join("\n");
		const result = runSteps([makeStep("oozeControl", { thresholdMm: 5, retractMm: 0.4 })], input);
		expect(result.output).toBe(input);
	});

	it("drops and restores temperature only when a prior temperature is known", () => {
		const withTemp = runStep(
			"oozeControl", { thresholdMm: 5, retractMm: 0.4, dropTemperature: true, tempDropC: 10 },
			"G90\nM83\nM104 S210\nG1 X0 Y0 F6000\nG1 X50 Y50 F6000",
		);
		expect(withTemp).toContain("M104 S200");
		expect(withTemp).toContain("M104 S210\n"); // the restore, distinct from the original setpoint line above

		const withoutTemp = runStep(
			"oozeControl", { thresholdMm: 5, retractMm: 0.4, dropTemperature: true, tempDropC: 10 },
			"G90\nM83\nG1 X0 Y0 F6000\nG1 X50 Y50 F6000",
		);
		expect(withoutTemp).not.toContain("M104");
	});
});
