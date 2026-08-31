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
});
