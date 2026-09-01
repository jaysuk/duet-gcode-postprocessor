/**
 * Recipes: the ordered list of steps, its serialisation, and the identity stamp written into a
 * processed file.
 *
 * The stamp is what makes re-running safe to reason about. It carries the recipe name and a hash of
 * its effective configuration, so "has this exact recipe already been applied to this file?" is a
 * string comparison rather than a guess — which is what stops the classic post-processing bug of
 * applying the same 20% speed reduction three times.
 */

import type { AnalysisCollector } from "./analysisPass";
import type { SlicerMetadata } from "./gcode/metadata";
import { getStepDefinition } from "./steps/registry";
import {
	StepConfigError, validateStep, withDefaults,
	type StepFactoryContext, type Transform,
} from "./steps/types";
import { describeStepConditions, stepConditionsMet, type StepCondition } from "./stepCondition";

export interface RecipeStep {
	/** Stable per-step id so the UI can key a list through reordering. */
	uid: string;
	/** Step type id, matching the registry. */
	type: string;
	/** User-facing note, shown in the step list. Optional. */
	note?: string;
	enabled: boolean;
	config: Record<string, unknown>;
	/**
	 * Whole-file conditions, ANDed, evaluated once against the slicer's own metadata before the
	 * transform pass starts — "only run this step if the file is PETG". Undefined or empty always
	 * runs. See `stepCondition.ts` for why this is metadata-only, not `FileAnalysis`-aware.
	 */
	condition?: Array<StepCondition>;
}

export interface Recipe {
	id: string;
	name: string;
	description?: string;
	steps: Array<RecipeStep>;
	/** Set by the user after reviewing any script steps. Never persisted as true by default. */
	scriptsTrusted?: boolean;
	/** Glob-ish filename filter used by auto-run; empty means "any file". */
	match?: string;
	/** Schema version, for future migrations. */
	version: number;
}

export const RECIPE_VERSION = 1;

export function createRecipe(name: string): Recipe {
	return { id: newUid(), name, steps: [], version: RECIPE_VERSION };
}

