/**
 * Fire a timelapse macro once per `M486` object, at that object's own top layer — not once per
 * layer for the whole plate. The existing "Timelapse trigger every layer" preset (`presets.ts`) fires
 * at every layer change; on a plate of twenty objects that is twenty times more triggers than wanted.
 *
 * "That object's top layer" is only knowable after seeing the whole file — lookahead, which is what
 * `analysisPass.ts` exists for and what `preheat.ts` already uses the same way. `ObjectTopLayerCollector`
 * records the highest layer on which each object genuinely extrudes; the transform then fires once,
 * at the layer-change boundary right after an object's own top layer finishes (or at the end of the
 * file, for whichever object's top layer happens to be the file's own last layer — there is no
 * *next* layer-change event to catch that one on).
 */

import { paramNumber, parseParams } from "../gcode/tokenise";
import type { AnalysisCollector } from "../analysisPass";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

export interface TimelapseTopLayerConfig {
	macroPath: string;
}

const COLLECTOR_ID = "timelapseTopLayer";

/** Namespaced by `stepIndex` so two instances of this step in one recipe do not collide on the same
 *  key in the merged analysis-results map (task 07's defect A) — falls back to the bare id for a
 *  direct unit-test call that shares one context between `analysis()` and `create()`. */
function collectorId(ctx: StepFactoryContext): string {
	return ctx.stepIndex !== undefined ? `${COLLECTOR_ID}#${ctx.stepIndex}` : COLLECTOR_ID;
}

class ObjectTopLayerCollector implements AnalysisCollector<Map<string, number>> {
	private readonly topLayer = new Map<string, number>();
	/** Absolute E, tracked independently of `MachineState` (which does not track E at all) — same
	 *  convention as `analysis.ts`'s own `this.e`, including the same G92 fix from task 15 Finding B:
	 *  without resetting on G92, a stale absolute E reads as a huge fictitious "retraction" (deltaE
	 *  <= 0) on the next G1, which would silently make a real top-layer extrusion invisible to this
	 *  collector. */
	private e = 0;

	constructor(readonly id: string) {}

	onLine(ctx: LineContext): void {
		const token = ctx.token;
		if (token.letter !== "G") return;
		if (token.code === "G92") {
			const e = paramNumber(parseParams(token.body), "E");
			if (e !== null) this.e = e;
			return;
		}
		if (token.code !== "G0" && token.code !== "G1") return;
		if (ctx.object === null) return;

		const eParam = paramNumber(parseParams(token.body), "E");
		if (eParam === null) return;
		const prevE = this.e;
		const deltaE = ctx.relativeE ? eParam : eParam - prevE;
		this.e = ctx.relativeE ? this.e + eParam : eParam;
		if (deltaE <= 0) return;

		const current = this.topLayer.get(ctx.object) ?? -1;
		if (ctx.layer > current) this.topLayer.set(ctx.object, ctx.layer);
	}

	result(): Map<string, number> {
		return this.topLayer;
	}
}

export const timelapseTopLayerStep: StepDefinition<TimelapseTopLayerConfig> = {
	id: "timelapseTopLayer",
	label: "Timelapse on each object's top layer",
	description: "Calls a macro once per M486 object, right after that object's own last layer — not once per layer for the whole plate.",
	tip: "Needs the file to already carry M486 object labels — pair this with the \"Convert Klipper "
		+ "object markers\" step first if the file does not have them yet (or is not already labelled "
		+ "by the slicer). A file with no labels at all is left completely untouched and reported, "
		+ "rather than falling back to firing on every layer, which is the exact behaviour this step "
		+ "exists to get away from. When several objects happen to finish on the same layer, the "
		+ "macro is called once for that layer, not once per object sharing it.",
	docsAnchor: "timelapse-on-each-objects-top-layer",
	icon: "mdi-camera-burst",
	fields: [
		{
			key: "macroPath", label: "Macro to call", type: "text", required: true,
			default: "0:/macros/timelapse.g",
			help: "Called via M98. Point this at your own timelapse-trigger macro. Default: 0:/macros/timelapse.g.",
		},
	],

	analysis(_config: TimelapseTopLayerConfig, ctx: StepFactoryContext): Array<AnalysisCollector> {
		return [new ObjectTopLayerCollector(collectorId(ctx))];
	},

	create(config: TimelapseTopLayerConfig, ctx: StepFactoryContext): Transform {
		const resultKey = collectorId(ctx);
		const call = `M98 P"${config.macroPath}"`;

		let topLayers = new Set<number>();
		let hadAnyObjects = false;
		const firedForLayers = new Set<number>();
		let lastSeenLayer = -1;

		return {
			id: "timelapseTopLayer",

			onStart(runCtx: RunContext): void {
				const perObjectTop = runCtx.analysis.get(resultKey) as Map<string, number> | undefined;
				topLayers = new Set(perObjectTop?.values() ?? []);
				hadAnyObjects = (perObjectTop?.size ?? 0) > 0;
				firedForLayers.clear();
				lastSeenLayer = -1;
			},

			onLine(ctx: LineContext, line: string): string | Array<string> | undefined {
				// The layer that just ENDED (lastSeenLayer, this line's own layer not yet applied) is
				// what might be an object's top layer — checked against the value from BEFORE this
				// transition, not ctx.layer - 1, so a slicer that skips layer numbers is still handled
				// correctly rather than assumed to increment by exactly one.
				const shouldFire = ctx.layerChanged && topLayers.has(lastSeenLayer) && !firedForLayers.has(lastSeenLayer);
				if (shouldFire) firedForLayers.add(lastSeenLayer);
				lastSeenLayer = ctx.layer;
				return shouldFire ? [line, call] : undefined;
			},

			onEnd(runCtx: RunContext): Array<string> | void {
				if (!hadAnyObjects) {
					runCtx.warn(
						"Timelapse on each object's top layer: no M486 object labels found in this file — "
						+ "nothing to trigger for. Add the \"Convert Klipper object markers\" step first if "
						+ "this file needs them.",
					);
					return undefined;
				}
				// The file's own last layer never gets a *following* layer-change event to catch it
				// on — if it is itself some object's top layer, this is the only place left to fire.
				if (topLayers.has(lastSeenLayer) && !firedForLayers.has(lastSeenLayer)) {
					firedForLayers.add(lastSeenLayer);
					return [call];
				}
				return undefined;
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (config.macroPath.trim() === "") errors.push("A macro path is required");
		return errors;
	},
};
