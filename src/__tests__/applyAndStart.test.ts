import { describe, expect, it } from "vitest";

import { applyAndStart, ApplyAndStartRefusedError } from "../model/io/applyAndStart";
import { planOutput } from "../model/io/plan";
import { CancelledError } from "../model/io/transfer";
import { createRecipe, newUid, type Recipe } from "../model/recipe";
import { FakeGateway, SAMPLE } from "./helpers";

const SOURCE = "0:/gcodes/benchy.gcode";

function recipe(): Recipe {
	return {
		...createRecipe("Halve the speed"),
		steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: { find: "F1800", replace: "F900" } }],
	};
}

function run(gateway: FakeGateway, overrides: Record<string, unknown> = {}) {
	return applyAndStart({
		gateway,
		sourcePath: SOURCE,
		recipe: recipe(),
		plan: planOutput({ sourcePath: SOURCE, mode: "inPlace", now: new Date("2026-08-30T11:22:33") }),
		pluginVersion: "0.1.0",
		scriptsTrusted: false,
		dryRun: false,
		machineStatus: () => "idle",
		...overrides,
	});
}

describe("applyAndStart", () => {
	it("applies the recipe, then sends M32 for the final target path", async () => {
		const gateway = new FakeGateway({ [SOURCE]: SAMPLE + "\n" });
		const result = await run(gateway);
		expect(gateway.sentCodes).toEqual([`M32 "${result.targetPath}"`]);
	});

	it("refuses a dry run before doing anything", async () => {
		const gateway = new FakeGateway({ [SOURCE]: SAMPLE + "\n" });
		await expect(run(gateway, { dryRun: true })).rejects.toThrow(ApplyAndStartRefusedError);
		expect(gateway.log).toEqual([]); // not even downloaded
	});

	it("refuses to start when the machine is already busy, without applying anything", async () => {
		const gateway = new FakeGateway({ [SOURCE]: SAMPLE + "\n" });
		await expect(run(gateway, { machineStatus: () => "processing" })).rejects.toThrow(ApplyAndStartRefusedError);
		expect(gateway.log).toEqual([]);
	});

	it("throws if the machine refuses the M32 itself, after the file was already applied", async () => {
		const gateway = new FakeGateway({ [SOURCE]: SAMPLE + "\n" });
		gateway.codeReply = "Error: Cannot set file to print, because a file is already being printed";
		await expect(run(gateway)).rejects.toThrow(ApplyAndStartRefusedError);
		// The file was still written — only the M32 was refused
		expect(gateway.files.get(SOURCE)).toContain("F900");
	});

	it("does not send M32 when the run was cancelled — the underlying CancelledError propagates", async () => {
		const gateway = new FakeGateway({ [SOURCE]: SAMPLE + "\n" });
		const signal = { aborted: true };
		await expect(run(gateway, { signal })).rejects.toThrow(CancelledError);
		expect(gateway.sentCodes).toEqual([]);
	});
});
