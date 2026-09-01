import { describe, expect, it } from "vitest";

import {
	alreadyProcessed, buildTransforms, collectorsFor, createRecipe, effectiveSteps, exportRecipe,
	findStamps, hashString, importRecipe, makeStamp, matchesFilter, newUid, recipeHash, usesScripts,
	validateRecipe, type Recipe,
} from "../model/recipe";
import { findPreset, PRESETS } from "../model/presets";
import type { MachineLimits } from "../model/gcode/timeModel";
import { runToString } from "../model/pipeline";
import { StepConfigError } from "../model/steps/types";

const LIMITS: MachineLimits = {
	maxSpeed: { X: 200, Y: 200, Z: 20, E: 50 },
	maxAccel: { X: 1500, Y: 1500, Z: 100, E: 1000 },
	jerk: { X: 15, Y: 15, Z: 2, E: 5 },
	printAccel: 1000,
	travelAccel: 1500,
};

function recipeWith(steps: Array<{ type: string; config?: Record<string, unknown>; enabled?: boolean }>): Recipe {
	return {
		...createRecipe("Test"),
		steps: steps.map((s) => ({
			uid: newUid(), type: s.type, enabled: s.enabled !== false, config: s.config ?? {},
		})),
	};
}

describe("validateRecipe", () => {
	it("rejects an empty recipe", () => {
		expect(validateRecipe(createRecipe("Empty"))).toHaveLength(1);
	});

	it("rejects a recipe whose steps are all disabled", () => {
		const recipe = recipeWith([{ type: "findReplace", config: { find: "x" }, enabled: false }]);
		expect(validateRecipe(recipe).some((p) => p.message.includes("disabled"))).toBe(true);
	});

	it("names the step a problem belongs to", () => {
		const recipe = recipeWith([{ type: "findReplace", config: { find: "([", regex: true } }]);
		const problems = validateRecipe(recipe);
		expect(problems[0].stepLabel).toBe("Find and replace");
		expect(problems[0].stepUid).toBe(recipe.steps[0].uid);
	});

	it("reports an unknown step type rather than silently skipping it", () => {
		const recipe = recipeWith([{ type: "notARealStep" }]);
		expect(validateRecipe(recipe)[0].message).toContain("Unknown step type");
	});

	it("passes a well-formed recipe", () => {
		expect(validateRecipe(recipeWith([{ type: "findReplace", config: { find: "M104" } }]))).toEqual([]);
	});
});

describe("effectiveSteps", () => {
	it("drops disabled steps and fills defaults", () => {
		const recipe = recipeWith([
			{ type: "findReplace", config: { find: "a" } },
			{ type: "findReplace", config: { find: "b" }, enabled: false },
		]);
		const steps = effectiveSteps(recipe);
		expect(steps).toHaveLength(1);
		expect(steps[0].config.caseSensitive).toBe(true);
	});
});

describe("buildTransforms", () => {
	it("builds one transform per enabled step, in order", () => {
		const recipe = recipeWith([
			{ type: "findReplace", config: { find: "a" } },
			{ type: "deleteLines", config: { pattern: "b" } },
		]);
		expect(buildTransforms(recipe, { scriptsTrusted: false }).map((t) => t.id)).toEqual(["findReplace", "deleteLines"]);
	});

	it("names the failing step when one refuses to build", () => {
		const recipe = recipeWith([{ type: "findReplace", config: { find: "([", regex: true }, }]);
		expect(() => buildTransforms(recipe, { scriptsTrusted: false })).toThrow(/Find and replace/);
	});

	it("refuses a script step unless scripts are trusted", () => {
		const recipe = recipeWith([{ type: "script" }]);
		expect(usesScripts(recipe)).toBe(true);
		expect(() => buildTransforms(recipe, { scriptsTrusted: false })).toThrow(StepConfigError);
		expect(() => buildTransforms(recipe, { scriptsTrusted: true })).not.toThrow();
	});
});

