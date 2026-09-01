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

	it("skips a step whose condition is not met, and reports it as skipped rather than silently doing nothing", async () => {
		// SAMPLE's own header identifies it as PrusaSlicer
		const conditional: Recipe = {
			...createRecipe("Conditional"),
			steps: [{
				uid: newUid(), type: "findReplace", enabled: true, config: { find: "F1800", replace: "F900" },
				condition: [{ key: "slicer", op: "eq", value: "Cura" }],
			}],
		};
		const result = await run(gateway, { recipe: conditional });
		const written = gateway.files.get(SOURCE)!;
		expect(written).toContain("F1800"); // untouched — the step never ran
		expect(result.stats.warnings.some((w) => w.includes("condition not met"))).toBe(true);
	});

	it("runs a step whose condition is met", async () => {
		const conditional: Recipe = {
			...createRecipe("Conditional"),
			steps: [{
				uid: newUid(), type: "findReplace", enabled: true, config: { find: "F1800", replace: "F900" },
				condition: [{ key: "slicer", op: "eq", value: "PrusaSlicer" }],
			}],
		};
		const result = await run(gateway, { recipe: conditional });
		const written = gateway.files.get(SOURCE)!;
		expect(written).toContain("F900");
		expect(result.stats.warnings.some((w) => w.includes("condition not met"))).toBe(false);
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

// defect A (docs/tasks/07-audit-defects.md): the analysis pass must see what its own step will
// actually receive — the output of the steps ordered before it — not the untouched source. These
// reproduce the exact failure the audit found, as assertions.
describe("the analysis pass sees preceding steps' output, not the raw source", () => {
	const SLOWDOWN = {
		uid: "slowdown", type: "paramRewrite", enabled: true,
		config: { commands: "G0,G1", param: "F", op: "scale", value: 0.25, decimals: 3, skipMissing: true, layerFrom: -1, layerTo: -1 },
	};

	// Three markers, not one: SAMPLE's own single M73 is always forced to P100 R0 by rewriteTime
	// regardless of the total (it's the last and only marker), which would hide this defect entirely
	const MULTI_MARKER = [
		"M73 P0 R10",
		"G28",
		"G1 X100 Y0 F6000",
		"G1 X100 Y100 F6000",
		"M73 P50 R5",
		"G1 X0 Y100 F6000",
		"G1 X0 Y0 F6000",
		"M73 P100 R0",
	].join("\n") + "\n";

	function multiMarkerGateway(): FakeGateway {
		return new FakeGateway({ [SOURCE]: MULTI_MARKER });
	}

	function markersIn(text: string): Array<string> {
		return text.split("\n").filter((l) => l.startsWith("M73"));
	}

	function recipeWithSteps(name: string, steps: Recipe["steps"]): Recipe {
		return { ...createRecipe(name), steps };
	}

	it("gives rewriteTime a total reflecting a slowdown step that runs before it", async () => {
		const baseline = multiMarkerGateway();
		await run(baseline, { recipe: rewriteTimeRecipe(), limits: LIMITS });
		const baselineMarkers = markersIn(baseline.files.get(SOURCE)!);

		const gw = multiMarkerGateway();
		await run(gw, {
			recipe: recipeWithSteps("slow then rewrite", [
				SLOWDOWN,
				{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} },
			]),
			limits: LIMITS,
		});
		const slowedMarkers = markersIn(gw.files.get(SOURCE)!);

		// The real print now takes roughly four times as long, so the time axis rewriteTime measures
		// must differ too — the middle marker is the reproduction from the audit
		expect(slowedMarkers[1]).not.toBe(baselineMarkers[1]);
		// The last marker is always forced to P100 R0 regardless of the total
		expect(slowedMarkers[slowedMarkers.length - 1]).toBe("M73 P100 R0");
	});

	it("gives the same markers when the earlier step cannot affect timing (no regression)", async () => {
		const baseline = multiMarkerGateway();
		await run(baseline, { recipe: rewriteTimeRecipe(), limits: LIMITS });
		const baselineMarkers = markersIn(baseline.files.get(SOURCE)!);

		const gw = multiMarkerGateway();
		await run(gw, {
			recipe: recipeWithSteps("no-op then rewrite", [
				{ uid: newUid(), type: "findReplace", enabled: true, config: { find: "nonexistent-token", replace: "x", regex: false, caseSensitive: true, all: true } },
				{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} },
			]),
			limits: LIMITS,
		});
		expect(markersIn(gw.files.get(SOURCE)!)).toEqual(baselineMarkers);
	});

	it("does not let a step running AFTER it affect rewriteTime's own markers", async () => {
		const baseline = multiMarkerGateway();
		await run(baseline, { recipe: rewriteTimeRecipe(), limits: LIMITS });
		const baselineMarkers = markersIn(baseline.files.get(SOURCE)!);

		const gw = multiMarkerGateway();
		await run(gw, {
			recipe: recipeWithSteps("rewrite then slow", [
				{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} },
				SLOWDOWN,
			]),
			limits: LIMITS,
		});
		expect(markersIn(gw.files.get(SOURCE)!)).toEqual(baselineMarkers);
	});

	it("gives each of two rewriteTime steps in one recipe its own upstream view, not a shared one", async () => {
		function tworewriteTimeRecipe(withSlowdownBetween: boolean): Recipe {
			const steps: Recipe["steps"] = [{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} }];
			if (withSlowdownBetween) steps.push(SLOWDOWN);
			steps.push({ uid: newUid(), type: "rewriteTime", enabled: true, config: {} });
			return recipeWithSteps("two rewriteTime", steps);
		}

		const withoutSlowdown = multiMarkerGateway();
		await run(withoutSlowdown, { recipe: tworewriteTimeRecipe(false), limits: LIMITS });
		const a = markersIn(withoutSlowdown.files.get(SOURCE)!);

		const withSlowdown = multiMarkerGateway();
		await run(withSlowdown, { recipe: tworewriteTimeRecipe(true), limits: LIMITS });
		const b = markersIn(withSlowdown.files.get(SOURCE)!);

		// If both instances collided on the same collector-result key (the bug the id namespacing in
		// defect A's fix exists to prevent), the second instance's write — which always wins, since
		// it runs later and rewrites every marker again — would come out the same either way
		expect(b[1]).not.toBe(a[1]);
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
