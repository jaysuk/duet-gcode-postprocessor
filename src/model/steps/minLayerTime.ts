/**
 * Enforces a minimum time per layer — a layer that prints in four seconds has not had time to cool
 * before the next one lands on top of it, and a file already sliced has no setting left to fix that
 * with. Slicers offer this; this step is the same idea applied after the fact.
 *
 * **Needs the whole layer's duration before its first line**, which a single forward pass cannot
 * know — this is an `analysis()` collector, the same shape as `rewriteTime.ts`'s, walking the file
 * with its own `TimeEstimator` and keying `TimeEstimator.lastMoveSeconds` by `LineContext.layer`
 * (see `analysis.ts`'s per-feature/per-layer stats, built for task 12 §1, for the same technique).
 *
 * **Two remedies.** "Slow" scales every commanded feedrate on a short layer down by
 * `actualSeconds / minSeconds` — approximate (real acceleration is not linear in the scale factor),
 * but the same approximation `TimeEstimator` itself is built on, and the task's own bar is "close
 * enough to matter", not firmware-exact. Never scaled below `minFeedrateMmPerMin`, which is a
 * genuine correctness requirement, not a nicety: a layer that could only reach the target by oozing
 * at 50 mm/min is worse than one three seconds too fast. "Dwell" instead pauses at a parked position
 * for the shortfall, so as never to sit stationary with a hot nozzle over the part.
 *
 * **The scale direction, stated because it is easy to get backwards**: a *short* layer needs *less*
 * speed to take *longer* — the factor is `actual / min` (less than 1), not `min / actual`.
 */

import type { AnalysisCollector } from "../analysisPass";
import type { MachineLimits } from "../gcode/timeModel";
import { TimeEstimator } from "../gcode/timeModel";
import { formatNumber, paramNumber, parseParams, setParam, withBody } from "../gcode/tokenise";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

export type MinLayerTimeMethod = "slow" | "dwell";

export interface MinLayerTimeConfig {
	minSeconds: number;
	method: MinLayerTimeMethod;
	minFeedrateMmPerMin: number;
	parkX: number;
	parkY: number;
}

const COLLECTOR_ID = "minLayerTime";

/** Namespaces the collector id by this step's position in the recipe — see `rewriteTime.ts`'s own
 *  helper of the same name and task 07's defect A, which is what this pattern exists to avoid. */
function collectorId(ctx: StepFactoryContext): string {
	return ctx.stepIndex !== undefined ? `${COLLECTOR_ID}#${ctx.stepIndex}` : COLLECTOR_ID;
}

class MinLayerTimeCollector implements AnalysisCollector<Map<number, number>> {
	private readonly estimator: TimeEstimator;
	private readonly layerSeconds = new Map<number, number>();

	constructor(readonly id: string, limits: MachineLimits) {
		this.estimator = new TimeEstimator(limits);
	}

	onLine(ctx: LineContext): void {
		this.estimator.line(ctx.token, ctx);
		const added = this.estimator.lastMoveSeconds;
		if (added > 0) this.layerSeconds.set(ctx.layer, (this.layerSeconds.get(ctx.layer) ?? 0) + added);
	}

	result(): Map<number, number> {
		return this.layerSeconds;
	}
}

const G_MOVE_CODES = new Set(["G0", "G1", "G2", "G3"]);

