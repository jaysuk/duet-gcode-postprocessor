/**
 * The step registry — one place that knows every step type.
 *
 * Adding a step means writing its module and adding one line here: the editor's "add step" menu,
 * the generic config form, recipe validation and the registry-driven smoke test all read from this,
 * so nothing else has to be touched and nothing can be half-added.
 */

import { commandMapStep } from "./commandMap";
import { deleteLinesStep } from "./deleteLines";
import { findReplaceStep } from "./findReplace";
import { insertAtStep } from "./insertAt";
import { paramRewriteStep } from "./paramRewrite";
import { rangeVaryStep } from "./rangeVary";
import { rulesStep } from "./rules";
import { scriptStep } from "./script";
import type { StepDefinition } from "./types";

export const STEP_DEFINITIONS: ReadonlyArray<StepDefinition<never>> = Object.freeze([
	findReplaceStep,
	commandMapStep,
	insertAtStep,
	deleteLinesStep,
	paramRewriteStep,
	rangeVaryStep,
	rulesStep,
	scriptStep,
] as unknown as Array<StepDefinition<never>>);

const BY_ID = new Map<string, StepDefinition<never>>(STEP_DEFINITIONS.map((d) => [d.id, d]));

export function getStepDefinition(id: string): StepDefinition<never> | null {
	return BY_ID.get(id) ?? null;
}

/** Default config for a newly added step, straight from its field schema. */
export function defaultConfig(id: string): Record<string, unknown> {
	const def = getStepDefinition(id);
	if (def === null) return {};
	const config: Record<string, unknown> = {};
	for (const field of def.fields) config[field.key] = field.default;
	return config;
}
