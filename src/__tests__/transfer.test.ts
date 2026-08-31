import { beforeEach, describe, expect, it } from "vitest";

import type { MachineLimits } from "../model/gcode/timeModel";
import { planOutput } from "../model/io/plan";
import { CancelledError, processFile } from "../model/io/transfer";
import { createRecipe, newUid, type Recipe } from "../model/recipe";
import { FakeGateway, SAMPLE } from "./helpers";

const SOURCE = "0:/gcodes/benchy.gcode";

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
};

function rewriteTimeRecipe(): Recipe {
	return {
		...createRecipe("Rewrite time"),
		steps: [{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} }],
	};
}

function recipe(config: Record<string, unknown> = { find: "F1800", replace: "F900" }): Recipe {
	return {
		...createRecipe("Halve the speed"),
		steps: [{ uid: newUid(), type: "findReplace", enabled: true, config }],
	};
}

function run(gateway: FakeGateway, overrides: Record<string, unknown> = {}) {
	return processFile({
		gateway,
		sourcePath: SOURCE,
		recipe: recipe(),
		plan: planOutput({ sourcePath: SOURCE, mode: "inPlace", now: new Date("2026-08-30T11:22:33") }),
		pluginVersion: "0.1.0",
		scriptsTrusted: false,
		dryRun: false,
		...overrides,
	});
}

describe("processFile", () => {
	let gateway: FakeGateway;

	beforeEach(() => {
		gateway = new FakeGateway({ [SOURCE]: SAMPLE + "\n" });
	});

	it("writes the transformed file back", async () => {
		const result = await run(gateway);
		const written = gateway.files.get(SOURCE)!;
		expect(written).toContain("F900");
		expect(written).not.toContain("F1800");
		expect(result.stats.linesChanged).toBe(3);
	});

	it("backs up, records it in the index, uploads to a temp name, then moves — in that order", async () => {
		await run(gateway);
		const order = gateway.log.filter((l) => !l.startsWith("download"));
		expect(order).toEqual([
			"mkdir 0:/postproc/backups",
			"upload 0:/postproc/backups/benchy.20260830-112233.gcode",
			"upload 0:/postproc/backups.json",
			"upload 0:/gcodes/benchy.gcode.pp.tmp",
			"move 0:/gcodes/benchy.gcode.pp.tmp -> 0:/gcodes/benchy.gcode",
		]);
	});

	it("keeps the original intact when the upload fails", async () => {
		gateway.failUploadOn = `${SOURCE}.pp.tmp`;
		await expect(run(gateway)).rejects.toThrow("network died");
		expect(gateway.files.get(SOURCE)).toBe(SAMPLE + "\n");
		expect(gateway.files.has(`${SOURCE}.pp.tmp`)).toBe(false);
	});

	it("keeps a readable backup of the original", async () => {
		const result = await run(gateway);
		expect(result.backupPath).not.toBeNull();
		expect(gateway.files.get(result.backupPath!)).toBe(SAMPLE + "\n");
	});

	it("fails loudly when the written size does not match", async () => {
		gateway.corruptTargetSize = true;
		await expect(run(gateway)).rejects.toThrow(/Verification failed/);
	});

	it("stamps the output so a repeat run can be detected", async () => {
		await run(gateway);
		const written = gateway.files.get(SOURCE)!;
		expect(written.split("\n")[0]).toMatch(/^; postprocessed-by: GCodePostProcessor v0\.1\.0 recipe="Halve the speed" hash=/);

		const second = new FakeGateway({ [SOURCE]: written });
		const result = await run(second);
		expect(result.existingStamp).not.toBeNull();
		expect(result.existingStamp?.recipe).toBe("Halve the speed");
	});

	it("writes nothing at all on a dry run", async () => {
		const result = await run(gateway, { dryRun: true });
		expect(gateway.log.filter((l) => !l.startsWith("download"))).toEqual([]);
		expect(gateway.files.get(SOURCE)).toBe(SAMPLE + "\n");
		expect(result.stats.linesChanged).toBe(3);
		expect(result.diff).toHaveLength(3);
		expect(result.dryRun).toBe(true);
	});

	it("does not stamp a dry run's statistics with a line it will not write", async () => {
		const dry = await run(gateway, { dryRun: true });
		const wet = await run(new FakeGateway({ [SOURCE]: SAMPLE + "\n" }));
		// The wet run writes one extra line (the stamp); everything else must agree
		expect(wet.stats.linesOut).toBe(dry.stats.linesOut + 1);
	});

	it("reports progress through every phase", async () => {
		const phases: Array<string> = [];
		await run(gateway, { onProgress: (u: { phase: string }) => phases.push(u.phase) });
		expect(new Set(phases)).toEqual(new Set(["downloading", "scanning", "processing", "uploading", "finalising", "done"]));
	});

	it("stops when cancelled, without writing", async () => {
		const signal = { aborted: true };
		await expect(run(gateway, { signal })).rejects.toBeInstanceOf(CancelledError);
		expect(gateway.files.get(SOURCE)).toBe(SAMPLE + "\n");
	});

	it("collects an analysis in the same pass when asked", async () => {
		const result = await run(gateway, { dryRun: true, analyse: true });
		expect(result.analysis?.layers).toBe(3);
		expect(result.analysis?.tools).toEqual([0]);
	});

	it("does not report an analysing phase for a recipe with no lookahead steps", async () => {
		const phases: Array<string> = [];
		const result = await run(gateway, { onProgress: (u: { phase: string }) => phases.push(u.phase) });
		expect(phases).not.toContain("analysing");
		expect(result.analysisMs).toBeNull();
	});

	it("times the analysis pass separately from the transform pass when one ran", async () => {
		const result = await run(gateway, { recipe: rewriteTimeRecipe(), limits: LIMITS });
		expect(result.analysisMs).not.toBeNull();
		expect(result.analysisMs!).toBeGreaterThanOrEqual(0);
		expect(result.transformMs).toBeGreaterThanOrEqual(0);
	});

	it("runs a separate analysing phase for a step that declares a collector", async () => {
		const phases: Array<string> = [];
		await run(gateway, {
			recipe: rewriteTimeRecipe(),
			limits: LIMITS,
			onProgress: (u: { phase: string }) => phases.push(u.phase),
		});
		expect(phases).toContain("analysing");
		expect(phases).toContain("processing");
	});

	it("rewrites M73 markers using a total from the analysis pass, end to end", async () => {
		await run(gateway, { recipe: rewriteTimeRecipe(), limits: LIMITS });
		const written = gateway.files.get(SOURCE)!;
		expect(written).toContain("P100 R0");
	});

	it("cancels during the analysis pass before any transform work or writing happens", async () => {
		const signal = { aborted: false };
		const promise = run(gateway, {
			recipe: rewriteTimeRecipe(),
			limits: LIMITS,
			chunkBytes: 3,
			signal,
			onProgress: (u: { phase: string }) => { if (u.phase === "analysing") signal.aborted = true; },
		});
		await expect(promise).rejects.toBeInstanceOf(CancelledError);
		expect(gateway.files.get(SOURCE)).toBe(SAMPLE + "\n");
		expect(gateway.log.some((l) => l.startsWith("upload"))).toBe(false);
	});

	it("identifies the slicer from the pre-scan", async () => {
		const result = await run(gateway, { dryRun: true });
		expect(result.meta.slicer).toBe("PrusaSlicer");
		expect(result.meta.totalLayers).toBe(3);
	});
});