export const minLayerTimeStep: StepDefinition<MinLayerTimeConfig> = {
	id: "minLayerTime",
	label: "Enforce a minimum layer time",
	description: "Slows or pauses a layer that would otherwise print too fast to cool.",
	icon: "mdi-timer-sand",
	fields: [
		{
			key: "minSeconds", label: "Minimum layer time (s)", type: "number", default: 10, min: 0,
			help: "A layer clamped shorter than this is slowed or paused to make up the difference. Default: 10.",
		},
		{
			key: "method", label: "When a layer is too fast", type: "select", default: "slow",
			options: [
				{ value: "slow", label: "Slow the layer" },
				{ value: "dwell", label: "Dwell away from the part" },
			],
			help: "Slowing scales feedrate down; dwelling parks and waits. Default: slow.",
		},
		{
			key: "minFeedrateMmPerMin", label: "Never slow below (mm/min)", type: "number", default: 300, min: 1,
			showWhen: { key: "method", equals: ["slow"] },
			help: "A layer that cannot reach the target without going slower than this is reported, not forced. Default: 300.",
		},
		{
			key: "parkX", label: "Park X", type: "number", default: 0,
			showWhen: { key: "method", equals: ["dwell"] },
			help: "Where to move before dwelling, clear of the part. Default: 0.",
		},
		{
			key: "parkY", label: "Park Y", type: "number", default: 0,
			showWhen: { key: "method", equals: ["dwell"] },
			help: "Where to move before dwelling, clear of the part. Default: 0.",
		},
	],

	analysis(_config: MinLayerTimeConfig, ctx: StepFactoryContext): Array<AnalysisCollector> {
		if (ctx.machineLimits === undefined) return [];
		return [new MinLayerTimeCollector(collectorId(ctx), ctx.machineLimits)];
	},

	create(config: MinLayerTimeConfig, ctx: StepFactoryContext): Transform {
		const resultKey = collectorId(ctx);
		let layerSeconds: Map<number, number> | null = null;
		let previousLayer = -1;
		let movesSlowed = 0;
		const slowedLayers = new Set<number>();
		const flooredLayers = new Set<number>();
		let dwelledLayers = 0;

		/** The layer's own clamped duration falls short of the target — `null` when it does not
		 *  (nothing to remedy), or when this layer's duration is not known at all. */
		function shortfallSeconds(layer: number): number | null {
			if (layerSeconds === null) return null;
			const actual = layerSeconds.get(layer);
			if (actual === undefined || actual <= 0 || actual >= config.minSeconds) return null;
			return config.minSeconds - actual;
		}

		function dwellLinesFor(layer: number): Array<string> {
			const actual = layerSeconds?.get(layer);
			if (actual === undefined) return [];
			const shortfall = shortfallSeconds(layer);
			if (shortfall === null) return [];
			const dwellMs = Math.round(shortfall * 1000);
			if (dwellMs <= 0) return [];
			dwelledLayers++;
			return [
				`G1 X${formatNumber(config.parkX, 3)} Y${formatNumber(config.parkY, 3)}`,
				`G4 P${dwellMs}`,
			];
		}

		return {
			id: "minLayerTime",

			onStart(runCtx: RunContext): void {
				layerSeconds = (runCtx.analysis.get(resultKey) as Map<number, number> | undefined) ?? null;
			},

			onLine(lineCtx: LineContext, line: string): string | Array<string> | undefined {
				const prefix: Array<string> = [];
				// The layer that just ended is `previousLayer`, not `lineCtx.layer - 1` — layer numbers
				// are not guaranteed to increment by exactly one on every marker style this codebase
				// supports (Simplify3D's 1-based numbers are normalised, but nothing guarantees no
				// gaps), so the actually-seen previous value is what must be remedied, not an assumption.
				if (config.method === "dwell" && lineCtx.layerChanged && previousLayer >= 0 && previousLayer !== lineCtx.layer) {
					prefix.push(...dwellLinesFor(previousLayer));
				}
				previousLayer = lineCtx.layer;

				let rewritten: string | undefined;
				if (config.method === "slow" && lineCtx.token.letter === "G" && lineCtx.token.code !== null
					&& G_MOVE_CODES.has(lineCtx.token.code)) {
					const actual = layerSeconds?.get(lineCtx.layer);
					if (actual !== undefined && actual > 0 && actual < config.minSeconds) {
						const scale = actual / config.minSeconds; // < 1: less speed, more time
						const params = parseParams(lineCtx.token.body);
						const currentF = paramNumber(params, "F") ?? lineCtx.feedrate;
						if (currentF !== null) {
							const target = Math.max(currentF * scale, config.minFeedrateMmPerMin);
							if (target < currentF) {
								movesSlowed++;
								slowedLayers.add(lineCtx.layer);
								if (target <= config.minFeedrateMmPerMin) flooredLayers.add(lineCtx.layer);
								const body = setParam(lineCtx.token.body, "F", formatNumber(target, 0));
								rewritten = withBody(lineCtx.token, body);
							}
						}
					}
				}

				if (prefix.length === 0) return rewritten;
				return rewritten === undefined ? [...prefix, line] : [...prefix, rewritten];
			},

			onEnd(runCtx: RunContext): Array<string> | void {
				if (layerSeconds === null) {
					runCtx.warn("This machine's motion limits were not available: no layer time was enforced.");
					return undefined;
				}
				if (movesSlowed > 0) {
					runCtx.warn(
						`Slowed ${movesSlowed} move${movesSlowed === 1 ? "" : "s"} across ${slowedLayers.size} `
						+ `layer${slowedLayers.size === 1 ? "" : "s"} to stay at or above ${config.minSeconds}s.`,
					);
				}
				if (flooredLayers.size > 0) {
					runCtx.warn(
						`${flooredLayers.size} layer${flooredLayers.size === 1 ? "" : "s"} could not reach `
						+ `${config.minSeconds}s without going below the ${config.minFeedrateMmPerMin} mm/min floor — `
						+ "slowed as far as the floor allows, not further.",
					);
				}
				const trailing = config.method === "dwell" && previousLayer >= 0 ? dwellLinesFor(previousLayer) : [];
				if (dwelledLayers > 0) {
					runCtx.warn(`Dwelled after ${dwelledLayers} layer${dwelledLayers === 1 ? "" : "s"} that printed too fast to cool.`);
				}
				return trailing.length > 0 ? trailing : undefined;
			},
		};
	},

	validate(config: MinLayerTimeConfig): Array<string> {
		const errors: Array<string> = [];
		if (config.minSeconds < 0) errors.push("Minimum layer time cannot be negative");
		if (config.method === "slow" && config.minFeedrateMmPerMin <= 0) errors.push("The feedrate floor must be positive");
		return errors;
	},
};
