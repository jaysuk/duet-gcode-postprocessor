import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyseText, MAX_REPORTED_LAYERS } from "../model/analysis";
import { detectDialect } from "../model/gcode/dialect";
import { emptySnapshot, runChecks, type MachineSnapshot } from "../model/checks";
import { parseMetadata } from "../model/gcode/metadata";
import type { MachineLimits } from "../model/gcode/timeModel";
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

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
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

	describe("fanSettings", () => {
		it("aggregates repeated settings and counts them", () => {
			const analysis = analyseText("M106 P0 S255\nG1 X1\nM106 P0 S255\nM106 P0 S128");
			const s255 = analysis.fanSettings.find((s) => s.speed === 255);
			expect(s255?.count).toBe(2);
			const s128 = analysis.fanSettings.find((s) => s.speed === 128);
			expect(s128?.count).toBe(1);
		});

		it("records M107 as speed 0", () => {
			const analysis = analyseText("M106 P0 S255\nM107 P0");
			const off = analysis.fanSettings.find((s) => s.speed === 0 && s.fan === 0);
			expect(off?.count).toBe(1);
		});

		it("defaults the fan index to 0 when P is omitted", () => {
			const analysis = analyseText("M106 S255");
			expect(analysis.fanSettings).toEqual([{ fan: 0, speed: 255, count: 1, features: [{ feature: "unknown", count: 1 }] }]);
		});

		it("lists the features a setting was seen under, most frequent first", () => {
			const analysis = analyseText([
				";TYPE:Bridge infill",
				"M106 P0 S255",
				"G1 X1",
				";TYPE:Solid infill",
				"M106 P0 S255",
				"G1 X1",
				";TYPE:Bridge infill",
				"M106 P0 S255",
			].join("\n"));
			const setting = analysis.fanSettings.find((s) => s.speed === 255);
			expect(setting?.features).toEqual([
				{ feature: "bridge", count: 2 },
				{ feature: "solidInfill", count: 1 },
			]);
		});

		it("keeps 0-255 and 0-1 scales distinct rather than normalising between them", () => {
			// Guessing wrong here turns "half speed" into "off" — the two must never be conflated
			const analysis = analyseText("M106 P0 S128\nM106 P0 S0.5");
			expect(analysis.fanSettings.find((s) => s.speed === 128)).toBeDefined();
			expect(analysis.fanSettings.find((s) => s.speed === 0.5)).toBeDefined();
			expect(analysis.fanSettings).toHaveLength(2);
		});

		it("distinguishes settings by fan index", () => {
			const analysis = analyseText("M106 P0 S255\nM106 P1 S255");
			expect(analysis.fanSettings).toHaveLength(2);
		});

		it("is empty for a file with no fan commands", () => {
			expect(analyseText("G28\nG1 X1").fanSettings).toEqual([]);
		});

		it("sorts settings most-frequent first", () => {
			const analysis = analyseText("M106 P0 S64\nM106 P0 S255\nM106 P0 S255\nM106 P0 S255");
			expect(analysis.fanSettings[0].speed).toBe(255);
		});
	});

	describe("macroRefs", () => {
		it("collects a quoted macro reference", () => {
			const analysis = analyseText("M98 P\"0:/macros/timelapse.g\"");
			expect(analysis.macroRefs).toEqual([{ path: "0:/macros/timelapse.g", count: 1, firstLine: 1 }]);
		});

		it("un-escapes a doubled quote inside the path", () => {
			const analysis = analyseText("M98 P\"0:/macros/say \"\"hi\"\".g\"");
			expect(analysis.macroRefs[0].path).toBe('0:/macros/say "hi".g');
		});

		it("ignores an M98 whose P is an expression, rather than guessing", () => {
			const analysis = analyseText("M98 P{var.macroName}");
			expect(analysis.macroRefs).toEqual([]);
		});

		it("records a relative path exactly as written, for the resolver to root against 0:/", () => {
			const analysis = analyseText("M98 P\"macros/foo.g\"");
			expect(analysis.macroRefs[0].path).toBe("macros/foo.g");
		});

		it("de-duplicates repeated calls to the same macro, counting and keeping the first line", () => {
			const analysis = analyseText([
				"G28",
				"M98 P\"0:/macros/purge.g\"",
				"G1 X1",
				"M98 P\"0:/macros/purge.g\"",
			].join("\n"));
			expect(analysis.macroRefs).toEqual([{ path: "0:/macros/purge.g", count: 2, firstLine: 2 }]);
		});

		it("keeps distinct macros in first-seen order", () => {
			const analysis = analyseText([
				"M98 P\"0:/macros/b.g\"",
				"M98 P\"0:/macros/a.g\"",
			].join("\n"));
			expect(analysis.macroRefs.map((r) => r.path)).toEqual(["0:/macros/b.g", "0:/macros/a.g"]);
		});

		it("is empty for a file with no macro calls", () => {
			expect(analyseText("G28\nG1 X1").macroRefs).toEqual([]);
		});
	});

	describe("cold-extrusion detection", () => {
		it("records the first extruding move", () => {
			const analysis = analyseText(["G28", "M109 S210", "G1 X1 E1"].join("\n"));
			expect(analysis.firstExtrusionLine).toBe(3);
			expect(analysis.firstHeatWaitLine).toBe(2);
		});

		it("does not count a retraction as extrusion", () => {
			const analysis = analyseText("G1 E-2\nG1 X1 E0");
			expect(analysis.firstExtrusionLine).toBeNull();
		});

		it("does not count a zero E as extrusion", () => {
			expect(analyseText("G1 X1 E0").firstExtrusionLine).toBeNull();
		});

		it("recognises M116 as a wait, not only M109", () => {
			const analysis = analyseText(["M104 S210", "M116", "G1 X1 E1"].join("\n"));
			expect(analysis.firstHeatWaitLine).toBe(2);
		});

		it("does not treat M104 alone as a wait", () => {
			const analysis = analyseText("M104 S210\nG1 X1 E1");
			expect(analysis.firstHeatWaitLine).toBeNull();
		});

		it("only records the first occurrence of each", () => {
			const analysis = analyseText(["M109 S210", "G1 X1 E1", "M109 S220", "G1 X2 E2"].join("\n"));
			expect(analysis.firstHeatWaitLine).toBe(1);
			expect(analysis.firstExtrusionLine).toBe(2);
		});

		it("is null for a file with no extrusion at all", () => {
			const analysis = analyseText("G28\nG1 X1\nM109 S210");
			expect(analysis.firstExtrusionLine).toBeNull();
		});
	});

	describe("end-of-file hygiene signals", () => {
		it("heatersAddressed is true after an S0/negative M104, M140 or M568 standby", () => {
			expect(analyseText("M104 S210\nM104 S0").heatersAddressed).toBe(true);
			expect(analyseText("M140 S60\nM140 S0").heatersAddressed).toBe(true);
			expect(analyseText("M568 P0 A1").heatersAddressed).toBe(true);
			expect(analyseText("M568 P0 A0").heatersAddressed).toBe(true);
		});

		it("heatersAddressed is false when nothing turns a heater off", () => {
			expect(analyseText("M104 S210").heatersAddressed).toBe(false);
		});

		it("M568 A2 (active) does not count as addressed", () => {
			expect(analyseText("M568 P0 A2").heatersAddressed).toBe(false);
		});

		it("heatersAddressed is true after M0 or M2", () => {
			expect(analyseText("M104 S210\nM0").heatersAddressed).toBe(true);
			expect(analyseText("M104 S210\nM2").heatersAddressed).toBe(true);
		});

		it("fanAddressed is true after M107 or an S0 M106", () => {
			expect(analyseText("M106 S255\nM107").fanAddressed).toBe(true);
			expect(analyseText("M106 S255\nM106 S0").fanAddressed).toBe(true);
		});

		it("fanAddressed is false when the fan is never turned off", () => {
			expect(analyseText("M106 S255").fanAddressed).toBe(false);
		});

		it("motorsAddressed is true after M18 or M84", () => {
			expect(analyseText("G1 X1\nM18").motorsAddressed).toBe(true);
			expect(analyseText("G1 X1\nM84").motorsAddressed).toBe(true);
		});

		it("motorsAddressed is false when motors are never disabled", () => {
			expect(analyseText("G1 X1").motorsAddressed).toBe(false);
		});
	});

	describe("time estimate", () => {
		it("prefers the slicer's own M73 markers when present", () => {
			const text = ["M73 P0 R12", "G1 X10 F6000", "M73 P50 R6", "G1 X20 F6000", "M73 P100 R0"].join("\n");
			const analysis = analyseText(text, undefined, LIMITS);
			expect(analysis.timeSource).toBe("m73");
			expect(analysis.estimatedSeconds).toBe(12 * 60);
		});

		it("uses M73 even without machine limits, since it needs no model at all", () => {
			const analysis = analyseText("M73 P0 R12");
			expect(analysis.timeSource).toBe("m73");
			expect(analysis.estimatedSeconds).toBe(12 * 60);
		});

		it("uses the first M73's R, not a later one, as the total", () => {
			const analysis = analyseText("M73 P0 R12\nM73 P50 R6");
			expect(analysis.estimatedSeconds).toBe(12 * 60);
		});

		it("falls back to the move-time model when there are no M73 markers", () => {
			const analysis = analyseText("G28\nG1 X100 Y100 F6000\nG1 X0 Y0 F6000", undefined, LIMITS);
			expect(analysis.timeSource).toBe("model");
			expect(analysis.estimatedSeconds).toBeGreaterThan(0);
		});

		it("reports none when there are no markers and no limits were supplied", () => {
			const analysis = analyseText("G28\nG1 X100 Y100 F6000");
			expect(analysis.timeSource).toBe("none");
			expect(analysis.estimatedSeconds).toBeNull();
		});

		it("reports none for an empty file even when limits are supplied", () => {
			const analysis = analyseText("", undefined, LIMITS);
			expect(analysis.timeSource).toBe("none");
			expect(analysis.estimatedSeconds).toBeNull();
		});

		it("reports none for a file with only non-move commands", () => {
			const analysis = analyseText("M104 S210\nM140 S60", undefined, LIMITS);
			expect(analysis.timeSource).toBe("none");
			expect(analysis.estimatedSeconds).toBeNull();
		});

		it("does not report a file made only of arcs as having nothing to time (task 10 finding A)", () => {
			const arcs = analyseText(
				["G1 X0 Y0 F600", "G3 X20 Y0 I10 J0", "G3 X0 Y0 I-10 J0"].join("\n"), undefined, LIMITS,
			);
			expect(arcs.timeSource).toBe("model");
			expect(arcs.estimatedSeconds).toBeGreaterThan(1);
		});
	});

	it("counts Klipper macros that are not G-code commands", () => {
		const analysis = analyseText("SET_PRESSURE_ADVANCE ADVANCE=0.05\nG28");
		expect(analysis.commandCounts.get("SET_PRESSURE_ADVANCE")).toBe(1);
		expect(analysis.dialect.flavour).toBe("klipper");
	});

	it("returns null extents for a file with no coordinates", () => {
		expect(analyseText("; nothing here\nM104 S200").extents).toBeNull();
	});

	describe("volumetric flow", () => {
		it("computes flow from the metadata's filament diameter", () => {
			const meta = parseMetadata("; filament_diameter = 1.75");
			const analysis = analyseText("G1 X10 F3600 E1", meta);
			const area = Math.PI * (1.75 / 2) ** 2;
			const expected = area * (1 / 10) * 60; // 1mm E over 10mm travel at 60 mm/s
			expect(analysis.peakFlowMm3PerSec).toBeCloseTo(expected, 6);
			expect(analysis.peakFlowLine).toBe(1);
		});

		it("is null when the file does not extrude", () => {
			const meta = parseMetadata("; filament_diameter = 1.75");
			const analysis = analyseText("G1 X10 F3600", meta);
			expect(analysis.peakFlowMm3PerSec).toBeNull();
			expect(analysis.peakFlowLine).toBeNull();
		});

		it("is null when the filament diameter is unknown, rather than assumed", () => {
			const analysis = analyseText("G1 X10 F3600 E1");
			expect(analysis.peakFlowMm3PerSec).toBeNull();
			expect(analysis.peakFlowLine).toBeNull();
		});

		it("gives a different figure for the same E at a different filament diameter", () => {
			const gcode = "G1 X10 F3600 E1";
			const thin = analyseText(gcode, parseMetadata("; filament_diameter = 1.75")).peakFlowMm3PerSec;
			const thick = analyseText(gcode, parseMetadata("; filament_diameter = 2.85")).peakFlowMm3PerSec;
			expect(thin).not.toBeNull();
			expect(thick).not.toBeNull();
			expect(thick).toBeGreaterThan(thin as number);
		});

		it("reports the line of the worst move, not the first extruding one", () => {
			const meta = parseMetadata("; filament_diameter = 1.75");
			const analysis = analyseText(["G1 X10 F3600 E1", "G1 X20 F3600 E3"].join("\n"), meta);
			// Second move: 2mm E over 10mm travel, double the first move's rate
			expect(analysis.peakFlowLine).toBe(2);
		});

		it("measures an arc along its arc length, not its chord (task 10 finding B)", () => {
			const meta = parseMetadata("; filament_diameter = 1.75");
			// Half circle r=10 from (0,0) to (20,0): chord 20mm, true path ~31.4mm — same E over a
			// longer real distance means genuinely lower flow, not the same figure as the straight line
			const arc = analyseText("G1 X0 Y0 F600\nG3 X20 Y0 I10 J0 E1", meta);
			const straight = analyseText("G1 X0 Y0 F600\nG1 X20 Y0 E1", meta);
			expect(arc.peakFlowMm3PerSec).not.toBeNull();
			expect(arc.peakFlowMm3PerSec).toBeLessThan(straight.peakFlowMm3PerSec as number);
		});

		it("gives a full-circle arc's flow a real (finite, non-infinite) figure despite a zero chord", () => {
			const meta = parseMetadata("; filament_diameter = 1.75");
			const analysis = analyseText("G1 X10 Y0 F600\nG2 X10 Y0 I-10 J0 E1", meta);
			expect(analysis.peakFlowMm3PerSec).not.toBeNull();
			expect(Number.isFinite(analysis.peakFlowMm3PerSec)).toBe(true);
		});

		it("reads the slicer's own max_volumetric_speed when stated", () => {
			const meta = parseMetadata("; max_volumetric_speed = 10");
			expect(analyseText("G28", meta).statedMaxFlowMm3PerSec).toBe(10);
		});

		it("is null when the slicer states no ceiling", () => {
			expect(analyseText("G28").statedMaxFlowMm3PerSec).toBeNull();
		});

		it("treats a stated 0 as \"no limit\" (PrusaSlicer/OrcaSlicer's own convention), not a real ceiling", () => {
			const meta = parseMetadata("; max_volumetric_speed = 0");
			expect(analyseText("G28", meta).statedMaxFlowMm3PerSec).toBeNull();
		});
	});

	describe("feature/layer/object statistics", () => {
		it("attributes a move's time to the feature in force when it happens, not the one after", () => {
			const text = [
				";TYPE:External perimeter", "G1 X10 F6000",
				";TYPE:Solid infill", "G1 X20 F6000",
			].join("\n");
			const analysis = analyseText(text, undefined, LIMITS);
			const perimeter = analysis.featureStats.find((f) => f.feature === "externalPerimeter");
			const infill = analysis.featureStats.find((f) => f.feature === "solidInfill");
			expect(perimeter?.moves).toBe(1);
			expect(infill?.moves).toBe(1);
			expect(perimeter?.seconds).toBeGreaterThan(0);
			expect(infill?.seconds).toBeGreaterThan(0);
		});

		it("lands a move before any ;TYPE: comment under \"unknown\"", () => {
			const analysis = analyseText("G1 X10 F6000", undefined, LIMITS);
			expect(analysis.featureStats.find((f) => f.feature === "unknown")?.moves).toBe(1);
		});

		it("attributes filament per feature in both M82 and M83 modes", () => {
			const absolute = analyseText([";TYPE:Solid infill", "G1 X10 E5 F1200"].join("\n"));
			const relative = analyseText(["M83", ";TYPE:Solid infill", "G1 X10 E5 F1200"].join("\n"));
			expect(absolute.featureStats.find((f) => f.feature === "solidInfill")?.filamentMm).toBe(5);
			expect(relative.featureStats.find((f) => f.feature === "solidInfill")?.filamentMm).toBe(5);
		});

		it("does not count a retraction as filament used", () => {
			const analysis = analyseText([";TYPE:Solid infill", "G1 E-2 F1200"].join("\n"));
			expect(analysis.featureStats.find((f) => f.feature === "solidInfill")).toBeUndefined();
		});

		it("populates feature stats even with no machine limits, at zero seconds", () => {
			const analysis = analyseText([";TYPE:Solid infill", "G1 X10 E5 F1200"].join("\n"));
			const infill = analysis.featureStats.find((f) => f.feature === "solidInfill");
			expect(infill?.filamentMm).toBe(5);
			expect(infill?.seconds).toBe(0);
		});

		it("sums per-layer seconds to the file total (the identity that catches double-counting)", () => {
			// clampedSeconds, not estimatedSeconds: SAMPLE carries its own M73 markers, which
			// estimatedSeconds prefers over the model — but per-move seconds only ever come from the
			// model (clampedSeconds), so that is the total this identity has to hold against.
			const analysis = analyseText(SAMPLE, undefined, LIMITS);
			const layerTotal = analysis.slowestLayers.reduce((sum, l) => sum + l.seconds, 0);
			expect(layerTotal).toBeCloseTo(analysis.clampedSeconds as number, 6);
		});

		it("sums per-feature seconds to the file total on a real fixture (task 12 acceptance)", () => {
			const fixture = readFileSync(resolve(__dirname, "../../test/fixtures/prusaslicer.gcode"), "utf-8");
			const analysis = analyseText(fixture, parseMetadata(fixture), LIMITS);
			const featureTotal = analysis.featureStats.reduce((sum, f) => sum + f.seconds, 0);
			const layerTotal = analysis.slowestLayers.reduce((sum, l) => sum + l.seconds, 0);
			expect(featureTotal).toBeCloseTo(analysis.clampedSeconds as number, 6);
			expect(layerTotal).toBeCloseTo(analysis.clampedSeconds as number, 6);
		});

		it("reports no object stats for a file that never uses M486", () => {
			const analysis = analyseText(SAMPLE, undefined, LIMITS);
			expect(analysis.objectStats).toEqual([]);
		});

		it("reports per-object time and filament when M486 is present", () => {
			const text = [
				"M83",
				"M486 S0", "G1 X10 E1 F1200",
				"M486 S1", "G1 X20 E2 F1200",
			].join("\n");
			const analysis = analyseText(text, undefined, LIMITS);
			expect(analysis.objectStats).toHaveLength(2);
			expect(analysis.objectStats.find((o) => o.object === "0")?.filamentMm).toBe(1);
			expect(analysis.objectStats.find((o) => o.object === "1")?.filamentMm).toBe(2);
		});

		it("caps the reported layers at MAX_REPORTED_LAYERS on a file with more layers than that", () => {
			const lines: Array<string> = [];
			for (let i = 0; i < MAX_REPORTED_LAYERS + 10; i++) {
				lines.push(";LAYER_CHANGE", `G1 X${i} F6000`);
			}
			const analysis = analyseText(lines.join("\n"), undefined, LIMITS);
			expect(analysis.slowestLayers.length).toBeLessThanOrEqual(MAX_REPORTED_LAYERS);
		});
	});

	describe("retractionStats", () => {
		it("counts a relative-mode retraction", () => {
			const analysis = analyseText(["T0", "M83", "G1 E-2 F1800"].join("\n"));
			expect(analysis.retractionStats).toEqual([{ tool: 0, count: 1, totalMm: 2 }]);
		});

		it("counts an absolute-mode retraction as the delta, not the raw E value", () => {
			const analysis = analyseText(["T0", "M82", "G1 E10 F1800", "G1 E8 F1800"].join("\n"));
			expect(analysis.retractionStats).toEqual([{ tool: 0, count: 1, totalMm: 2 }]);
		});

		it("does not count G92 E0 as a retraction", () => {
			const analysis = analyseText(["T0", "M82", "G1 E10 F1800", "G92 E0", "G1 E5 F1800"].join("\n"));
			// G92 resets the datum to 0, then G1 E5 is a genuine extrusion (delta +5), not a retraction
			expect(analysis.retractionStats).toEqual([]);
		});

		it("splits retractions per tool", () => {
			const text = [
				"M83",
				"T0", "G1 E-1 F1800",
				"T1", "G1 E-3 F1800", "G1 E-1 F1800",
			].join("\n");
			const analysis = analyseText(text);
			expect(analysis.retractionStats).toEqual([
				{ tool: 0, count: 1, totalMm: 1 },
				{ tool: 1, count: 2, totalMm: 4 },
			]);
		});

		it("does not attribute a retraction before any tool is selected to tool 0", () => {
			const analysis = analyseText(["M83", "G1 E-1 F1800", "T0", "G1 E-1 F1800"].join("\n"));
			// Only the second retraction (after T0) is counted
			expect(analysis.retractionStats).toEqual([{ tool: 0, count: 1, totalMm: 1 }]);
		});
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

	describe("cold extrusion", () => {
		it("errors when extrusion begins with no heating command of any kind", () => {
			const results = runChecks(analyseText("G28\nG1 X1 E1"), MACHINE);
			const issue = results.find((r) => r.code === "structure:coldExtrusionNoWait");
			expect(issue?.level).toBe("error");
		});

		it("downgrades to a warning when a heating command exists but there is no explicit wait", () => {
			const results = runChecks(analyseText("G28\nM104 S210\nG1 X1 E1"), MACHINE);
			const issue = results.find((r) => r.code === "structure:coldExtrusionNoWait");
			expect(issue?.level).toBe("warning");
		});

		it("warns (never errors) when extrusion precedes an explicit wait", () => {
			const results = runChecks(analyseText("G28\nG1 X1 E1\nM109 S210"), MACHINE);
			const issue = results.find((r) => r.code === "structure:coldExtrusion");
			expect(issue?.level).toBe("warning");
		});

		it("reports nothing when the wait happens before extrusion", () => {
			const results = runChecks(analyseText("G28\nM109 S210\nG1 X1 E1"), MACHINE);
			expect(results.some((r) => r.code.startsWith("structure:coldExtrusion"))).toBe(false);
		});

		it("reports nothing for a file with no extrusion at all", () => {
			const results = runChecks(analyseText("G28\nG1 X1"), MACHINE);
			expect(results.some((r) => r.code.startsWith("structure:coldExtrusion"))).toBe(false);
		});
	});

	describe("end-of-file hygiene", () => {
		it("flags heaters never turned off", () => {
			const results = runChecks(analyseText("G28\nM104 S210"), MACHINE);
			expect(results.some((r) => r.code === "structure:heatersLeftOn" && r.level === "info")).toBe(true);
		});

		it("says nothing about heaters when they are turned off", () => {
			const results = runChecks(analyseText("G28\nM104 S210\nM104 S0"), MACHINE);
			expect(results.some((r) => r.code === "structure:heatersLeftOn")).toBe(false);
		});

		it("says nothing about heaters that were never used", () => {
			const results = runChecks(analyseText("G28\nG1 X1"), MACHINE);
			expect(results.some((r) => r.code === "structure:heatersLeftOn")).toBe(false);
		});

		it("flags the part fan never turned off", () => {
			const results = runChecks(analyseText("G28\nM106 S255"), MACHINE);
			expect(results.some((r) => r.code === "structure:fanLeftRunning" && r.level === "info")).toBe(true);
		});

		it("says nothing about a fan that was never used", () => {
			const results = runChecks(analyseText("G28\nG1 X1"), MACHINE);
			expect(results.some((r) => r.code === "structure:fanLeftRunning")).toBe(false);
		});

		it("flags motors never disabled", () => {
			const results = runChecks(analyseText("G28\nG1 X1"), MACHINE);
			expect(results.some((r) => r.code === "structure:motorsLeftEnergised" && r.level === "info")).toBe(true);
		});

		it("says nothing about motors when they are disabled", () => {
			const results = runChecks(analyseText("G28\nG1 X1\nM84"), MACHINE);
			expect(results.some((r) => r.code === "structure:motorsLeftEnergised")).toBe(false);
		});

		it("reports nothing about hygiene for a clean shutdown", () => {
			const results = runChecks(analyseText("G28\nT0\nG1 X1\nM106 S255\nM104 S210\nM107\nM104 S0\nM84"), MACHINE);
			const hygieneCodes = ["structure:heatersLeftOn", "structure:fanLeftRunning", "structure:motorsLeftEnergised"];
			expect(results.some((r) => hygieneCodes.includes(r.code))).toBe(false);
		});
	});

	describe("volumetric flow", () => {
		it("reports an informational line whenever a flow figure exists", () => {
			const meta = parseMetadata("; filament_diameter = 1.75");
			const results = runChecks(analyseText("G28\nG1 X10 F3600 E1", meta), MACHINE);
			expect(results.some((r) => r.code === "flow:peak" && r.level === "info")).toBe(true);
		});

		it("reports nothing about flow when the filament diameter is unknown", () => {
			const results = runChecks(analyseText("G28\nG1 X10 F3600 E1"), MACHINE);
			expect(results.some((r) => r.code.startsWith("flow:"))).toBe(false);
		});

		it("warns when the file exceeds its own stated ceiling", () => {
			const meta = parseMetadata("; filament_diameter = 1.75\n; max_volumetric_speed = 1");
			const results = runChecks(analyseText("G28\nG1 X10 F3600 E1", meta), MACHINE);
			expect(results.some((r) => r.code === "flow:exceedsStated" && r.level === "warning")).toBe(true);
		});

		it("never warns without a stated ceiling, however high the flow", () => {
			const meta = parseMetadata("; filament_diameter = 1.75");
			const results = runChecks(analyseText("G28\nG1 X10 F30000 E10", meta), MACHINE);
			expect(results.some((r) => r.code === "flow:exceedsStated")).toBe(false);
		});

		it("does not warn when the stated ceiling is not exceeded", () => {
			const meta = parseMetadata("; filament_diameter = 1.75\n; max_volumetric_speed = 100");
			const results = runChecks(analyseText("G28\nG1 X10 F3600 E1", meta), MACHINE);
			expect(results.some((r) => r.code === "flow:exceedsStated")).toBe(false);
		});
	});
});
