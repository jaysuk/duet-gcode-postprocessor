/**
 * The step registry — one place that knows every step type.
 *
 * Adding a step means writing its module and adding one line here: the editor's "add step" menu,
 * the generic config form, recipe validation and the registry-driven smoke test all read from this,
 * so nothing else has to be touched and nothing can be half-added.
 */

import { arcWeldStep } from "./arcWeld";
import { clampFeedrateStep } from "./clampFeedrate";
import { commandMapStep } from "./commandMap";
import { deleteLinesStep } from "./deleteLines";
import { extractRangeStep } from "./extractRange";
import { fanByFeatureStep } from "./fanByFeature";
import { findReplaceStep } from "./findReplace";
import { insertAtStep } from "./insertAt";
import { minLayerTimeStep } from "./minLayerTime";
import { objectLabelsStep } from "./objectLabels";
import { oozeControlStep } from "./oozeControl";
import { paramRewriteStep } from "./paramRewrite";
import { preheatStep } from "./preheat";
import { rangeVaryStep } from "./rangeVary";
import { restartFromStep } from "./restartFrom";
import { rewriteTimeStep } from "./rewriteTime";
import { rulesStep } from "./rules";
import { scriptStep } from "./script";
import { timelapseTopLayerStep } from "./timelapseTopLayer";
import { toolRenumberStep } from "./toolRenumber";
import type { StepDefinition } from "./types";
import { zHopStep } from "./zHop";

export const STEP_DEFINITIONS: ReadonlyArray<StepDefinition<never>> = Object.freeze([
	findReplaceStep,
	commandMapStep,
	objectLabelsStep,
	extractRangeStep,
	restartFromStep,
	insertAtStep,
	deleteLinesStep,
	paramRewriteStep,
	rangeVaryStep,
	fanByFeatureStep,
	rewriteTimeStep,
	preheatStep,
	rulesStep,
	scriptStep,
	clampFeedrateStep,
	minLayerTimeStep,
	arcWeldStep,
	toolRenumberStep,
	zHopStep,
	oozeControlStep,
	timelapseTopLayerStep,
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
