/**
 * Predictive pre-heat: for each tool change, works out how long that tool's heaters take to reach
 * their active temperature from standby (see `preheat.ts`'s `heatUpSeconds`, RRF's own `M307` model)
 * and inserts `M568 P<n> A2` that far back on the time axis, so the tool is ready exactly when it is
 * needed instead of the print stalling on it — or worse, not waiting and extruding cold.
 *
 * Needs two things a single forward pass cannot know about itself: every tool change in the file
 * (including ones that have not happened yet) and the cumulative time up to each one. Both come from
 * `PreheatCollector`, this step's `analysis()` collector (see `analysisPass.ts`) — the whole reason
 * task 05 exists. The transform pass reads the collector's result back in `onStart` and, from it,
 * precomputes every insertion point before the first source line is even processed; `onLine` only
 * has to notice when the running clock reaches one.
 */

import { paramNumber, parseParams } from "../gcode/tokenise";
import { TimeEstimator, type MachineLimits } from "../gcode/timeModel";
import { heatUpSeconds, HEATUP_CAP_SECONDS, type ToolConfig } from "../preheat";
import type { AnalysisCollector } from "../analysisPass";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

export interface PreheatConfig {
	/** Room temperature, °C — the object model has no live ambient reading, so this is asked for. */
	ambient: number;
	/** Return the tool being left to standby once its replacement is on its way. Default on. */
	standbyPrevious: boolean;
}

interface ToolChangeEvent {
	tool: number;
	elapsedSeconds: number;
	layer: number;
}

interface ExistingPreheatEvent {
	tool: number;
	elapsedSeconds: number;
}

interface CollectedEvents {
	changes: Array<ToolChangeEvent>;
	existingPreheats: Array<ExistingPreheatEvent>;
}

const COLLECTOR_ID = "preheat";

class PreheatCollector implements AnalysisCollector<CollectedEvents> {
	readonly id = COLLECTOR_ID;
	private readonly estimator: TimeEstimator;
	private lastTool = -1;
	private readonly changes: Array<ToolChangeEvent> = [];
	private readonly existingPreheats: Array<ExistingPreheatEvent> = [];

	constructor(limits: MachineLimits) {
		this.estimator = new TimeEstimator(limits);
	}

	onLine(ctx: LineContext): void {
		const token = ctx.token;
		this.estimator.line(token, ctx);

		if (token.letter === "T" && token.number !== null) {
			const tool = Math.trunc(token.number);
			if (tool !== this.lastTool) {
				this.changes.push({ tool, elapsedSeconds: this.estimator.elapsed, layer: ctx.layer });
				this.lastTool = tool;
			}
			return;
		}

		if (token.letter === "M" && token.code === "M568") {
			const params = parseParams(token.body);
			const a = paramNumber(params, "A");
			const p = paramNumber(params, "P");
			if (a === 2 && p !== null) {
				this.existingPreheats.push({ tool: Math.trunc(p), elapsedSeconds: this.estimator.elapsed });
			}
		}
	}

	result(): CollectedEvents {
		return { changes: this.changes, existingPreheats: this.existingPreheats };
	}
}

type Action = "preheat" | "standby";

interface Insertion {
	atSeconds: number;
	tool: number;
	action: Action;
}

interface PlanResult {
	insertions: Array<Insertion>;
	leadSeconds: Array<number>;
	clampedAt: Array<{ tool: number; layer: number }>;
	/** Tools where at least one heater's estimate hit {@link HEATUP_CAP_SECONDS} — it may never
	 *  actually reach temperature at full power. */
	cappedTools: Set<number>;
	noModel: Set<number>;
	noStandby: Set<number>;
	noHeater: Set<number>;
}

/**
 * Turn the collected tool-change events into an ordered list of insertions. Pure, so the planning
 * logic — the part with all the edge cases — is unit-testable without a pipeline.
 */
export function planPreheats(
	events: CollectedEvents,
	tools: Array<ToolConfig>,
	config: PreheatConfig,
): PlanResult {
	const byNumber = new Map(tools.map((t) => [t.toolNumber, t]));
	const insertions: Array<Insertion> = [];
	const leadSeconds: Array<number> = [];
	const clampedAt: Array<{ tool: number; layer: number }> = [];
	const cappedTools = new Set<number>();
	const noModel = new Set<number>();
	const noStandby = new Set<number>();
	const noHeater = new Set<number>();

	let previousTool = -1;
	for (const change of events.changes) {
		const { tool, elapsedSeconds: changeTime, layer } = change;
		if (tool === previousTool) continue;

		const toolConfig = byNumber.get(tool);
		if (toolConfig === undefined || toolConfig.heaters.length === 0) {
			noHeater.add(tool);
			previousTool = tool;
			continue;
		}

		// A tool can drive several heaters (e.g. a dual hot end mixing tool) — M568 sets them all
		// at once, so the tool is not ready until the slowest of them arrives
		let maxLead = 0;
		let anyUsable = false;
		for (const heater of toolConfig.heaters) {
			if (heater.standby >= heater.active) { noStandby.add(tool); continue; }
			if (heater.model === null) { noModel.add(tool); continue; }
			const secs = heatUpSeconds({
				from: heater.standby, to: heater.active, model: heater.model, ambient: config.ambient,
			});
			if (secs === null) { noModel.add(tool); continue; }
			if (secs >= HEATUP_CAP_SECONDS) cappedTools.add(tool);
			anyUsable = true;
			maxLead = Math.max(maxLead, secs);
		}

		if (anyUsable) {
			let targetSeconds = changeTime - maxLead;
			let clamped = false;
			if (targetSeconds < 0) { targetSeconds = 0; clamped = true; }

			const alreadyHandled = events.existingPreheats.some(
				(p) => p.tool === tool && p.elapsedSeconds <= changeTime && p.elapsedSeconds > targetSeconds - 1e-6,
			);

			if (!alreadyHandled) {
				insertions.push({ atSeconds: targetSeconds, tool, action: "preheat" });
				leadSeconds.push(changeTime - targetSeconds);
				if (clamped) clampedAt.push({ tool, layer });
			}
		}

		// Leave the outgoing tool on standby once the incoming one is on its way — unless it already
		// has a pre-heat of its own scheduled at or after this point, which a standby command here
		// would immediately contradict
		if (config.standbyPrevious && previousTool >= 0 && previousTool !== tool) {
			const prevHasPendingPreheat = insertions.some(
				(ins) => ins.tool === previousTool && ins.action === "preheat" && ins.atSeconds >= changeTime,
			);
			if (!prevHasPendingPreheat && byNumber.has(previousTool)) {
				insertions.push({ atSeconds: changeTime, tool: previousTool, action: "standby" });
			}
		}

		previousTool = tool;
	}

	insertions.sort((a, b) => a.atSeconds - b.atSeconds);
	return { insertions, leadSeconds, clampedAt, cappedTools, noModel, noStandby, noHeater };
}