export function newUid(): string {
	// Not cryptographic — this only has to be unique within one recipe's step list
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Enabled steps only, with defaults filled in — the exact configuration that will run.
 *
 * `meta` is optional and, when given, additionally drops a step whose own `condition` is not met by
 * this file — omitted entirely for callers with no file in hand (`recipeHash`, the UI's own step
 * list), for whom a condition does not change the recipe's *structure*, only whether one run of it
 * fires. A step a condition removes never occupies a `stepIndex` slot, the same rule `enabled`
 * already follows — see `collectorsFor`'s own doc comment and task 07's defect A for why that matters.
 */
export function effectiveSteps(recipe: Recipe, meta?: SlicerMetadata): Array<RecipeStep> {
	const result: Array<RecipeStep> = [];
	for (const step of recipe.steps) {
		if (!step.enabled) continue;
		if (meta !== undefined && !stepConditionsMet(step.condition, meta)) continue;
		const def = getStepDefinition(step.type);
		if (def === null) continue;
		result.push({ ...step, config: withDefaults(def, step.config) });
	}
	return result;
}

export interface RecipeProblem {
	stepUid: string | null;
	stepLabel: string;
	message: string;
}

/** Validate every enabled step. An empty result means the recipe is runnable. */
export function validateRecipe(recipe: Recipe): Array<RecipeProblem> {
	const problems: Array<RecipeProblem> = [];
	if (recipe.steps.length === 0) {
		problems.push({ stepUid: null, stepLabel: "Recipe", message: "The recipe has no steps" });
	}
	if (recipe.steps.length > 0 && recipe.steps.every((s) => !s.enabled)) {
		problems.push({ stepUid: null, stepLabel: "Recipe", message: "Every step is disabled" });
	}
	for (const step of recipe.steps) {
		if (!step.enabled) continue;
		const def = getStepDefinition(step.type);
		if (def === null) {
			problems.push({ stepUid: step.uid, stepLabel: step.type, message: `Unknown step type "${step.type}"` });
			continue;
		}
		const config = withDefaults(def, step.config);
		for (const message of validateStep(def, config)) {
			problems.push({ stepUid: step.uid, stepLabel: def.label, message });
		}
		for (const message of def.validate?.(config as never) ?? []) {
			problems.push({ stepUid: step.uid, stepLabel: def.label, message });
		}
	}
	return problems;
}

/** True when the recipe contains at least one enabled script step. */
export function usesScripts(recipe: Recipe): boolean {
	return recipe.steps.some((s) => s.enabled && s.type === "script");
}

/**
 * Collectors declared by one step, tagged with that step's position among the recipe's enabled
 * steps. The position is what lets `processFile` run each group's collectors against the *output*
 * of the steps ordered before it, rather than against the untouched source — see
 * `docs/tasks/07-audit-defects.md` defect A.
 */
export interface CollectorGroup {
	/** Index into `effectiveSteps(recipe)` of the step that declared these collectors. */
	stepIndex: number;
	collectors: Array<AnalysisCollector>;
}

/**
 * Every collector the recipe's enabled steps need run over the file before the transform pass can
 * start, grouped by which step declared them. Empty when none do — the common case, and the reason
 * `processFile` can skip the whole analysis pass rather than always paying for it.
 */
export function collectorsFor(recipe: Recipe, ctx: StepFactoryContext, meta?: SlicerMetadata): Array<CollectorGroup> {
	const groups: Array<CollectorGroup> = [];
	const steps = effectiveSteps(recipe, meta);
	for (let i = 0; i < steps.length; i++) {
		const def = getStepDefinition(steps[i].type);
		if (def === null || def.analysis === undefined) continue;
		const collectors = def.analysis(steps[i].config as never, { ...ctx, stepIndex: i });
		if (collectors.length > 0) groups.push({ stepIndex: i, collectors });
	}
	return groups;
}

/**
 * Build transforms for an explicit step list, each stamped with its index within that list as
 * `StepFactoryContext.stepIndex`. Shared by `buildTransforms` (the full recipe) and `processFile`'s
 * analysis sub-pass (a prefix of it) — the indices line up between the two because a prefix always
 * starts at position 0 of the same `effectiveSteps` list.
 */
function buildTransformsForSteps(steps: Array<RecipeStep>, ctx: StepFactoryContext): Array<Transform> {
	const transforms: Array<Transform> = [];
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const def = getStepDefinition(step.type);
		if (def === null) continue;
		try {
			transforms.push(def.create(step.config as never, { ...ctx, stepIndex: i }));
		} catch (e) {
			const label = step.note !== undefined && step.note !== "" ? `${def.label} (${step.note})` : def.label;
			throw new StepConfigError(`${label}: ${(e as Error).message}`);
		}
	}
	return transforms;
}

/**
 * Instantiate the transforms for a run. Throws {@link StepConfigError} with a message naming the
 * step when one refuses to build (a bad regex, an untrusted script).
 */
export function buildTransforms(recipe: Recipe, ctx: StepFactoryContext, meta?: SlicerMetadata): Array<Transform> {
	return buildTransformsForSteps(effectiveSteps(recipe, meta), ctx);
}

/**
 * Transforms for just the steps ordered before `stepIndex` in the recipe's enabled-step list — what
 * an analysis sub-pass runs to see what its own collector-declaring step will actually receive. Only
 * `processFile` calls this. `meta` must be the same value passed to whichever `collectorsFor` call
 * produced `stepIndex`, or the two will not agree on what that index even refers to.
 */
export function buildPrefixTransforms(recipe: Recipe, stepIndex: number, ctx: StepFactoryContext, meta?: SlicerMetadata): Array<Transform> {
	return buildTransformsForSteps(effectiveSteps(recipe, meta).slice(0, stepIndex), ctx);
}

/**
 * Enabled steps a condition removed for this file, with a human-readable reason — for a run report
 * that says "skipped", not silence. Steps with an unknown type are not included here; that is a
 * different, pre-existing problem `validateRecipe` already reports.
 */
export function skippedByCondition(recipe: Recipe, meta: SlicerMetadata): Array<{ step: RecipeStep; reason: string }> {
	const skipped: Array<{ step: RecipeStep; reason: string }> = [];
	for (const step of recipe.steps) {
		if (!step.enabled) continue;
		if (step.condition === undefined || step.condition.length === 0) continue;
		if (!stepConditionsMet(step.condition, meta)) {
			const def = getStepDefinition(step.type);
			const label = def !== null ? def.label : step.type;
			skipped.push({ step, reason: `${label}: condition not met (${describeStepConditions(step.condition)})` });
		}
	}
	return skipped;
}