describe("the backup index", () => {
	let gateway: FakeGateway;

	beforeEach(() => {
		gateway = new FakeGateway({ [SOURCE]: SAMPLE + "\n" });
	});

	it("records the backup with the original path, so it can be restored", async () => {
		await run(gateway);
		const index = JSON.parse(gateway.files.get("0:/postproc/backups.json")!) as Array<Record<string, unknown>>;
		expect(index).toHaveLength(1);
		expect(index[0]).toMatchObject({
			file: "benchy.20260830-112233.gcode",
			originalPath: SOURCE,
			recipe: "Halve the speed",
		});
		expect(index[0].bytes).toBe((SAMPLE + "\n").length);
	});

	it("still completes and keeps the backup file when the index upload fails, and records a warning", async () => {
		gateway.failUploadOn = "0:/postproc/backups.json";
		const result = await run(gateway);

		expect(result.backupPath).not.toBeNull();
		expect(gateway.files.get(result.backupPath!)).toBe(SAMPLE + "\n");
		expect(gateway.files.has("0:/postproc/backups.json")).toBe(false);
		expect(result.stats.warnings.some((w) => w.includes("backup index"))).toBe(true);
		// The main write must not be affected by the index failure
		expect(gateway.files.get(SOURCE)).toContain("F900");
	});

	it("gives two same-named files from different folders distinct backups", async () => {
		const gatewayA = new FakeGateway({ "0:/gcodes/a/benchy.gcode": SAMPLE + "\n" });
		const gatewayB = gatewayA; // same card — both backups land in the same flat directory

		await processFile({
			gateway: gatewayB,
			sourcePath: "0:/gcodes/a/benchy.gcode",
			recipe: recipe(),
			plan: planOutput({ sourcePath: "0:/gcodes/a/benchy.gcode", mode: "inPlace", now: new Date("2026-08-30T11:22:33") }),
			pluginVersion: "0.1.0",
			scriptsTrusted: false,
			dryRun: false,
		});
		gatewayB.files.set("0:/gcodes/b/benchy.gcode", SAMPLE + "\n");
		const second = await processFile({
			gateway: gatewayB,
			sourcePath: "0:/gcodes/b/benchy.gcode",
			recipe: recipe(),
			plan: planOutput({ sourcePath: "0:/gcodes/b/benchy.gcode", mode: "inPlace", now: new Date("2026-08-30T11:22:33") }),
			pluginVersion: "0.1.0",
			scriptsTrusted: false,
			dryRun: false,
		});

		expect(second.backupPath).toBe("0:/postproc/backups/benchy.20260830-112233-2.gcode");
		const index = JSON.parse(gatewayB.files.get("0:/postproc/backups.json")!) as Array<{ originalPath: string }>;
		expect(index.map((e) => e.originalPath).sort()).toEqual(["0:/gcodes/a/benchy.gcode", "0:/gcodes/b/benchy.gcode"]);
	});

	it("prunes the oldest backups past the limit, and only deletes them after the index write succeeds", async () => {
		// Seed an index with MAX_BACKUPS (20) existing entries, each with a real file on the card
		const existing: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 20; i++) {
			const file = `old${i}.gcode`;
			gateway.files.set(`0:/postproc/backups/${file}`, "old content");
			existing.push({
				file, originalPath: `0:/gcodes/old${i}.gcode`, at: `2026-01-01T00:00:0${i % 10}.000Z`,
				bytes: 11, recipe: "Old",
			});
		}
		gateway.files.set("0:/postproc/backups.json", JSON.stringify(existing));

		await run(gateway);

		const index = JSON.parse(gateway.files.get("0:/postproc/backups.json")!) as Array<{ file: string }>;
		expect(index).toHaveLength(20);
		expect(index[0].file).toBe("benchy.20260830-112233.gcode"); // the new one, newest first
		// The oldest of the 20 pre-existing entries (last in the newest-first list) was dropped
		expect(index.map((e) => e.file)).not.toContain("old19.gcode");
		expect(gateway.files.has("0:/postproc/backups/old19.gcode")).toBe(false);
	});

	it("does not delete a pruned file when the index write itself fails", async () => {
		gateway.failUploadOn = "0:/postproc/backups.json";
		const existing: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 20; i++) {
			const file = `old${i}.gcode`;
			gateway.files.set(`0:/postproc/backups/${file}`, "old content");
			existing.push({ file, originalPath: `0:/gcodes/old${i}.gcode`, at: "2026-01-01T00:00:00.000Z", bytes: 11, recipe: "Old" });
		}
		gateway.files.set("0:/postproc/backups.json", JSON.stringify(existing));

		await run(gateway);

		// The write failed, so pruning must not have happened — every old backup file is still there
		for (let i = 0; i < 20; i++) {
			expect(gateway.files.has(`0:/postproc/backups/old${i}.gcode`)).toBe(true);
		}
	});
});

