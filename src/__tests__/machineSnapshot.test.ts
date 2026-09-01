import { describe, expect, it } from "vitest";

import {
	installedPluginVersion, jobFileName, machineLimits, machineLimitsComplete, machineStatus,
	simulationStatus, toolHeaterConfigs,
} from "../dwc/machineSnapshot";

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

describe("simulationStatus", () => {
	it("returns null status and null duration for an empty model", () => {
		expect(simulationStatus({})).toEqual({ status: null, lastDurationSeconds: null });
	});

	it("reads the status and the last job's duration together", () => {
		const model = { state: { status: "Simulating" }, job: { lastDuration: 3723 } };
		expect(simulationStatus(model)).toEqual({ status: "simulating", lastDurationSeconds: 3723 });
	});

	it("treats a non-finite or missing lastDuration as null, not 0 or NaN", () => {
		expect(simulationStatus({ job: { lastDuration: null } }).lastDurationSeconds).toBeNull();
		expect(simulationStatus({ job: {} }).lastDurationSeconds).toBeNull();
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

describe("toolHeaterConfigs", () => {
	it("returns each tool's heaters with their temperatures and tuned model", () => {
		const model = {
			tools: [{ number: 0, heaters: [1], active: [200], standby: [140] }],
			heat: { heaters: [
				{ max: 120 },
				{ max: 285, model: { heatingRate: 2.43, deadTime: 5.5, coolingRate: 0.56, coolingExp: 1.35 } },
			] },
		};
		const configs = toolHeaterConfigs(model);
		expect(configs).toEqual([
			{
				toolNumber: 0,
				heaters: [{
					heaterIndex: 1, active: 200, standby: 140,
					model: { heatingRate: 2.43, deadTime: 5.5, coolingRate: 0.56, coolingExp: 1.35 },
				}],
			},
		]);
	});

	it("gives a tool with no heaters an empty heaters array rather than omitting it", () => {
		const model = { tools: [{ number: 3, heaters: [] }], heat: { heaters: [] } };
		expect(toolHeaterConfigs(model)).toEqual([{ toolNumber: 3, heaters: [] }]);
	});

	it("returns a null model for an untuned heater rather than guessing a heating rate", () => {
		const model = {
			tools: [{ number: 0, heaters: [0], active: [200], standby: [140] }],
			heat: { heaters: [{ max: 285 }] },
		};
		expect(toolHeaterConfigs(model)[0].heaters[0].model).toBeNull();
	});

	it("treats a zero or missing heatingRate as untuned", () => {
		const model = {
			tools: [{ number: 0, heaters: [0], active: [200], standby: [140] }],
			heat: { heaters: [{ model: { heatingRate: 0, deadTime: 5, coolingRate: 1, coolingExp: 1.35 } }] },
		};
		expect(toolHeaterConfigs(model)[0].heaters[0].model).toBeNull();
	});

	it("defaults missing temperatures to 0 and skips a null tool slot", () => {
		const model = { tools: [null, { number: 1, heaters: [0] }], heat: { heaters: [{}] } };
		const configs = toolHeaterConfigs(model);
		expect(configs).toEqual([{ toolNumber: 1, heaters: [{ heaterIndex: 0, active: 0, standby: 0, model: null }] }]);
	});

	it("returns an empty array for a model with no tools", () => {
		expect(toolHeaterConfigs({})).toEqual([]);
	});
});

describe("machineLimitsComplete", () => {
	const FULL_MODEL = {
		move: {
			axes: [
				{ letter: "X", speed: 200, acceleration: 1500, jerk: 15 },
				{ letter: "Y", speed: 200, acceleration: 1500, jerk: 15 },
				{ letter: "Z", speed: 20, acceleration: 100, jerk: 2 },
			],
			extruders: [{ speed: 50, acceleration: 1000, jerk: 5 }],
			motionSystems: [{ printingAcceleration: 1000, travelAcceleration: 1500 }],
		},
	};

	it("is true for a fully specified machine", () => {
		expect(machineLimitsComplete(FULL_MODEL)).toBe(true);
	});

	it("is false for an empty model", () => {
		expect(machineLimitsComplete({})).toBe(false);
		expect(machineLimitsComplete(null)).toBe(false);
	});

	it("is false when one axis is missing acceleration, even though the others are complete", () => {
		const model = {
			move: {
				...FULL_MODEL.move,
				axes: [
					{ letter: "X", speed: 200, acceleration: 1500, jerk: 15 },
					{ letter: "Y", speed: 200, jerk: 15 }, // no acceleration
				],
			},
		};
		expect(machineLimitsComplete(model)).toBe(false);
	});

	it("is false when there is no extruder at all", () => {
		const model = { move: { ...FULL_MODEL.move, extruders: [] } };
		expect(machineLimitsComplete(model)).toBe(false);
	});

	it("is false when the extruder is missing one of its own limits", () => {
		const model = { move: { ...FULL_MODEL.move, extruders: [{ speed: 50, acceleration: 1000 }] } };
		expect(machineLimitsComplete(model)).toBe(false);
	});

	it("is false when neither motionSystems nor the deprecated top-level acceleration fields are present", () => {
		const model = { move: { axes: FULL_MODEL.move.axes, extruders: FULL_MODEL.move.extruders } };
		expect(machineLimitsComplete(model)).toBe(false);
	});

	it("is true when the deprecated top-level acceleration fields stand in for motionSystems", () => {
		const model = {
			move: {
				axes: FULL_MODEL.move.axes,
				extruders: FULL_MODEL.move.extruders,
				printingAcceleration: 1000,
				travelAcceleration: 1500,
			},
		};
		expect(machineLimitsComplete(model)).toBe(true);
	});
});
