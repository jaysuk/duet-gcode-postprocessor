/**
 * Automatic recipe selection: does this recipe apply to this file, without the user picking it by
 * hand? Used by auto-run (`dwc/autoRun.ts`) and, optionally, the page's own recipe list.
 *
 * Split into two tiers because they need different inputs and answer different questions:
 *
 * - `matchesPath` only needs a path — the glob and the folder rule — and can run before anything is
 *   downloaded. It answers "might this recipe apply?".
 * - `matchesFile` additionally needs the slicer, which only a prescan can supply, and answers "does
 *   this recipe apply?". A caller with no metadata in hand (the browser) can only ever ask the first
 *   question; collapsing the two into one function with an optional `meta` argument would hide that
 *   difference at every call site instead of making the caller state which question it's asking.
 *
 * A recipe with all three rules blank is deliberately never returned by `pickRecipe` — automatic
 * selection is opt-in **per recipe**, by filling in at least one rule. `matchesFilter` (`recipe.ts`)
 * returns `true` for a blank filter, which is correct for "does this filter exclude the file" and
 * wrong for "should this recipe run automatically": it would make the first recipe in the user's own
 * list the auto-run recipe for every file ever uploaded.
 */

import { matchesFilter, type Recipe } from "./recipe";
import { normalisePath } from "./io/plan";
import type { SlicerMetadata } from "./gcode/metadata";

/** True when `path` is `folder` itself or anything below it. Blank `folder` always matches. Compares
 *  through `normalisePath` so a volume-prefix or trailing-slash difference does not defeat the rule,
 *  and requires a `/` (or exact equality) at the boundary so `0:/gcodes/petg` does not also match
 *  `0:/gcodes/petg-old/...` — a naive `startsWith` gets exactly this wrong. */
export function matchesFolder(path: string, folder: string | undefined): boolean {
	if (folder === undefined || folder.trim() === "") return true;
	const dir = normalisePath(dirNameOf(path));
	const wanted = normalisePath(folder).replace(/\/+$/, "");
	return dir === wanted || dir.startsWith(`${wanted}/`);
}

function dirNameOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

/** True when `meta.slicer` matches `slicer`, case-insensitively. Blank `slicer` always matches. */
export function matchesSlicer(meta: SlicerMetadata, slicer: string | undefined): boolean {
	if (slicer === undefined || slicer.trim() === "") return true;
	return meta.slicer.toLowerCase() === slicer.trim().toLowerCase();
}

/** True when a recipe has at least one automatic-selection rule filled in. A recipe with none of
 *  these is never a candidate for automatic selection, no matter how permissive that would make it
 *  look — see this module's header comment. */
export function hasMatchRules(recipe: Recipe): boolean {
	return (recipe.match !== undefined && recipe.match.trim() !== "")
		|| (recipe.matchFolder !== undefined && recipe.matchFolder.trim() !== "")
		|| (recipe.matchSlicer !== undefined && recipe.matchSlicer.trim() !== "");
}

/**
 * True when confirming this recipe's rules needs the file's slicer metadata — i.e. when tier 2 can
 * still reject what tier 1 accepted. A caller with only a path in hand uses this to decide whether
 * downloading and prescanning the file is worth it at all; for a recipe matching on name or folder
 * alone, `matchesPath` is already the final answer.
 */
export function needsMetadata(recipe: Recipe): boolean {
	return recipe.matchSlicer !== undefined && recipe.matchSlicer.trim() !== "";
}

/** Glob and folder only — everything answerable without downloading the file. */
export function matchesPath(recipe: Recipe, path: string): boolean {
	if (!hasMatchRules(recipe)) return false;
	return matchesFilter(path, recipe.match) && matchesFolder(path, recipe.matchFolder);
}

/** Glob, folder and slicer. Needs a prescan; use `matchesPath` when none is available yet. */
export function matchesFile(recipe: Recipe, path: string, meta: SlicerMetadata): boolean {
	return matchesPath(recipe, path) && matchesSlicer(meta, recipe.matchSlicer);
}

export interface PickResult {
	/** The first match in the user's own recipe order, or null when there are none. */
	chosen: Recipe | null;
	matches: Array<Recipe>;
	/** True when more than one recipe matched — a caller that must not guess (auto-run) should
	 *  refuse rather than use `chosen` in this case. */
	ambiguous: boolean;
}

/** Pick a recipe for `path`, using `matchesFile` when `meta` is given and `matchesPath` otherwise. */
export function pickRecipe(recipes: ReadonlyArray<Recipe>, path: string, meta?: SlicerMetadata): PickResult {
	const matches = recipes.filter((r) => (meta === undefined ? matchesPath(r, path) : matchesFile(r, path, meta)));
	return { chosen: matches[0] ?? null, matches, ambiguous: matches.length > 1 };
}
