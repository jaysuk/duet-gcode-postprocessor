import { describe, expect, it } from "vitest";

import { installedPluginVersion, jobFileName, machineLimits, machineStatus } from "../dwc/machineSnapshot";

describe("installedPluginVersion", () => {
	it("returns 0.0.0 when the model has no plugins map at all", () => {
		expect(installedPluginVersion({}, "GCodePostProcessor")).toBe("0.0.0");
		expect(installedPluginVersion(null, "GCodePostProcessor")).toBe("0.0.0");
		expect(installedPluginVersion(undefined, "GCodePostProcessor")).toBe("0.0.0");
	});

	it("returns 0.0.0 when this plugin is not in the plugins map", () => {
		const model = { plugins: new Map([["SomeOtherPlugin", { version: "1.2.3" }]]) };
		expect(installedPluginVersion(model, "GCodePostProcessor")).toBe("0.0.0");
	});

	it("returns the installed version when present", () => {
		const model = { plugins: new Map([["GCodePostProcessor", { version: "0.3.1" }]]) };
		expect(installedPluginVersion(model, "GCodePostProcessor")).toBe("0.3.1");
	});
});

describe("jobFileName and machineStatus", () => {
	it("return null for an empty model", () => {
		expect(jobFileName({})).toBeNull();
		expect(machineStatus({})).toBeNull();
	});

	it("read the job file name and lower-case the status", () => {
		const model = { job: { file: { fileName: "0:/gcodes/benchy.gcode" } }, state: { status: "Processing" } };
		expect(jobFileName(model)).toBe("0:/gcodes/benchy.gcode");
		expect(machineStatus(model)).toBe("processing");
	});
});

describe("machineLimits", () => {
	it("returns empty maps and null accelerations for an empty model", () => {
		const limits = machineLimits({});
		expect(limits).toEqual({ maxSpeed: {}, maxAccel: {}, jerk: {}, printAccel: null, travelAccel: null });
	});

	it("reads per-axis speed/acceleration/jerk keyed by letter", () => {
		const model = {
			move: {
				axes: [
					{ letter: "X", speed: 200, acceleration: 1500, jerk: 15 },
					{ letter: "Y", speed: 200, acceleration: 1500, jerk: 15 },
					{ letter: "Z", speed: 20, acceleration: 100, jerk: 2 },
				],
			},
		};
		const limits = machineLimits(model);
		expect(limits.maxSpeed).toEqual({ X: 200, Y: 200, Z: 20 });
		expect(limits.maxAccel).toEqual({ X: 1500, Y: 1500, Z: 100 });
		expect(limits.jerk).toEqual({ X: 15, Y: 15, Z: 2 });
	});

	it("skips an axis entry with no letter", () => {
		const model = { move: { axes: [{ speed: 999 }, { letter: "X", speed: 200 }] } };
		expect(machineLimits(model).maxSpeed).toEqual({ X: 200 });
	});

	it("exposes the first extruder's limits under the 'E' key, not by axis letter", () => {
		const model = { move: { extruders: [{ speed: 50, acceleration: 1000, jerk: 5 }] } };
		const limits = machineLimits(model);
		expect(limits.maxSpeed.E).toBe(50);
		expect(limits.maxAccel.E).toBe(1000);
		expect(limits.jerk.E).toBe(5);
	});

	it("uses only the first configured extruder, skipping null slots", () => {
		const model = { move: { extruders: [null, { speed: 50 }, { speed: 999 }] } };
		expect(machineLimits(model).maxSpeed.E).toBe(50);
	});

	it("does not set the E key when there are no extruders", () => {
		const limits = machineLimits({ move: { extruders: [] } });
		expect(limits.maxSpeed.E).toBeUndefined();
	});

	it("prefers motionSystems[].printingAcceleration/travelAcceleration over the deprecated top-level fields", () => {
		const model = {
			move: {
				motionSystems: [{ printingAcceleration: 3000, travelAcceleration: 6000 }],
				printingAcceleration: 10000,
				travelAcceleration: 10000,
			},
		};
		const limits = machineLimits(model);
		expect(limits.printAccel).toBe(3000);
		expect(limits.travelAccel).toBe(6000);
	});

	it("falls back to the deprecated top-level acceleration fields when motionSystems is absent", () => {
		const model = { move: { printingAcceleration: 4000, travelAccel: 8000, travelAcceleration: 8000 } };
		const limits = machineLimits(model);
		expect(limits.printAccel).toBe(4000);
		expect(limits.travelAccel).toBe(8000);
	});

	it("falls back to the deprecated fields when motionSystems is present but empty", () => {
		const model = { move: { motionSystems: [], printingAcceleration: 4000, travelAcceleration: 8000 } };
		const limits = machineLimits(model);
		expect(limits.printAccel).toBe(4000);
		expect(limits.travelAccel).toBe(8000);
	});

	it("returns null accelerations, not undefined or NaN, when nothing is configured", () => {
		const limits = machineLimits({ move: {} });
		expect(limits.printAccel).toBeNull();
		expect(limits.travelAccel).toBeNull();
	});
});
