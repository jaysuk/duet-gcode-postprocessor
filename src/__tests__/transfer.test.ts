import { beforeEach, describe, expect, it } from "vitest";

import { planOutput } from "../model/io/plan";
import { CancelledError, processFile, type FileGateway } from "../model/io/transfer";
import { createRecipe, newUid, type Recipe } from "../model/recipe";
import { SAMPLE } from "./helpers";

const SOURCE = "0:/gcodes/benchy.gcode";

/** In-memory SD card. Records the order of operations so the write sequence can be asserted. */
class FakeGateway implements FileGateway {
	files = new Map<string, string>();
	log: Array<string> = [];
	failUploadOn: string | null = null;
	corruptTargetSize = false;

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
	}

	async download(path: string): Promise<Blob> {
		this.log.push(`download ${path}`);
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`No such file: ${path}`);
		return new Blob([content], { type: "text/plain" });
	}

	async upload(path: string, content: Blob): Promise<void> {
		this.log.push(`upload ${path}`);
		if (this.failUploadOn === path) throw new Error("network died");
		this.files.set(path, await content.text());
	}

	async move(from: string, to: string): Promise<void> {
		this.log.push(`move ${from} -> ${to}`);
		const content = this.files.get(from);
		if (content === undefined) throw new Error(`No such file: ${from}`);
		this.files.delete(from);
		this.files.set(to, content);
	}

	async remove(path: string): Promise<void> {
		this.log.push(`remove ${path}`);
		this.files.delete(path);
	}

	async makeDirectory(path: string): Promise<void> {
		this.log.push(`mkdir ${path}`);
	}

	async sizeOf(path: string): Promise<number | null> {
		const content = this.files.get(path);
		if (content === undefined) return null;
		return this.corruptTargetSize ? 1 : new Blob([content]).size;
	}
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

	it("backs up, uploads to a temp name, then moves — in that order", async () => {
		await run(gateway);
		const order = gateway.log.filter((l) => !l.startsWith("download"));
		expect(order).toEqual([
			"mkdir 0:/gcodes/.postproc/backups",
			"upload 0:/gcodes/.postproc/backups/benchy.20260830-112233.gcode",
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

	it("identifies the slicer from the pre-scan", async () => {
		const result = await run(gateway, { dryRun: true });
		expect(result.meta.slicer).toBe("PrusaSlicer");
		expect(result.meta.totalLayers).toBe(3);
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
		steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: { find: " never matches" } }],
	};
}