describe("collectorsFor", () => {
	it("tags each group with the declaring step's position among the enabled steps", () => {
		// effectiveSteps drops disabled steps entirely, so the disabled findReplace in the middle
		// does not occupy an index slot — the second rewriteTime is at position 1, not 2. The index
		// has to follow effectiveSteps' own numbering, matching what buildTransforms uses, not the
		// raw steps array's.
		const recipe: Recipe = {
			...createRecipe("indices"),
			steps: [
				{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} },
				{ uid: newUid(), type: "findReplace", enabled: false, config: { find: "x" } },
				{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} },
			],
		};
		const groups = collectorsFor(recipe, { scriptsTrusted: false, machineLimits: LIMITS });
		expect(groups.map((g) => g.stepIndex)).toEqual([0, 1]);
	});

	it("gives two instances of the same step type distinct, non-colliding collector ids", () => {
		// Before this was fixed (docs/tasks/07-audit-defects.md, defect A) both instances' collectors
		// shared the bare step-type id, so the second silently overwrote the first in the merged
		// analysis results map and both ended up reading whichever one wrote last
		const recipe: Recipe = {
			...createRecipe("two rewriteTime"),
			steps: [
				{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} },
				{ uid: newUid(), type: "rewriteTime", enabled: true, config: {} },
			],
		};
		const groups = collectorsFor(recipe, { scriptsTrusted: false, machineLimits: LIMITS });
		const ids = groups.flatMap((g) => g.collectors.map((c) => c.id));
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("returns nothing when no enabled step declares a collector", () => {
		const recipe = recipeWith([{ type: "findReplace", config: { find: "x" } }]);
		expect(collectorsFor(recipe, { scriptsTrusted: false, machineLimits: LIMITS })).toEqual([]);
	});

	it("returns nothing for a collector-capable step that has nothing to collect against", () => {
		// rewriteTime declares no collector at all without machine limits, rather than one that
		// would just collect nothing useful
		const recipe = recipeWith([{ type: "rewriteTime" }]);
		expect(collectorsFor(recipe, { scriptsTrusted: false })).toEqual([]);
	});
});

describe("the identity stamp", () => {
	it("hashes deterministically and differs on a config change", () => {
		const a = recipeWith([{ type: "findReplace", config: { find: "x" } }]);
		const b = recipeWith([{ type: "findReplace", config: { find: "x" } }]);
		const c = recipeWith([{ type: "findReplace", config: { find: "y" } }]);
		expect(recipeHash(a)).toBe(recipeHash(b));
		expect(recipeHash(a)).not.toBe(recipeHash(c));
	});

	it("ignores key order in a step config", () => {
		const a = recipeWith([{ type: "findReplace", config: { find: "x", replace: "y" } }]);
		const b = recipeWith([{ type: "findReplace", config: { replace: "y", find: "x" } }]);
		expect(recipeHash(a)).toBe(recipeHash(b));
	});

	it("ignores the recipe name, because renaming does not change the output", () => {
		const a = recipeWith([{ type: "findReplace", config: { find: "x" } }]);
		const b = { ...a, name: "Something else" };
		expect(recipeHash(a)).toBe(recipeHash(b));
	});

	it("changes when a step is disabled", () => {
		const a = recipeWith([{ type: "findReplace", config: { find: "x" } }]);
		const b = recipeWith([{ type: "findReplace", config: { find: "x" }, enabled: false }]);
		expect(recipeHash(a)).not.toBe(recipeHash(b));
	});

	it("round-trips through the file header", () => {
		const recipe = recipeWith([{ type: "findReplace", config: { find: "x" } }]);
		const stamp = makeStamp(recipe, "0.1.0", new Date("2026-08-30T10:00:00Z"));
		const head = `${stamp}\n; generated by PrusaSlicer\nG28`;
		expect(findStamps(head)).toHaveLength(1);
		expect(alreadyProcessed(head, recipe)).not.toBeNull();
	});

	it("does not match a different recipe's stamp", () => {
		const a = recipeWith([{ type: "findReplace", config: { find: "x" } }]);
		const b = recipeWith([{ type: "findReplace", config: { find: "y" } }]);
		expect(alreadyProcessed(makeStamp(a, "0.1.0"), b)).toBeNull();
	});

	it("survives a quote in the recipe name", () => {
		const recipe = { ...recipeWith([{ type: "findReplace", config: { find: "x" } }]), name: 'He said "hi"' };
		expect(findStamps(makeStamp(recipe, "0.1.0"))).toHaveLength(1);
	});

	it("hashes strings without collisions on trivially similar inputs", () => {
		expect(hashString("a")).not.toBe(hashString("b"));
		expect(hashString("ab")).not.toBe(hashString("ba"));
	});
});

