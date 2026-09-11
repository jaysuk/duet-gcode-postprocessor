import { describe, expect, it } from "vitest";

import { emptyMetadata } from "../model/gcode/metadata";
import { createRecipe, type Recipe } from "../model/recipe";
import { hasMatchRules, matchesFile, matchesFolder, matchesPath, pickRecipe } from "../model/recipeMatch";

function recipe(overrides: Partial<Recipe> = {}): Recipe {
	return { ...createRecipe("Test"), ...overrides };
}

describe("hasMatchRules", () => {
	it("is false with no rules at all", () => {
		expect(hasMatchRules(recipe())).toBe(false);
	});

	it("is true when any single rule is set", () => {
		expect(hasMatchRules(recipe({ match: "*.gcode" }))).toBe(true);
		expect(hasMatchRules(recipe({ matchFolder: "0:/gcodes/petg" }))).toBe(true);
		expect(hasMatchRules(recipe({ matchSlicer: "Cura" }))).toBe(true);
	});

	it("blank strings do not count as set", () => {
		expect(hasMatchRules(recipe({ match: "  ", matchFolder: "", matchSlicer: undefined }))).toBe(false);
	});
});

describe("matchesFolder", () => {
	it("matches everything when blank", () => {
		expect(matchesFolder("0:/gcodes/a.gcode", undefined)).toBe(true);
		expect(matchesFolder("0:/gcodes/a.gcode", "  ")).toBe(true);
	});

	it("matches the exact folder", () => {
		expect(matchesFolder("0:/gcodes/petg/a.gcode", "0:/gcodes/petg")).toBe(true);
	});

	it("matches a subdirectory", () => {
		expect(matchesFolder("0:/gcodes/petg/towers/a.gcode", "0:/gcodes/petg")).toBe(true);
	});

	it("does not match a sibling folder sharing the same prefix", () => {
		expect(matchesFolder("0:/gcodes/petg-old/a.gcode", "0:/gcodes/petg")).toBe(false);
	});

	it("does not match a different folder", () => {
		expect(matchesFolder("0:/gcodes/abs/a.gcode", "0:/gcodes/petg")).toBe(false);
	});

	it("is lenient about the volume prefix, via normalisePath", () => {
		expect(matchesFolder("0:/gcodes/petg/a.gcode", "/gcodes/petg")).toBe(true);
	});
});

describe("matchesPath and matchesFile", () => {
	it("matchesPath is false for a recipe with no rules, regardless of the path", () => {
		expect(matchesPath(recipe(), "0:/gcodes/anything.gcode")).toBe(false);
	});

	it("ANDs glob, folder and slicer when all three are set", () => {
		const r = recipe({ match: "*.gcode", matchFolder: "0:/gcodes/petg", matchSlicer: "Cura" });
		const meta = { ...emptyMetadata(), slicer: "Cura" as const };
		expect(matchesFile(r, "0:/gcodes/petg/a.gcode", meta)).toBe(true);
		expect(matchesFile(r, "0:/gcodes/abs/a.gcode", meta)).toBe(false);
		expect(matchesFile(r, "0:/gcodes/petg/a.bgcode", meta)).toBe(false);
		const prusaMeta = { ...emptyMetadata(), slicer: "PrusaSlicer" as const };
		expect(matchesFile(r, "0:/gcodes/petg/a.gcode", prusaMeta)).toBe(false);
	});

	it("matchesPath treats an unconfirmed slicer rule as a candidate, not a rejection", () => {
		const r = recipe({ matchSlicer: "Cura" });
		expect(matchesPath(r, "0:/gcodes/anything.gcode")).toBe(true);
	});

	it("matchesFile rejects once the slicer is known not to match", () => {
		const r = recipe({ matchSlicer: "Cura" });
		const meta = { ...emptyMetadata(), slicer: "PrusaSlicer" as const };
		expect(matchesFile(r, "0:/gcodes/anything.gcode", meta)).toBe(false);
	});
});

describe("pickRecipe", () => {
	it("returns no chosen recipe when nothing matches", () => {
		const result = pickRecipe([recipe({ match: "*.bgcode" })], "0:/gcodes/a.gcode");
		expect(result.chosen).toBeNull();
		expect(result.ambiguous).toBe(false);
	});

	it("never returns a recipe with no match rules, even as the only recipe", () => {
		const result = pickRecipe([recipe({ name: "Catch-all" })], "0:/gcodes/a.gcode");
		expect(result.matches).toEqual([]);
		expect(result.chosen).toBeNull();
	});

	it("picks the first match in list order and flags ambiguity when more than one matches", () => {
		const a = recipe({ name: "A", match: "*.gcode" });
		const b = recipe({ name: "B", match: "*.gcode" });
		const result = pickRecipe([a, b], "0:/gcodes/x.gcode");
		expect(result.chosen).toBe(a);
		expect(result.ambiguous).toBe(true);
		expect(result.matches).toEqual([a, b]);
	});

	it("with no metadata, a slicer-only rule is a candidate (tier 1); with metadata, it is confirmed or rejected (tier 2)", () => {
		const r = recipe({ matchSlicer: "Cura" });
		expect(pickRecipe([r], "0:/gcodes/a.gcode").chosen).toBe(r);
		expect(pickRecipe([r], "0:/gcodes/a.gcode", { ...emptyMetadata(), slicer: "Cura" as const }).chosen).toBe(r);
		expect(pickRecipe([r], "0:/gcodes/a.gcode", { ...emptyMetadata(), slicer: "PrusaSlicer" as const }).chosen).toBeNull();
	});
});
