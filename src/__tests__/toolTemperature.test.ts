import { describe, expect, it } from "vitest";

import { g10Form, readToolTemperatureSetting } from "../model/gcode/toolTemperature";

// RRF's own dispatch (GCodes2.cpp, case 10) — the one rule every G10 reader in the plugin now shares
describe("g10Form", () => {
	it("a completely bare G10 is a firmware retraction", () => {
		expect(g10Form("G10")).toBe("retract");
	});

	it("G10 with a parameter that marks nothing as tool settings is still a retraction, as in RRF", () => {
		expect(g10Form("G10 F1500")).toBe("retract");
	});

	it("an S or R with no P is the current tool's temperature, not a retraction", () => {
		expect(g10Form("G10 S200")).toBe("toolSettings");
		expect(g10Form("G10 R150")).toBe("toolSettings");
	});

	it("P with temperatures or offsets is tool settings", () => {
		expect(g10Form("G10 P1 R140 S205")).toBe("toolSettings");
		expect(g10Form("G10 P2 X17.8 Y-19.3 Z0.0")).toBe("toolSettings");
	});

	it("an axis letter with no P is an offset for the current tool", () => {
		expect(g10Form("G10 X10")).toBe("toolSettings");
		expect(g10Form("G10 U5")).toBe("toolSettings");
	});

	it("L1 is tool settings, the same as no L", () => {
		expect(g10Form("G10 L1 P2 X17.8")).toBe("toolSettings");
	});

	it("L2 and L20 are workplace offsets, where P is a coordinate system and not a tool", () => {
		expect(g10Form("G10 L2 P2 X110 Y110 Z20")).toBe("workplace");
		expect(g10Form("G10 L20 P2 X0 Y0 Z0")).toBe("workplace");
	});

	it("any other L is rejected by the firmware and is none of the three", () => {
		expect(g10Form("G10 L5 P1")).toBe("unrecognised");
	});
});

describe("readToolTemperatureSetting", () => {
	describe("M568", () => {
		it("reads tool, active and standby temperatures", () => {
			expect(readToolTemperatureSetting("M568", "M568 P1 R150 S210")).toEqual({
				tool: 1, active: [210], standby: [150], setsTemperatures: true, heaterState: null,
			});
		});

		it("reads every heater of a multi-heater list", () => {
			expect(readToolTemperatureSetting("M568", "M568 P0 S185:200:150")?.active).toEqual([185, 200, 150]);
		});

		it("addresses the current tool when there is no P", () => {
			expect(readToolTemperatureSetting("M568", "M568 S210")?.tool).toBeNull();
		});

		it("is still read with no temperatures at all, since A alone changes heater state", () => {
			expect(readToolTemperatureSetting("M568", "M568 P0 A2")).toEqual({
				tool: 0, active: [], standby: [], setsTemperatures: false, heaterState: 2,
			});
		});

		// Predictive pre-heat asks "are this tool's temperatures established here?", which an
		// expression answers yes to even though there is no number in it to read
		it("records that temperatures are set even when the value is an expression it cannot read", () => {
			const setting = readToolTemperatureSetting("M568", "M568 P1 S{global.printTemp}");
			expect(setting?.setsTemperatures).toBe(true);
			expect(setting?.active).toEqual([]);
		});
	});

	describe("G10 — only the temperature form, per RRF's own dispatch in GCodes2.cpp case 10", () => {
		it("reads G10 P S R as tool temperatures", () => {
			expect(readToolTemperatureSetting("G10", "G10 P1 R140 S205")).toEqual({
				tool: 1, active: [205], standby: [140], setsTemperatures: true, heaterState: null,
			});
		});

		it("reads G10 S with no P as the current tool's temperature — RRF treats any S/R/P as tool settings", () => {
			expect(readToolTemperatureSetting("G10", "G10 S200")).toEqual({
				tool: null, active: [200], standby: [], setsTemperatures: true, heaterState: null,
			});
		});

		it("reads G10 L1 as tool settings, the same as no L", () => {
			expect(readToolTemperatureSetting("G10", "G10 L1 P2 S200")?.active).toEqual([200]);
		});

		it("is not a temperature for a bare G10 — that is a firmware retraction", () => {
			expect(readToolTemperatureSetting("G10", "G10")).toBeNull();
		});

		it("is not a temperature for G10 setting only tool offsets", () => {
			expect(readToolTemperatureSetting("G10", "G10 P2 X17.8 Y-19.3 Z0.0")).toBeNull();
		});

		it("is not a temperature for G10 L2/L20 — those are workplace coordinate offsets", () => {
			expect(readToolTemperatureSetting("G10", "G10 L2 P2 X110 Y110 Z20")).toBeNull();
			expect(readToolTemperatureSetting("G10", "G10 L20 P2 S200")).toBeNull();
		});
	});

	it("is null for any other command", () => {
		expect(readToolTemperatureSetting("M104", "M104 S210")).toBeNull();
		expect(readToolTemperatureSetting(null, "; a comment")).toBeNull();
	});
});
