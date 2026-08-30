import { describe, expect, it } from "vitest";

import { createRecipe, makeStamp, newUid, type Recipe } from "../model/recipe";
import {
	baseName, blocking, checkSafety, dirName, formatBytes, normalisePath, planOutput, samePath,
	splitExtension, type OutputPlan,
} from "../model/io/plan";
import { LARGE_FILE_WARN_BYTES } from "../model/constants";

const SOURCE = "0:/gcodes/prints/benchy.gcode";
const NOW = new Date("2026-08-30T11:22:33");

function recipe(): Recipe {
	return {
		...createRecipe("Test"),
		steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: { find: "x" } }],
	};
}

function safetyInput(overrides: Partial<Parameters<typeof checkSafety>[0]> = {}) {
	const plan = planOutput({ sourcePath: SOURCE, mode: "inPlace", now: NOW });
	return {
		sourcePath: SOURCE,
		plan,
		jobFileName: null,
		status: "idle",
		sizeBytes: 1024,
		existingStamp: null,
		targetExists: false,
		recipe: recipe(),
		...overrides,
	};
}

describe("path helpers", () => {
	it("splits directories, names and extensions", () => {
		expect(dirName(SOURCE)).toBe("0:/gcodes/prints");
		expect(baseName(SOURCE)).toBe("benchy.gcode");
		expect(splitExtension("benchy.gcode")).toEqual({ stem: "benchy", ext: ".gcode" });
		expect(splitExtension("noextension")).toEqual({ stem: "noextension", ext: "" });
		expect(splitExtension(".hidden")).toEqual({ stem: ".hidden", ext: "" });
	});

	it("compares paths across volume-prefix differences", () => {
		expect(samePath("0:/gcodes/a.gcode", "/gcodes/a.gcode")).toBe(true);
		expect(samePath("0:/gcodes/a.gcode", "0:/gcodes/A.GCODE")).toBe(true);
		expect(samePath("0:/gcodes/a.gcode", "0:/gcodes/b.gcode")).toBe(false);
		expect(normalisePath("0://gcodes//a")).toBe("/gcodes/a");
	});

	it("formats sizes", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KiB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
	});
});

describe("planOutput", () => {
	it("overwrites in place, with a timestamped backup", () => {
		const plan = planOutput({ sourcePath: SOURCE, mode: "inPlace", now: NOW });
		expect(plan.targetPath).toBe(SOURCE);
		expect(plan.overwritesSource).toBe(true);
		expect(plan.backupPath).toBe("0:/gcodes/.postproc/backups/benchy.20260830-112233.gcode");
		expect(plan.tempPath).toBe(`${SOURCE}.pp.tmp`);
	});

	it("writes alongside without a backup", () => {
		const plan = planOutput({ sourcePath: SOURCE, mode: "alongside", now: NOW });
		expect(plan.targetPath).toBe("0:/gcodes/prints/benchy.pp.gcode");
		expect(plan.overwritesSource).toBe(false);
		expect(plan.backupPath).toBeNull();
	});

	it("honours a custom suffix", () => {
		const plan = planOutput({ sourcePath: SOURCE, mode: "alongside", suffix: "-fast", now: NOW });
		expect(plan.targetPath).toBe("0:/gcodes/prints/benchy-fast.gcode");
	});

	it("writes into another folder, keeping the name", () => {
		const plan = planOutput({ sourcePath: SOURCE, mode: "folder", folder: "0:/gcodes/out/", now: NOW });
		expect(plan.targetPath).toBe("0:/gcodes/out/benchy.gcode");
	});

	it("notices that a folder target can still be the source", () => {
		const plan = planOutput({ sourcePath: SOURCE, mode: "folder", folder: "0:/gcodes/prints", now: NOW });
		expect(plan.overwritesSource).toBe(true);
		expect(plan.backupPath).not.toBeNull();
	});
});

describe("checkSafety", () => {
	it("passes a normal in-place run", () => {
		expect(blocking(checkSafety(safetyInput()))).toEqual([]);
	});

	it("blocks processing the file that is currently printing", () => {
		const issues = checkSafety(safetyInput({ jobFileName: SOURCE, status: "processing" }));
		expect(blocking(issues).map((i) => i.code)).toContain("sourceIsJob");
	});

	it("blocks it even when the path prefix differs", () => {
		const issues = checkSafety(safetyInput({ jobFileName: "/gcodes/prints/benchy.gcode" }));
		expect(blocking(issues).map((i) => i.code)).toContain("sourceIsJob");
	});

	it("blocks writing onto the printing file from a different source", () => {
		const plan: OutputPlan = planOutput({ sourcePath: "0:/gcodes/other.gcode", mode: "folder", folder: "0:/gcodes/prints", now: NOW });
		// The output lands on prints/other.gcode, which is what the printer is reading
		const issues = checkSafety(safetyInput({
			sourcePath: "0:/gcodes/other.gcode", plan, jobFileName: "0:/gcodes/prints/other.gcode",
		}));
		expect(blocking(issues).map((i) => i.code)).toContain("targetIsJob");
	});

	it("warns while the machine is printing something else", () => {
		const issues = checkSafety(safetyInput({ jobFileName: "0:/gcodes/other.gcode", status: "processing" }));
		expect(blocking(issues)).toEqual([]);
		expect(issues.map((i) => i.code)).toContain("machineBusy");
	});

	it("warns when this recipe has already been applied", () => {
		const r = recipe();
		const stamps = makeStamp(r, "0.1.0");
		const stamp = { pluginVersion: "0.1.0", recipe: r.name, hash: stamps.split("hash=")[1].split(" ")[0], at: "2026-01-01" };
		const issues = checkSafety(safetyInput({ existingStamp: stamp, recipe: r }));
		expect(issues.map((i) => i.code)).toContain("alreadyProcessed");
		expect(blocking(issues)).toEqual([]);
	});

	it("warns before replacing an existing target", () => {
		const plan = planOutput({ sourcePath: SOURCE, mode: "alongside", now: NOW });
		const issues = checkSafety(safetyInput({ plan, targetExists: true }));
		expect(issues.map((i) => i.code)).toContain("targetExists");
	});

	it("warns about a very large file", () => {
		const issues = checkSafety(safetyInput({ sizeBytes: LARGE_FILE_WARN_BYTES + 1 }));
		expect(issues.map((i) => i.code)).toContain("largeFile");
	});

	it("blocks an in-place write that somehow has no backup path", () => {
		const plan: OutputPlan = { ...planOutput({ sourcePath: SOURCE, mode: "inPlace", now: NOW }), backupPath: null };
		expect(blocking(checkSafety(safetyInput({ plan }))).map((i) => i.code)).toContain("noBackup");
	});
});
