import { describe, expect, it } from "vitest";

import type { MachineLimits } from "../model/gcode/timeModel";
import { rewriteTimeStep } from "../model/steps/rewriteTime";
import type { StepFactoryContext } from "../model/steps/types";
import { runStepsWithAnalysis } from "./helpers";

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
};

const FIXTURE = [
	"M73 P0 R10",
	"G28",
	"G1 X10 Y10 F6000",
	"G1 X50 Y10 F6000",
	"M73 P30 R7",
	"G1 X50 Y50 F6000",
	"G1 X10 Y50 F6000",
	"M73 P60 R3",
	"G1 X10 Y10 F6000",
	"G1 Z10 F300",
	"M73 P100 R0",
].join("\n");

const NO_MARKERS_FIXTURE = [
	"G28",
	"G1 X10 Y10 F6000",
	"G1 X50 Y10 F6000",
].join("\n");

function runFixture(fixture: string, limits: MachineLimits | undefined) {
	const ctx: StepFactoryContext = { scriptsTrusted: true, machineLimits: limits };
	const transform = rewriteTimeStep.create({}, ctx);
	const collectors = rewriteTimeStep.analysis?.({}, ctx) ?? [];
	return runStepsWithAnalysis([transform], collectors, fixture);
}

function extractMarkers(output: string): Array<{ p: number; r: number }> {
	return output.split("\n")
		.filter((l) => l.startsWith("M73"))
		.map((l) => {
			const p = /P(\d+(?:\.\d+)?)/.exec(l);
			const r = /R(\d+(?:\.\d+)?)/.exec(l);
			return { p: p === null ? NaN : Number(p[1]), r: r === null ? NaN : Number(r[1]) };
		});
}

describe("rewriteTime", () => {
	it("rewrites every marker with a monotonically non-decreasing percent", () => {
		const { output } = runFixture(FIXTURE, LIMITS);
		const markers = extractMarkers(output);
		expect(markers.length).toBe(4);
		for (let i = 1; i < markers.length; i++) {
			expect(markers[i].p).toBeGreaterThanOrEqual(markers[i - 1].p);
		}
	});

	it("ends the last marker at P100 R0", () => {
		const { output } = runFixture(FIXTURE, LIMITS);
		const markers = extractMarkers(output);
		expect(markers[markers.length - 1]).toEqual({ p: 100, r: 0 });
	});

	it("keeps every percent within 0..100", () => {
		const { output } = runFixture(FIXTURE, LIMITS);
		for (const { p, r } of extractMarkers(output)) {
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThanOrEqual(100);
			expect(r).toBeGreaterThanOrEqual(0);
		}
	});

	it("leaves every non-M73 line untouched", () => {
		const { output } = runFixture(FIXTURE, LIMITS);
		const before = FIXTURE.split("\n").filter((l) => !l.startsWith("M73"));
		const after = output.split("\n").filter((l) => !l.startsWith("M73"));
		expect(after).toEqual(before);
	});

	it("preserves an unrelated parameter and a trailing comment on the M73 line", () => {
		const withExtra = "M73 P0 R10 Q99 ; progress\nG1 X10 F6000\nM73 P100 R0 ; done";
		const { output } = runFixture(withExtra, LIMITS);
		expect(output).toContain("Q99");
		expect(output).toContain("; progress");
		expect(output).toContain("; done");
	});

	it("is byte-identical and warns when the file has no M73 markers", () => {
		const { output, pipeline } = runFixture(NO_MARKERS_FIXTURE, LIMITS);
		expect(output).toBe(NO_MARKERS_FIXTURE);
		expect(pipeline.stats.warnings.some((w) => w.includes("No M73 markers"))).toBe(true);
	});

	it("passes markers through unchanged and warns when machine limits are not available", () => {
		const { output, pipeline } = runFixture(FIXTURE, undefined);
		expect(output).toBe(FIXTURE);
		expect(pipeline.stats.warnings.some((w) => w.includes("motion limits"))).toBe(true);
	});

	it("declares no collector at all when machine limits are not available", () => {
		const ctx: StepFactoryContext = { scriptsTrusted: true, machineLimits: undefined };
		expect(rewriteTimeStep.analysis?.({}, ctx)).toEqual([]);
	});
});