describe("chunk boundaries", () => {
	// A streaming decoder that mishandles a boundary produces a duplicated, truncated or merged
	// line — and only for certain file sizes. Running every chunk size from 1 upwards is the
	// cheapest way to be sure that never happens
	it("produces identical output at every chunk size", async () => {
		const input = SAMPLE + "\n";
		const outputs = new Set<string>();
		for (const chunkBytes of [1, 2, 3, 7, 13, 64, 128, 1024, input.length, input.length + 10]) {
			const gateway = new FakeGateway({ [SOURCE]: input });
			await run(gateway, { chunkBytes });
			outputs.add(gateway.files.get(SOURCE)!.replace(/^;.*postprocessed-by.*\n/, ""));
		}
		expect(outputs.size).toBe(1);
	});

	it("keeps a multi-byte character intact across a boundary", async () => {
		// "°" is two bytes in UTF-8; a boundary landing between them corrupts the file
		const input = "M117 Temperature 210°C is fine\nM117 Second°line\n";
		for (const chunkBytes of [1, 2, 3, 5, 17, 19]) {
			const gateway = new FakeGateway({ [SOURCE]: input });
			await run(gateway, { chunkBytes, recipe: createNoopRecipe() });
			const written = gateway.files.get(SOURCE)!.replace(/^;.*postprocessed-by.*\n/, "");
			expect(written).toBe(input);
		}
	});

	it("handles a file with no trailing newline", async () => {
		const gateway = new FakeGateway({ [SOURCE]: "G28\nG1 X1" });
		await run(gateway, { chunkBytes: 3, recipe: createNoopRecipe() });
		expect(gateway.files.get(SOURCE)!.replace(/^;.*postprocessed-by.*\n/, "")).toBe("G28\nG1 X1\n");
	});

	it("handles an empty file", async () => {
		const gateway = new FakeGateway({ [SOURCE]: "" });
		const result = await run(gateway, { recipe: createNoopRecipe() });
		expect(result.stats.linesIn).toBe(0);
	});
});

function createNoopRecipe(): Recipe {
	return {
		...createRecipe("No-op"),
		steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: { find: " never matches" } }],
	};
}
