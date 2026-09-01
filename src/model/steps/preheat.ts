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
 *
 * `planPreheats` is two-phase — every pre-heat is computed before any standby is decided — after a
 * defect audit (`docs/tasks/07-audit-defects.md`, defects B and C) found the original single-pass
 * version could emit a standby that cancelled a pre-heat that had already fired, and could clamp a
 * pre-heat to line 0, above the file's own temperature setup for that tool. See the comments in
 * `planPreheats` for how each is avoided now.
 */

import { findParam, paramNumber, parseParams } from "../gcode/tokenise";
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
	/**
	 * Elapsed seconds of the first command that establishes each tool's active/standby temperatures
	 * — an `M568`/`G10` carrying an explicit `P<tool>` and an `R` or `S` parameter. A tool with no
	 * such command (its temperatures come from `config.g` alone) has no entry here; its floor is then
	 * just its own first selection — see `planPreheats`.
	 */
	tempSetupSeconds: Map<number, number>;
	/**
	 * The same setup command's position as a plain per-line count (1 = the first line the collector
	 * saw), *not* elapsed time. Needed because the setup line and everything around it (`G28`, `G90`,
	 * `M83`, another tool's own setup) are all non-move commands that advance the clock by zero — so
	 * "clamp to this tool's setup time" alone cannot tell "the line with the setup command" apart from
	 * "the very first line of the file", and a pre-heat clamped by elapsed time only can land above
	 * the command that gives the temperature it is trying to reach any meaning at all. See
	 * docs/tasks/07-audit-defects.md, defect C.
	 */
	tempSetupLineSeq: Map<number, number>;
}

const COLLECTOR_ID = "preheat";

/**
 * Namespace the collector id by this step's position in the recipe, so two `preheat` steps in one
 * recipe don't collide on the same key in the merged analysis results map (see
 * `docs/tasks/07-audit-defects.md`, defect A). Falls back to the bare id when `stepIndex` is not set
 * — a direct unit-test call that passes one shared context to both `analysis()` and `create()` still
 * computes the same key both times.
 */
function collectorId(ctx: StepFactoryContext): string {
	return ctx.stepIndex !== undefined ? `${COLLECTOR_ID}#${ctx.stepIndex}` : COLLECTOR_ID;
}

class PreheatCollector implements AnalysisCollector<CollectedEvents> {
	private readonly estimator: TimeEstimator;
	private lastTool = -1;
	private lineSeq = 0;
	private readonly changes: Array<ToolChangeEvent> = [];
	private readonly existingPreheats: Array<ExistingPreheatEvent> = [];
	private readonly tempSetupSeconds = new Map<number, number>();
	private readonly tempSetupLineSeq = new Map<number, number>();

	constructor(readonly id: string, limits: MachineLimits) {
		this.estimator = new TimeEstimator(limits);
	}

	onLine(ctx: LineContext): void {
		this.lineSeq++;
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

		const isM568 = token.letter === "M" && token.code === "M568";
		const isG10 = token.letter === "G" && token.code === "G10";
		if (!isM568 && !isG10) return;

		const params = parseParams(token.body);
		const p = paramNumber(params, "P");
		if (p !== null) {
			const tool = Math.trunc(p);
			const setsTemps = findParam(params, "R") !== null || findParam(params, "S") !== null;
			if (setsTemps && !this.tempSetupSeconds.has(tool)) {
				this.tempSetupSeconds.set(tool, this.estimator.elapsed);
				this.tempSetupLineSeq.set(tool, this.lineSeq);
			}
		}

		if (isM568 && p !== null && paramNumber(params, "A") === 2) {
			this.existingPreheats.push({ tool: Math.trunc(p), elapsedSeconds: this.estimator.elapsed });
		}
	}

	result(): CollectedEvents {
		return {
			changes: this.changes,
			existingPreheats: this.existingPreheats,
			tempSetupSeconds: this.tempSetupSeconds,
			tempSetupLineSeq: this.tempSetupLineSeq,
		};
	}
}

type Action = "preheat" | "standby";

interface Insertion {
	atSeconds: number;
	tool: number;
	action: Action;
	/**
	 * For a pre-heat clamped to an explicit temperature-setup line that shares its elapsed time with
	 * other zero-duration commands: do not fire until at least this many lines have been processed,
	 * so the insertion lands after the setup line rather than merely "whenever elapsed time reaches
	 * its value", which could be anywhere in that whole zero-time stretch — see `CollectedEvents`'s
	 * own comment on `tempSetupLineSeq`.
	 */
	minLineSeqAfter?: number;
}

