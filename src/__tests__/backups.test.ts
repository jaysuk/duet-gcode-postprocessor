import { describe, expect, it } from "vitest";

import { addEntry, parseIndex, pruneIndex, serialiseIndex, type BackupEntry } from "../model/io/backups";

function entry(overrides: Partial<BackupEntry> = {}): BackupEntry {
	return {
		file: "benchy.20260830-112233.gcode",
		originalPath: "0:/gcodes/prints/benchy.gcode",
		at: "2026-08-30T11:22:33.000Z",
		bytes: 1234,
		recipe: "Test",
		...overrides,
	};
}

describe("parseIndex", () => {
	it("returns nothing for an empty or blank string", () => {
		expect(parseIndex("")).toEqual([]);
		expect(parseIndex("   ")).toEqual([]);
	});

	it("returns nothing for malformed JSON", () => {
		expect(parseIndex("{not json")).toEqual([]);
	});

	it("returns nothing for a truncated file", () => {
		// The shape of a real interrupted write: cut off mid-object
		expect(parseIndex('[{"file":"a.gcode","originalPath":"0:/gcodes/a.gc')).toEqual([]);
	});

	it("returns nothing when the JSON parses but is not an array", () => {
		expect(parseIndex("{}")).toEqual([]);
		expect(parseIndex('"just a string"')).toEqual([]);
		expect(parseIndex("42")).toEqual([]);
	});

	it("drops individually malformed entries but keeps the valid ones", () => {
		const json = JSON.stringify([
			entry({ file: "a.gcode" }),
			{ file: "missing-everything-else" },
			entry({ file: "b.gcode" }),
			{ ...entry(), bytes: "not a number" },
			null,
		]);
		const result = parseIndex(json);
		expect(result.map((e) => e.file)).toEqual(["a.gcode", "b.gcode"]);
	});

	it("round-trips through serialiseIndex", () => {
		const index = [entry(), entry({ file: "b.gcode", originalPath: "0:/gcodes/other/b.gcode" })];
		expect(parseIndex(serialiseIndex(index))).toEqual(index);
	});
});

describe("addEntry", () => {
	it("puts the new entry first", () => {
		const index = addEntry([entry({ file: "old.gcode" })], entry({ file: "new.gcode" }));
		expect(index.map((e) => e.file)).toEqual(["new.gcode", "old.gcode"]);
	});

	it("does not mutate the array it was given", () => {
		const original = [entry()];
		addEntry(original, entry({ file: "new.gcode" }));
		expect(original).toHaveLength(1);
	});
});

describe("pruneIndex", () => {
	it("keeps everything when under the limit", () => {
		const index = [entry(), entry({ file: "b.gcode" })];
		const { keep, drop } = pruneIndex(index, 20);
		expect(keep).toEqual(index);
		expect(drop).toEqual([]);
	});

	it("drops nothing exactly at the boundary", () => {
		const index = Array.from({ length: 20 }, (_, i) => entry({ file: `f${i}.gcode` }));
		const { keep, drop } = pruneIndex(index, 20);
		expect(keep).toHaveLength(20);
		expect(drop).toHaveLength(0);
	});

	it("drops the oldest entries once past the limit", () => {
		// Newest-first ordering (as addEntry produces), so the entries past the limit are the
		// oldest ones — index 20 and 21 in an array built oldest-appended-last-of-input here
		const index = Array.from({ length: 22 }, (_, i) => entry({ file: `f${i}.gcode` }));
		const { keep, drop } = pruneIndex(index, 20);
		expect(keep).toHaveLength(20);
		expect(keep.map((e) => e.file)).toEqual(index.slice(0, 20).map((e) => e.file));
		expect(drop.map((e) => e.file)).toEqual(["f20.gcode", "f21.gcode"]);
	});
});
