import { describe, expect, it } from "vitest";

import { HISTORY_INDEX } from "../model/constants";
import {
	addRun, parseHistory, pruneHistory, recordRun, serialiseHistory, toFailedHistoryEntry,
	toHistoryEntry, type HistoryEntry,
} from "../model/io/history";
import type { ProcessResult } from "../model/io/transfer";
import { createRecipe, newUid, recipeHash, type Recipe } from "../model/recipe";
import { emptyMetadata } from "../model/gcode/metadata";
import { FakeGateway } from "./helpers";

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		at: "2026-09-06T10:00:00Z",
		sourcePath: "0:/gcodes/benchy.gcode",
		targetPath: "0:/gcodes/benchy.pp.gcode",
		recipeName: "Test",
		recipeHash: "abc123",
		linesChanged: 1, linesAdded: 0, linesRemoved: 0,
		bytesIn: 100, bytesOut: 100,
		durationMs: 50,
		backupPath: null,
		warnings: [],
		origin: "page",
		ok: true,
		...overrides,
	};
}

describe("parseHistory", () => {
	it("treats an empty string as no history", () => {
		expect(parseHistory("")).toEqual([]);
	});

	it("treats invalid JSON as no history", () => {
		expect(parseHistory("not json")).toEqual([]);
	});

	it("treats JSON that is not an array as no history", () => {
		expect(parseHistory("{}")).toEqual([]);
	});

	it("drops one malformed entry among good ones, keeping the good ones", () => {
		const good = entry();
		const json = JSON.stringify([good, { bogus: true }, entry({ sourcePath: "0:/gcodes/other.gcode" })]);
		const parsed = parseHistory(json);
		expect(parsed).toHaveLength(2);
		expect(parsed.map((e) => e.sourcePath)).toEqual(["0:/gcodes/benchy.gcode", "0:/gcodes/other.gcode"]);
	});

	it("round-trips through serialiseHistory", () => {
		const history = [entry()];
		expect(parseHistory(serialiseHistory(history))).toEqual(history);
	});
});

describe("addRun and pruneHistory", () => {
	it("adds newest first", () => {
		const first = entry({ sourcePath: "a" });
		const second = entry({ sourcePath: "b" });
		const history = addRun(addRun([], first), second);
		expect(history.map((e) => e.sourcePath)).toEqual(["b", "a"]);
	});

	it("prunes down to the cap, keeping the newest", () => {
		const history = Array.from({ length: 5 }, (_, i) => entry({ sourcePath: String(i) }));
		expect(pruneHistory(history, 3).map((e) => e.sourcePath)).toEqual(["0", "1", "2"]);
	});
});

describe("recordRun", () => {
	it("writes an index where none existed", async () => {
		const gateway = new FakeGateway();
		await recordRun(gateway, entry());
		const written = parseHistory(gateway.files.get(HISTORY_INDEX)!);
		expect(written).toHaveLength(1);
	});

	it("appends to an existing index", async () => {
		const gateway = new FakeGateway({ [HISTORY_INDEX]: serialiseHistory([entry({ sourcePath: "old" })]) });
		await recordRun(gateway, entry({ sourcePath: "new" }));
		const written = parseHistory(gateway.files.get(HISTORY_INDEX)!);
		expect(written.map((e) => e.sourcePath)).toEqual(["new", "old"]);
	});

	it("resolves rather than throwing when the upload fails", async () => {
		const gateway = new FakeGateway();
		gateway.failUploadOn = HISTORY_INDEX;
		await expect(recordRun(gateway, entry())).resolves.toBeUndefined();
	});
});

function recipeFixture(): Recipe {
	return {
		...createRecipe("Halve the speed"),
		steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: { find: "x" } }],
	};
}

function processResultFixture(): ProcessResult {
	return {
		stats: {
			linesIn: 10, linesOut: 10, linesChanged: 3, linesAdded: 1, linesRemoved: 0,
			bytesIn: 200, bytesOut: 210, perStep: [3], warnings: ["a warning"], diffTruncated: false,
		},
		diff: [],
		analysis: null,
		meta: emptyMetadata(),
		existingStamp: null,
		targetPath: "0:/gcodes/benchy.pp.gcode",
		backupPath: "0:/postproc/backups/benchy.20260906-100000.gcode",
		bytesIn: 200, bytesOut: 210,
		durationMs: 123,
		analysisMs: null,
		transformMs: 100,
		dryRun: false,
		cancelled: false,
	};
}

describe("toHistoryEntry", () => {
	it("carries the result's stats and the recipe's hash", () => {
		const recipe = recipeFixture();
		const result = processResultFixture();
		const built = toHistoryEntry(result, recipe, "0:/gcodes/benchy.gcode", "page", new Date("2026-09-06T10:00:00Z"));
		expect(built.ok).toBe(true);
		expect(built.recipeHash).toBe(recipeHash(recipe));
		expect(built.linesChanged).toBe(3);
		expect(built.targetPath).toBe("0:/gcodes/benchy.pp.gcode");
		expect(built.backupPath).toBe(result.backupPath);
		expect(built.warnings).toEqual(["a warning"]);
		expect(built.origin).toBe("page");
	});

	it("passes isValidEntry's own shape check (round-trips through the real parser)", () => {
		const built = toHistoryEntry(processResultFixture(), recipeFixture(), "0:/gcodes/benchy.gcode", "auto");
		const parsed = parseHistory(serialiseHistory([built]));
		expect(parsed).toHaveLength(1);
	});
});

describe("toFailedHistoryEntry", () => {
	it("records the error message and ok: false", () => {
		const built = toFailedHistoryEntry("0:/gcodes/benchy.gcode", recipeFixture(), "batch", new Error("disk full"));
		expect(built.ok).toBe(false);
		expect(built.error).toBe("disk full");
	});

	it("also round-trips through the real parser", () => {
		const built = toFailedHistoryEntry("0:/gcodes/x.gcode", recipeFixture(), "widget", new Error("boom"));
		expect(parseHistory(serialiseHistory([built]))).toHaveLength(1);
	});
});
