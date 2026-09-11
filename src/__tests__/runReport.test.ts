import { describe, expect, it } from "vitest";

import { emptyMetadata } from "../model/gcode/metadata";
import type { ProcessResult } from "../model/io/transfer";
import { createRecipe, newUid, recipeHash, type Recipe } from "../model/recipe";
import { buildRunReport, stepLabel } from "../model/runReport";

function recipe(): Recipe {
	return {
		...createRecipe("Halve the speed"),
		steps: [
			{ uid: newUid(), type: "findReplace", enabled: true, config: { find: "F1800", replace: "F900" }, note: "slower" },
			{ uid: newUid(), type: "deleteLines", enabled: true, config: { pattern: "M900" } },
		],
	};
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
	return {
		stats: {
			linesIn: 10, linesOut: 9, linesChanged: 2, linesAdded: 0, linesRemoved: 1,
			bytesIn: 200, bytesOut: 190, perStep: [2, 1], warnings: [], diffTruncated: false,
		},
		diff: [
			{ lineNo: 3, before: "G1 F1800", after: ["G1 F900"] },
			{ lineNo: 8, before: "M900", after: null },
		],
		analysis: null,
		meta: emptyMetadata(),
		existingStamp: null,
		targetPath: "0:/gcodes/benchy.pp.gcode",
		backupPath: null,
		bytesIn: 200, bytesOut: 190,
		durationMs: 500,
		analysisMs: null,
		transformMs: 400,
		dryRun: false,
		cancelled: false,
		...overrides,
	};
}

describe("stepLabel", () => {
	it("uses the step's own note when it has one", () => {
		expect(stepLabel(recipe(), 0)).toBe("Find and replace (slower)");
	});

	it("falls back to the definition label with no note", () => {
		expect(stepLabel(recipe(), 1)).toBe("Delete or disable lines");
	});

	it("falls back to Step N for an index beyond the effective steps (e.g. an unknown step type)", () => {
		expect(stepLabel(recipe(), 5)).toBe("Step 6");
	});
});

describe("buildRunReport", () => {
	it("contains the recipe name, its hash, and every step's label with its count", () => {
		const r = recipe();
		const report = buildRunReport({ result: result(), recipe: r, sourcePath: "0:/gcodes/benchy.gcode" });
		expect(report).toContain(r.name);
		expect(report).toContain(recipeHash(r));
		expect(report).toContain("Find and replace (slower): 2 lines");
		expect(report).toContain("Delete or disable lines: 1 line");
	});

	it("includes every warning, including a skipped-by-condition line", () => {
		const report = buildRunReport({
			result: result({ stats: { ...result().stats, warnings: ["Fan override: condition not met (slicer = Cura)"] } }),
			recipe: recipe(),
			sourcePath: "x",
		});
		expect(report).toContain("Fan override: condition not met (slicer = Cura)");
	});

	it("notes the diff was capped when diffTruncated is true, and not otherwise", () => {
		const capped = buildRunReport({
			result: result({ stats: { ...result().stats, diffTruncated: true } }),
			recipe: recipe(), sourcePath: "x",
		});
		expect(capped).toContain("capped");

		const notCapped = buildRunReport({ result: result(), recipe: recipe(), sourcePath: "x" });
		expect(notCapped).not.toContain("capped");
	});

	// It used to carry its own formatter that stopped at KiB, so a real print file's size change read
	// as "+40960.0 KiB" — and disagreed with the same number on screen, which uses `formatBytes`
	it("formats a large size change the same way the on-screen preview does", () => {
		const stats = { ...result().stats, bytesIn: 1_000_000, bytesOut: 1_000_000 + 40 * 1024 * 1024 };
		const report = buildRunReport({ result: result({ stats }), recipe: recipe(), sourcePath: "x" });
		expect(report).toContain("+40.0 MiB");
		expect(report).not.toContain("KiB");
	});

	it("says dry run in the header for a preview, and names the target for an applied run", () => {
		const dry = buildRunReport({ result: result({ dryRun: true }), recipe: recipe(), sourcePath: "x" });
		expect(dry).toMatch(/dry run/i);

		const applied = buildRunReport({
			result: result({ backupPath: "0:/postproc/backups/benchy.20260906.gcode" }),
			recipe: recipe(), sourcePath: "x",
		});
		expect(applied).toContain("0:/gcodes/benchy.pp.gcode");
		expect(applied).toContain("0:/postproc/backups/benchy.20260906.gcode");
	});

	it("renders a step whose type is not in the registry as Step N rather than throwing", () => {
		const r: Recipe = {
			...createRecipe("Weird"),
			steps: [{ uid: newUid(), type: "notARealStep", enabled: true, config: {} }],
		};
		expect(() => buildRunReport({
			result: result({ stats: { ...result().stats, perStep: [0] } }),
			recipe: r, sourcePath: "x",
		})).not.toThrow();
	});
});