interface PlanResult {
	insertions: Array<Insertion>;
	leadSeconds: Array<number>;
	/** A pre-heat that was emitted, but with less than the ideal lead. */
	clampedAt: Array<{ tool: number; layer: number }>;
	/** A change where not even the earliest legitimate point (the tool's own temperature setup, or
	 *  its first selection) left any real lead — nothing was emitted for it at all. */
	noLeadAt: Array<{ tool: number; layer: number }>;
	/** A pre-heat dropped because another tool already needed one at the exact same instant. */
	droppedStacked: Array<{ tool: number; atSeconds: number }>;
	/** Tools where at least one heater's estimate hit {@link HEATUP_CAP_SECONDS} — it may never
	 *  actually reach temperature at full power. */
	cappedTools: Set<number>;
	noModel: Set<number>;
	noStandby: Set<number>;
	noHeater: Set<number>;
}

interface Candidate {
	tool: number;
	atSeconds: number;
	/** The elapsed time of the change this candidate exists to prepare for. */
	forChangeTime: number;
	layer: number;
	clamped: boolean;
	minLineSeqAfter?: number;
}

/**
 * Turn the collected tool-change events into an ordered list of insertions. Pure, so the planning
 * logic — the part with all the edge cases — is unit-testable without a pipeline.
 *
 * Two-phase by construction: every pre-heat candidate for every change is computed first, and
 * standbys are decided only once that whole picture exists. A single combined pass (compute this
 * change's pre-heat, then immediately decide the outgoing tool's standby) cannot get this right — by
 * the time a standby decision is due, a *later* occurrence of the outgoing tool may already have a
 * pre-heat sitting earlier still (typically because it was clamped to the start of the file), and a
 * standby emitted without knowing that cancels a pre-heat that has already fired.
 */
