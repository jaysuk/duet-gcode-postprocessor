import { describe, expect, it } from "vitest";

import { exceedsBackupCap, runBatch } from "../model/io/batch";
import { parseHistory } from "../model/io/history";
import { HISTORY_INDEX } from "../model/constants";
import { createRecipe, newUid, type Recipe } from "../model/recipe";
import { FakeGateway, SAMPLE } from "./helpers";

function recipe(): Recipe {
	return {
		...createRecipe("Halve the speed"),
		steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: { find: "F1800", replace: "F900" } }],
	};
}

function baseOptions(gateway: FakeGateway, paths: Array<string>) {
	return {
		gateway,
		paths,
		recipe: recipe(),
		mode: "alongside" as const,
		pluginVersion: "0.1.0",
		scriptsTrusted: false,
		jobFileName: null,
		machineStatus: "idle",
	};
}

describe("runBatch", () => {
	it("processes three files, in order, all done", async () => {
		const gateway = new FakeGateway({
			"0:/gcodes/a.gcode": SAMPLE + "\n",
			"0:/gcodes/b.gcode": SAMPLE + "\n",
			"0:/gcodes/c.gcode": SAMPLE + "\n",
		});
		const outcomes = await runBatch(baseOptions(gateway, [
			"0:/gcodes/a.gcode", "0:/gcodes/b.gcode", "0:/gcodes/c.gcode",
		]));
		expect(outcomes.map((o) => o.path)).toEqual(["0:/gcodes/a.gcode", "0:/gcodes/b.gcode", "0:/gcodes/c.gcode"]);
		expect(outcomes.every((o) => o.outcome === "done")).toBe(true);
	});

	it("keeps going after one file fails, and records the failure against the right path", async () => {
		const gateway = new FakeGateway({
			"0:/gcodes/a.gcode": SAMPLE + "\n",
			"0:/gcodes/c.gcode": SAMPLE + "\n",
			// b.gcode deliberately missing — its download throws
		});
		const outcomes = await runBatch(baseOptions(gateway, [
			"0:/gcodes/a.gcode", "0:/gcodes/b.gcode", "0:/gcodes/c.gcode",
		]));
		expect(outcomes.map((o) => o.outcome)).toEqual(["done", "failed", "done"]);
		expect(outcomes[1].path).toBe("0:/gcodes/b.gcode");
		expect(outcomes[1].error).toBeDefined();
	});

	it("skips (not fails) a file that is the current print job", async () => {
		const gateway = new FakeGateway({ "0:/gcodes/a.gcode": SAMPLE + "\n" });
		const outcomes = await runBatch({
			...baseOptions(gateway, ["0:/gcodes/a.gcode"]),
			jobFileName: "0:/gcodes/a.gcode",
		});
		expect(outcomes[0].outcome).toBe("skipped");
		expect(outcomes[0].reason).toBeDefined();
	});

	it("stops after the first file when cancelled, leaving the rest never started", async () => {
		const gateway = new FakeGateway({
			"0:/gcodes/a.gcode": SAMPLE + "\n",
			"0:/gcodes/b.gcode": SAMPLE + "\n",
			"0:/gcodes/c.gcode": SAMPLE + "\n",
		});
		const signal = { aborted: false };
		const outcomes = await runBatch({
			...baseOptions(gateway, ["0:/gcodes/a.gcode", "0:/gcodes/b.gcode", "0:/gcodes/c.gcode"]),
			signal,
			onFileDone: () => { signal.aborted = true; },
		});
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].path).toBe("0:/gcodes/a.gcode");
	});

	// The batch used to download and prescan every file purely to compute `existingStamp`, which
	// checkSafety returns at warn level and this loop never reads — a second full transfer of every
	// file in the batch for nothing. `processFile` prescans the copy it fetches anyway.
	it("transfers each file exactly once", async () => {
		const gateway = new FakeGateway({
			"0:/gcodes/a.gcode": SAMPLE + "\n",
			"0:/gcodes/b.gcode": SAMPLE + "\n",
		});
		await runBatch(baseOptions(gateway, ["0:/gcodes/a.gcode", "0:/gcodes/b.gcode"]));
		expect(gateway.log.filter((l) => l === "download 0:/gcodes/a.gcode")).toHaveLength(1);
		expect(gateway.log.filter((l) => l === "download 0:/gcodes/b.gcode")).toHaveLength(1);
	});

	it("still reports the already-processed stamp, from the result rather than a second fetch", async () => {
		const gateway = new FakeGateway({ "0:/gcodes/a.gcode": SAMPLE + "\n" });
		const r = recipe();
		await runBatch({ ...baseOptions(gateway, ["0:/gcodes/a.gcode"]), recipe: r });
		// Re-run the same recipe over the output of the first run, which now carries its stamp
		const second = await runBatch({
			...baseOptions(gateway, ["0:/gcodes/a.pp.gcode"]), recipe: r,
		});
		expect(second[0].result?.existingStamp).not.toBeNull();
	});

	it("records one history entry per applied file, with origin batch", async () => {
		const gateway = new FakeGateway({
			"0:/gcodes/a.gcode": SAMPLE + "\n",
			"0:/gcodes/b.gcode": SAMPLE + "\n",
		});
		await runBatch(baseOptions(gateway, ["0:/gcodes/a.gcode", "0:/gcodes/b.gcode"]));
		const history = parseHistory(gateway.files.get(HISTORY_INDEX) ?? "");
		expect(history).toHaveLength(2);
		expect(history.every((h) => h.origin === "batch")).toBe(true);
	});
});

describe("exceedsBackupCap", () => {
	it("is true only for in-place mode over more files than the cap", () => {
		expect(exceedsBackupCap("inPlace", 25, 20)).toBe(true);
		expect(exceedsBackupCap("inPlace", 20, 20)).toBe(false);
		expect(exceedsBackupCap("alongside", 25, 20)).toBe(false);
		expect(exceedsBackupCap("folder", 25, 20)).toBe(false);
	});
});