describe("import and export", () => {
	it("round-trips a recipe", () => {
		const recipe = recipeWith([{ type: "findReplace", config: { find: "x" } }]);
		const back = importRecipe(exportRecipe(recipe));
		expect(back.name).toBe(recipe.name);
		expect(back.steps[0].type).toBe("findReplace");
		expect(back.steps[0].config.find).toBe("x");
	});

	it("never imports script trust from the file", () => {
		// A shared recipe must not be able to assert that its own scripts are safe to run
		const recipe = { ...recipeWith([{ type: "script" }]), scriptsTrusted: true };
		const json = JSON.stringify({ ...recipe, scriptsTrusted: true });
		expect(importRecipe(json).scriptsTrusted).toBe(false);
	});

	it("rejects rubbish with a usable message", () => {
		expect(() => importRecipe("not json")).toThrow(/Not valid JSON/);
		expect(() => importRecipe("{}")).toThrow(/no name/);
		expect(() => importRecipe('{"name":"x"}')).toThrow(/steps/);
	});

	it("gives an imported step a uid when it has none", () => {
		const back = importRecipe('{"name":"x","steps":[{"type":"findReplace","config":{}}]}');
		expect(back.steps[0].uid).not.toBe("");
	});
});

describe("matchesFilter", () => {
	it("matches everything when empty", () => {
		expect(matchesFilter("0:/gcodes/a.gcode", undefined)).toBe(true);
		expect(matchesFilter("0:/gcodes/a.gcode", "  ")).toBe(true);
	});

	it("globs on the base name", () => {
		expect(matchesFilter("0:/gcodes/benchy.gcode", "*.gcode")).toBe(true);
		expect(matchesFilter("0:/gcodes/benchy.bgcode", "*.gcode")).toBe(false);
		expect(matchesFilter("0:/gcodes/benchy.gcode", "ben*")).toBe(true);
	});

	it("is case-insensitive and does not treat dots as wildcards", () => {
		expect(matchesFilter("0:/gcodes/A.GCODE", "*.gcode")).toBe(true);
		expect(matchesFilter("0:/gcodes/axgcode", "a.gcode")).toBe(false);
	});
});

describe("the bundled presets", () => {
	it.each(PRESETS.map((p) => [p.key, p] as const))("%s is valid and buildable", (_key, preset) => {
		const recipe = preset.build();
		expect(validateRecipe(recipe)).toEqual([]);
		expect(() => buildTransforms(recipe, { scriptsTrusted: false })).not.toThrow();
	});

	it("has unique keys and names", () => {
		expect(new Set(PRESETS.map((p) => p.key)).size).toBe(PRESETS.length);
		expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
	});

	it("contains no script steps, so nothing bundled needs trust", () => {
		for (const preset of PRESETS) expect(usesScripts(preset.build())).toBe(false);
	});

	// None of the three golden-file fixtures happen to carry a tool-scoped M104/M109 (they are all
	// single-extruder), so this integration case would otherwise have no coverage at all beyond the
	// mapCommand unit tests — verifying it through the preset itself, not just the underlying
	// function, is what actually confirms the two new steps are wired in correctly
	it("marlinToRrf converts a tool-scoped temperature but leaves a bare one alone", () => {
		const recipe = findPreset("marlinToRrf")!.build();
		const transforms = buildTransforms(recipe, { scriptsTrusted: false });
		const { output } = runToString({ transforms }, ["M104 S200 T1", "M104 S210", "M109 S200 T0"].join("\n"));
		const lines = output.split("\n");
		// Parameter order is preserved from the source line (S came before T), not re-sorted
		expect(lines[0]).toBe("M568 S200 P1 ; was: M104 S200 T1");
		expect(lines[1]).toBe("M104 S210");
		expect(lines[2]).toBe("M568 S200 P0 ; was: M109 S200 T0");
	});
});