export function planPreheats(
	events: CollectedEvents,
	tools: Array<ToolConfig>,
	config: PreheatConfig,
): PlanResult {
	const byNumber = new Map(tools.map((t) => [t.toolNumber, t]));

	// A "change" is only real when the tool differs from the one immediately before it
	const distinctChanges: Array<ToolChangeEvent> = [];
	{
		let last = -1;
		for (const c of events.changes) {
			if (c.tool === last) continue;
			distinctChanges.push(c);
			last = c.tool;
		}
	}

	// The earliest point in the file it is legitimate to activate a tool at all: wherever its
	// active/standby temperatures are first established — an explicit M568/G10, or (config.g having
	// presumably already set something sensible) simply the tool's own first selection, whichever
	// comes first. A pre-heat can never be clamped to somewhere earlier than this: activating a tool
	// before anything has said what temperature "active" even means applies whatever was left over
	// from the previous job. See docs/tasks/07-audit-defects.md, defect C.
	const setupFloor = new Map<number, number>();
	for (const c of distinctChanges) {
		if (!setupFloor.has(c.tool)) setupFloor.set(c.tool, c.elapsedSeconds);
	}
	// Tracked separately from setupFloor's value so a candidate can tell whether its floor came from
	// an explicit setup line sharing zero elapsed time with other commands (needing the line-sequence
	// gate below) or from the tool's own first selection (a real, unambiguous move-adjacent line that
	// needs no such gate — and which, per the check just below, never actually produces a pre-heat).
	const explicitFloorLineSeq = new Map<number, number>();
	for (const [tool, seconds] of events.tempSetupSeconds) {
		const existing = setupFloor.get(tool);
		if (existing === undefined || seconds < existing) {
			setupFloor.set(tool, seconds);
			explicitFloorLineSeq.set(tool, events.tempSetupLineSeq.get(tool) as number);
		}
	}

	const leadSeconds: Array<number> = [];
	const clampedAt: Array<{ tool: number; layer: number }> = [];
	const noLeadAt: Array<{ tool: number; layer: number }> = [];
	const droppedStacked: Array<{ tool: number; atSeconds: number }> = [];
	const cappedTools = new Set<number>();
	const noModel = new Set<number>();
	const noStandby = new Set<number>();
	const noHeater = new Set<number>();

	// Phase 1: every pre-heat candidate, independent of any standby decision
	const candidates: Array<Candidate> = [];
	for (const change of distinctChanges) {
		const { tool, elapsedSeconds: changeTime, layer } = change;

		const toolConfig = byNumber.get(tool);
		if (toolConfig === undefined || toolConfig.heaters.length === 0) {
			noHeater.add(tool);
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
		if (!anyUsable) continue;

		const floor = setupFloor.get(tool) ?? 0;
		const ideal = changeTime - maxLead;
		const targetSeconds = Math.max(ideal, floor);

		if (targetSeconds >= changeTime) {
			// Not even the earliest legitimate point leaves any real lead — a one-second pre-heat is
			// not worth a line of G-code, and this is what "clamped to line 0" used to produce
			noLeadAt.push({ tool, layer });
			continue;
		}

		const alreadyHandled = events.existingPreheats.some(
			(p) => p.tool === tool && p.elapsedSeconds <= changeTime && p.elapsedSeconds > targetSeconds - 1e-6,
		);
		if (alreadyHandled) continue;

		const clamped = ideal < floor;
		candidates.push({
			tool, atSeconds: targetSeconds, forChangeTime: changeTime, layer, clamped,
			minLineSeqAfter: clamped ? explicitFloorLineSeq.get(tool) : undefined,
		});
	}

	// Never stack several pre-heats at the exact same instant — keep whichever change needs its tool
	// soonest and drop the rest, with a report line, rather than a burst of simultaneous commands
	const byInstant = new Map<number, Array<Candidate>>();
	for (const c of candidates) {
		const bucket = byInstant.get(c.atSeconds);
		if (bucket === undefined) byInstant.set(c.atSeconds, [c]);
		else bucket.push(c);
	}
	const kept: Array<Candidate> = [];
	for (const bucket of byInstant.values()) {
		if (bucket.length === 1) {
			kept.push(bucket[0]);
			continue;
		}
		bucket.sort((a, b) => a.forChangeTime - b.forChangeTime);
		kept.push(bucket[0]);
		for (const dropped of bucket.slice(1)) droppedStacked.push({ tool: dropped.tool, atSeconds: dropped.atSeconds });
	}

	const insertions: Array<Insertion> = [];
	for (const c of kept) {
		insertions.push({ atSeconds: c.atSeconds, tool: c.tool, action: "preheat", minLineSeqAfter: c.minLineSeqAfter });
		leadSeconds.push(c.forChangeTime - c.atSeconds);
		if (c.clamped) clampedAt.push({ tool: c.tool, layer: c.layer });
	}

	// Phase 2: standbys, decided now that every pre-heat is known. Skip a standby for the outgoing
	// tool when it has a pre-heat that has already fired (atSeconds <= this point) but whose own
	// change has not happened yet — that pre-heat is what is keeping the tool active right now, and a
	// standby here would undo it with nothing left to make it active again before it is next needed.
	let previousTool = -1;
	for (const change of distinctChanges) {
		const { tool, elapsedSeconds: changeTime } = change;
		if (config.standbyPrevious && previousTool >= 0 && previousTool !== tool && byNumber.has(previousTool)) {
			const hasFiredUnconsumedPreheat = kept.some(
				(c) => c.tool === previousTool && c.atSeconds <= changeTime && c.forChangeTime > changeTime,
			);
			if (!hasFiredUnconsumedPreheat) {
				insertions.push({ atSeconds: changeTime, tool: previousTool, action: "standby" });
			}
		}
		previousTool = tool;
	}

	// Tied on atSeconds, order by line-sequence gate ascending: whichever gate clears first must be
	// checked first, so the transform's forward-only queue (see `create` below) never gets stuck
	// behind a later, still-gated entry that happens to share the same time value.
	insertions.sort((a, b) => a.atSeconds - b.atSeconds || (a.minLineSeqAfter ?? -1) - (b.minLineSeqAfter ?? -1));
	return { insertions, leadSeconds, clampedAt, noLeadAt, droppedStacked, cappedTools, noModel, noStandby, noHeater };
}

export const preheatStep: StepDefinition<PreheatConfig> = {
	id: "preheat",
	label: "Predictive pre-heat",
	description: "Inserts M568 A2 ahead of each tool change so the tool is at temperature when it's needed.",
	tip: "Only does anything on a multi-tool file — a single-tool file has nothing to pre-heat for, "
		+ "and says so. Needs both this machine connected (for its motion limits, to know how long "
		+ "the print leading up to each tool change actually takes) and each tool's heater to have a "
		+ "tuned M307 model (to know how fast it heats) — a tool missing either is reported and "
		+ "skipped, not guessed at. When there is not enough print before a tool change to fit the "
		+ "full heat-up time, the pre-heat is clamped as early as it safely can be (never before that "
		+ "tool's own temperatures are first established) and reported as having less lead than "
		+ "ideal — the run report after applying always says exactly how many changes were pre-heated "
		+ "and which ones were not, so nothing here is silent.",
	docsAnchor: "predictive-pre-heat",
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
		return [new PreheatCollector(collectorId(ctx), ctx.machineLimits)];
	},

	create(config: PreheatConfig, ctx: StepFactoryContext): Transform {
		const limits = ctx.machineLimits;
		const tools = ctx.toolHeaters ?? [];
		const estimator = limits !== undefined ? new TimeEstimator(limits) : null;
		const resultKey = collectorId(ctx);

		let plan: PlanResult | null = null;
		let nextIndex = 0;
		let toolsInFile = new Set<number>();
		let lineSeq = 0;

		return {
			id: "preheat",

			onStart(runCtx: RunContext): void {
				const events = runCtx.analysis.get(resultKey) as CollectedEvents | undefined;
				toolsInFile = new Set((events?.changes ?? []).map((c) => c.tool));
				// A file that only ever selects one tool has nothing to pre-heat for — reported in
				// onEnd, and skipped here rather than dutifully "pre-heating" that tool's own first
				// selection, which would be indistinguishable from doing nothing useful
				plan = events !== undefined && estimator !== null && toolsInFile.size > 1
					? planPreheats(events, tools, config)
					: null;
				nextIndex = 0;
				lineSeq = 0;
			},

			onLine(lineCtx: LineContext, line: string): Array<string> | string | undefined {
				lineSeq++;
				estimator?.line(lineCtx.token, lineCtx);
				if (plan === null || estimator === null) return undefined;

				const elapsed = estimator.elapsed;
				const commands: Array<string> = [];
				while (nextIndex < plan.insertions.length) {
					const insertion = plan.insertions[nextIndex];
					if (insertion.atSeconds > elapsed) break;
					// A pre-heat clamped to a temperature-setup line shares that line's elapsed time
					// with everything around it (see `minLineSeqAfter`'s own comment) — hold it back
					// until at least one line past the setup line has actually been processed, so it
					// lands after that line rather than anywhere in its zero-time neighbourhood
					if (insertion.minLineSeqAfter !== undefined && lineSeq <= insertion.minLineSeqAfter) break;
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
				for (const dropped of plan.droppedStacked) {
					runCtx.warn(`T${dropped.tool}'s pre-heat was dropped: another tool already needed one at the same point in the file.`);
				}
				if (plan.noLeadAt.length > 0) {
					const affected = [...new Set(plan.noLeadAt.map((n) => n.tool))];
					runCtx.warn(
						`${plan.noLeadAt.length} tool change${plan.noLeadAt.length === 1 ? "" : "s"} could not be pre-heated at all — `
						+ `T${affected.join(", T")} ${affected.length === 1 ? "is" : "are"} needed too soon after `
						+ `${affected.length === 1 ? "its" : "their"} own temperature is first known in the file.`,
					);
				}

				const total = plan.leadSeconds.length;
				if (total > 0) {
					const avg = plan.leadSeconds.reduce((a, b) => a + b, 0) / total;
					const longest = Math.max(...plan.leadSeconds);
					runCtx.warn(
						`Pre-heated ${total} tool change${total === 1 ? "" : "s"}, `
						+ `average lead ${avg.toFixed(0)} s, longest ${longest.toFixed(0)} s`
						+ (plan.clampedAt.length > 0
							? `; ${plan.clampedAt.length} clamped to less lead than ideal (not enough print `
								+ `beforehand for T${plan.clampedAt.map((c) => c.tool).join(", T")}).`
							: "."),
					);
				} else if (
					plan.noHeater.size === 0 && plan.noStandby.size === 0 && plan.noModel.size === 0
					&& plan.noLeadAt.length === 0
				) {
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