// #region Identity stamp

export const STAMP_PREFIX = "; postprocessed-by: GCodePostProcessor";

export interface Stamp {
	pluginVersion: string;
	recipe: string;
	hash: string;
	at: string;
}

/**
 * FNV-1a, 32-bit. Small, synchronous and dependency-free — this only has to detect "the same
 * recipe ran again", not resist an adversary.
 */
export function hashString(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Hash of everything that affects the output: step types, order and effective config. */
export function recipeHash(recipe: Recipe): string {
	const canonical = effectiveSteps(recipe).map((s) => ({ type: s.type, config: sortKeys(s.config) }));
	return hashString(JSON.stringify(canonical));
}

export function makeStamp(recipe: Recipe, pluginVersion: string, now = new Date()): string {
	return `${STAMP_PREFIX} v${pluginVersion} recipe="${recipe.name.replace(/"/g, "'")}" hash=${recipeHash(recipe)} at=${now.toISOString()}`;
}

const STAMP_RE = /^;\s*postprocessed-by:\s*GCodePostProcessor\s+v(\S+)\s+recipe="([^"]*)"\s+hash=(\w+)\s+at=(\S+)/i;

/** Find every stamp in a block of text (normally the pre-scanned head of a file). */
export function findStamps(text: string): Array<Stamp> {
	const stamps: Array<Stamp> = [];
	for (const line of text.split("\n")) {
		const m = STAMP_RE.exec(line.trim());
		if (m !== null) {
			stamps.push({ pluginVersion: m[1], recipe: m[2], hash: m[3], at: m[4] });
		}
	}
	return stamps;
}

/** True when this exact recipe has already been applied to a file with this head. */
export function alreadyProcessed(head: string, recipe: Recipe): Stamp | null {
	const hash = recipeHash(recipe);
	return findStamps(head).find((s) => s.hash === hash) ?? null;
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) out[key] = value[key];
	return out;
}

// #endregion

// #region Import / export

export function exportRecipe(recipe: Recipe): string {
	return JSON.stringify({ ...recipe, scriptsTrusted: undefined }, null, "\t");
}

/**
 * Parse a recipe from JSON. `scriptsTrusted` is always cleared: trust is a decision the person
 * importing has to make about code they can see, never something the file can assert about itself.
 */
export function importRecipe(json: string): Recipe {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (e) {
		throw new StepConfigError(`Not valid JSON: ${(e as Error).message}`);
	}
	const raw = parsed as Partial<Recipe>;
	if (typeof raw !== "object" || raw === null) throw new StepConfigError("Not a recipe object");
	if (typeof raw.name !== "string" || raw.name === "") throw new StepConfigError("Recipe has no name");
	if (!Array.isArray(raw.steps)) throw new StepConfigError("Recipe has no steps array");

	const steps: Array<RecipeStep> = raw.steps.map((s) => {
		const step = s as Partial<RecipeStep>;
		if (typeof step.type !== "string") throw new StepConfigError("A step has no type");
		return {
			uid: typeof step.uid === "string" ? step.uid : newUid(),
			type: step.type,
			note: typeof step.note === "string" ? step.note : undefined,
			enabled: step.enabled !== false,
			config: (typeof step.config === "object" && step.config !== null) ? step.config as Record<string, unknown> : {},
		};
	});

	return {
		id: typeof raw.id === "string" ? raw.id : newUid(),
		name: raw.name,
		description: typeof raw.description === "string" ? raw.description : undefined,
		match: typeof raw.match === "string" ? raw.match : undefined,
		steps,
		scriptsTrusted: false,
		version: RECIPE_VERSION,
	};
}

/** Filename filter used by auto-run: a `*`/`?` glob against the file's base name. */
export function matchesFilter(filename: string, filter: string | undefined): boolean {
	if (filter === undefined || filter.trim() === "") return true;
	const base = filename.split("/").pop() ?? filename;
	const source = "^" + filter.trim()
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".") + "$";
	try {
		return new RegExp(source, "i").test(base);
	} catch {
		return false;
	}
}

// #endregion
