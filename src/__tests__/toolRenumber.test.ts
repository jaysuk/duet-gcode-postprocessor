import { describe, expect, it } from "vitest";

import { parseToolMapping } from "../model/steps/toolRenumber";
import { StepConfigError } from "../model/steps/types";
import { runStep } from "./helpers";

describe("parseToolMapping", () => {
	it("parses a comma-separated list of old->new pairs", () => {
		const mapping = parseToolMapping("0->2, 1->0");
		expect(mapping.get(0)).toBe(2);
		expect(mapping.get(1)).toBe(0);
	});

	it("returns an empty mapping for blank input", () => {
		expect(parseToolMapping("").size).toBe(0);
		expect(parseToolMapping("   ").size).toBe(0);
	});

	it("rejects a malformed pair", () => {
		expect(() => parseToolMapping("0=>2")).toThrow(StepConfigError);
		expect(() => parseToolMapping("garbage")).toThrow(StepConfigError);
	});

	it("rejects a tool number mapped more than once", () => {
		expect(() => parseToolMapping("0->1, 0->2")).toThrow(/mapped more than once/);
	});
});

describe("toolRenumber", () => {
	it("renumbers a bare T command line", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "T0")).toBe("T2");
	});

	it("does not renumber T0 inside a comment", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "; use T0 for this")).toBe("; use T0 for this");
	});

	it("does not renumber T0 appearing as text inside another command", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "M117 T0")).toBe("M117 T0");
	});

	it("renumbers M563/M567/M568/M116's tool-number parameter", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "M563 P0 D0 H1")).toBe("M563 P2 D0 H1");
		expect(runStep("toolRenumber", { mapping: "0->2" }, "M567 P0 E1:0")).toBe("M567 P2 E1:0");
		expect(runStep("toolRenumber", { mapping: "0->2" }, "M568 P0 S210")).toBe("M568 P2 S210");
		expect(runStep("toolRenumber", { mapping: "0->2" }, "M116 P0")).toBe("M116 P2");
	});

	// G10's P is a tool number in its tool-settings form (temperatures or offsets) and a workplace
	// coordinate system number in its L2/L20 form. It used to be left alone entirely; the shared
	// g10Form (gcode/toolTemperature.ts) now tells the two apart by RepRapFirmware's own rule
	it("renumbers G10's P in its tool-settings form — temperatures and tool offsets", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "G10 P0 R150 S210")).toBe("G10 P2 R150 S210");
		expect(runStep("toolRenumber", { mapping: "0->2" }, "G10 P0 X17.8 Y-19.3 Z0")).toBe("G10 P2 X17.8 Y-19.3 Z0");
		expect(runStep("toolRenumber", { mapping: "0->2" }, "G10 L1 P0 X17.8")).toBe("G10 L1 P2 X17.8");
	});

	it("does not renumber G10 L2/L20's P — that is a workplace coordinate system, not a tool", () => {
		expect(runStep("toolRenumber", { mapping: "1->2" }, "G10 L2 P1 X110 Y110 Z20")).toBe("G10 L2 P1 X110 Y110 Z20");
		expect(runStep("toolRenumber", { mapping: "1->2" }, "G10 L20 P1 X0 Y0 Z0")).toBe("G10 L20 P1 X0 Y0 Z0");
	});

	it("leaves a bare G10 retraction alone", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "G10")).toBe("G10");
	});

	it("does not renumber M106/M107's P — that is a fan index, not a tool", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "M106 P0 S255")).toBe("M106 P0 S255");
		expect(runStep("toolRenumber", { mapping: "0->2" }, "M107 P0")).toBe("M107 P0");
	});

	it("does not renumber M585's P — that is a Z probe number, not a tool", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "M585 X100 F600 P0 S0")).toBe("M585 X100 F600 P0 S0");
	});

	it("resolves a simultaneous swap against the original numbers, not sequentially", () => {
		const out = runStep("toolRenumber", { mapping: "0->1, 1->0" }, "T0\nT1");
		expect(out).toBe("T1\nT0");
	});

	it("leaves a tool not in the mapping untouched", () => {
		expect(runStep("toolRenumber", { mapping: "0->2" }, "T1")).toBe("T1");
	});
});