export const preheatStep: StepDefinition<PreheatConfig> = {
	id: "preheat",
	label: "Predictive pre-heat",
	description: "Inserts M568 A2 ahead of each tool change so the tool is at temperature when it's needed.",
	icon: "mdi-thermometer-chevron-up",
	fields: [
		{
			key: "ambient", label: "Room temperature", type: "number", default: 20, min: -20, max: 60,
			help: "The object model has no live ambient reading, so the heat-up estimate needs this. Default: 20°C.",
		},
		{
			key: "standbyPrevious", label: "Return the previous tool to standby", type: "boolean", default: true,
			help: "Off leaves the outgoing tool at its active temperature. Default: on.",
		},
	],

	analysis(_config: PreheatConfig, ctx: StepFactoryContext): Array<AnalysisCollector> {
		if (ctx.machineLimits === undefined) return [];
		return [new PreheatCollector(ctx.machineLimits)];
	},

	create(config: PreheatConfig, ctx: StepFactoryContext): Transform {
		const limits = ctx.machineLimits;
		const tools = ctx.toolHeaters ?? [];
		const estimator = limits !== undefined ? new TimeEstimator(limits) : null;

		let plan: PlanResult | null = null;
		let nextIndex = 0;
		let toolsInFile = new Set<number>();

		return {
			id: "preheat",

			onStart(runCtx: RunContext): void {
				const events = runCtx.analysis.get(COLLECTOR_ID) as CollectedEvents | undefined;
				toolsInFile = new Set((events?.changes ?? []).map((c) => c.tool));
				// A file that only ever selects one tool has nothing to pre-heat for — reported in
				// onEnd, and skipped here rather than dutifully "pre-heating" that tool's own first
				// selection, which would be indistinguishable from doing nothing useful
				plan = events !== undefined && estimator !== null && toolsInFile.size > 1
					? planPreheats(events, tools, config)
					: null;
				nextIndex = 0;
			},

			onLine(lineCtx: LineContext, line: string): Array<string> | string | undefined {
				estimator?.line(lineCtx.token, lineCtx);
				if (plan === null || estimator === null) return undefined;

				const elapsed = estimator.elapsed;
				const commands: Array<string> = [];
				while (nextIndex < plan.insertions.length && plan.insertions[nextIndex].atSeconds <= elapsed) {
					const insertion = plan.insertions[nextIndex];
					const a = insertion.action === "preheat" ? 2 : 1;
					commands.push(`M568 P${insertion.tool} A${a}`);
					nextIndex++;
				}
				if (commands.length === 0) return undefined;
				return [...commands, line];
			},

			onEnd(runCtx: RunContext): void {
				if (limits === undefined) {
					runCtx.warn("Could not pre-heat: this machine's motion limits were not available.");
					return;
				}
				if (toolsInFile.size <= 1) {
					runCtx.warn("Only one tool is used in this file — nothing to pre-heat.");
					return;
				}
				if (plan === null) return;

				for (const tool of plan.noHeater) runCtx.warn(`T${tool} has no heater — skipped.`);
				for (const tool of plan.noStandby) {
					runCtx.warn(`T${tool} has no standby temperature set below its active temperature — nothing to pre-heat.`);
				}
				for (const tool of plan.noModel) {
					runCtx.warn(`T${tool}'s heater has no tuned M307 model — cannot estimate a heat-up time.`);
				}
				for (const tool of plan.cappedTools) {
					runCtx.warn(`T${tool} may not reach its active temperature in time at full power — its heat-up estimate hit the cap.`);
				}

				const total = plan.leadSeconds.length;
				if (total > 0) {
					const avg = plan.leadSeconds.reduce((a, b) => a + b, 0) / total;
					const longest = Math.max(...plan.leadSeconds);
					runCtx.warn(
						`Pre-heated ${total} tool change${total === 1 ? "" : "s"}, `
						+ `average lead ${avg.toFixed(0)} s, longest ${longest.toFixed(0)} s`
						+ (plan.clampedAt.length > 0
							? `; ${plan.clampedAt.length} clamped to the start of the file (not enough print `
								+ `beforehand for T${plan.clampedAt.map((c) => c.tool).join(", T")}).`
							: "."),
					);
				} else if (plan.noHeater.size === 0 && plan.noStandby.size === 0 && plan.noModel.size === 0) {
					runCtx.warn("No tool changes needed pre-heating.");
				}
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (typeof config.ambient !== "number" || !Number.isFinite(config.ambient)) {
			errors.push("Room temperature must be a number");
		}
		return errors;
	},
};
