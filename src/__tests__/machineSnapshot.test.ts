import { describe, expect, it } from "vitest";

import { installedPluginVersion, jobFileName, machineStatus } from "../dwc/machineSnapshot";

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
