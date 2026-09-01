/**
 * Rebuilds a runnable file starting at a chosen layer, for recovering from a failure partway through
 * a print without reprinting from scratch. The dangerous half of task 11 (PLAN.md §8 phase 13): the
 * first move in the output happens with a part already on the bed, so what this emits — and, just as
 * importantly, what it deliberately does not — is not guesswork.
 *
 * **State reconstruction, not a second read.** Everything the preamble needs — the active tool, bed
 * and tool temperatures, fan state, extrusion/move mode, the absolute `E` position, the last X/Y/Z —
 * is only knowable by reading everything *before* the cut. `RestartFromCollector` is this step's
 * `analysis()` collector (see `analysisPass.ts`, and `rewriteTime.ts` for the smaller worked example
 * this one follows); it turns the file's own G-code, up to the cut, into a plain event stream and
 * hands it to `recovery.ts`'s `recoveryPlan` — a pure fold, independently tested — to get the state
 * at the cut. The transform pass reads that back in `onStart`.
 *
 * **Two decisions this makes, resolved rather than guessed** (`docs/tasks/11-print-recovery.md`'s own
 * stop point):
 *
 * 1. **`G28 Z` is opt-in and off by default.** A machine that homes Z by probing would probe the part
 *    already on the bed, not the bed itself, and set Z to a height wrong by the part's own height — a
 *    machine with a fixed Z endstop is safe to re-home, one with an inductive/BLTouch/eddy probe is
 *    not, and the object model's `sensors.probes[]` is evidence a probe is *configured*, not proof it
 *    is *used* for Z homing. This cannot be told apart without asking, so it is never assumed safe.
 * 2. **No first-layer adhesion trickery** — no re-purge, no extra brim, no altered first-layer speed.
 *    There is no single right answer for a bed that has been sitting with a part on it, and guessing
 *    wastes filament at best. The preamble restores machine state accurately and does nothing more;
 *    if the resumed print needs help sticking, that is a physical, human decision, not a G-code one.
 *
 * **Temperature commands, verified against RepRapFirmware source, not assumed from Marlin
 * familiarity** (`C:\Users\live\Documents\Github\RRFBuild\RepRapFirmware\src\GCodes\GCodes2.cpp`):
 * `M104 T<n> S<temp>` sets tool `<n>`'s heaters "but doesn't ever select a tool" (the case 104 block's
 * own comment, confirmed by the code: `applicableTool` comes from the `T` parameter, tool selection
 * only happens in the `code == 109` branch) — exactly what a preamble needs, since tool *selection*
 * happens later and separately (step 4 below). `M116 P<n>` "wait[s] for the heaters associated with
 * the specified tool to be ready" without selecting it either (`case 116`, the `gb.Seen('P')` branch,
 * calling `ToolHeatersAtSetTemperatures` directly on the tool by number). Bed temperature uses the
 * ordinary `M140`/`M190` this codebase already relies on elsewhere.
 *
 * **Ordering matters**: bed before tool (a tool held hot over a cold bed oozes for the whole bed
 * heat-up), temperatures before tool selection (selecting first would wait on whichever tool becomes
 * current, in the wrong order), and the final reposition is lift-then-travel-then-descend, never a
 * direct travel at the layer's own Z — that would drag the nozzle across the top of the existing part.
 *
 * **Must run before `arcWeld`** — like `extractRange`, this reasons about per-line coordinates and
 * layer boundaries that a welded arc would hide.
 */

import type { AnalysisCollector } from "../analysisPass";
import { emptyRecoveryState, recoveryPlan, type RecoveryEvent, type RecoveryState } from "../recovery";
import { formatNumber, paramNumber, parseParams, unquoteString } from "../gcode/tokenise";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

export interface RestartFromConfig {
	cutLayer: number;
	rehomeZ: boolean;
	liftMm: number;
	liftFeedrateMmPerMin: number;
	travelFeedrateMmPerMin: number;
	descendFeedrateMmPerMin: number;
}

const COLLECTOR_ID = "restartFrom";

/** Namespaces the collector id by this step's position in the recipe — see `rewriteTime.ts`'s own
 *  helper of the same name and task 07's defect A, which is what this pattern exists to avoid. */
function collectorId(ctx: StepFactoryContext): string {
	return ctx.stepIndex !== undefined ? `${COLLECTOR_ID}#${ctx.stepIndex}` : COLLECTOR_ID;
}

class RestartFromCollector implements AnalysisCollector<RecoveryState> {
	private readonly events: Array<RecoveryEvent> = [];
	private x = 0;
	private y = 0;
	private e = 0;
	private frozen = false;

	constructor(readonly id: string, private readonly cutLayer: number) {}

	onLine(ctx: LineContext): void {
		if (this.frozen) return;
		if (ctx.layer >= this.cutLayer) {
			this.frozen = true;
			return;
		}
		const token = ctx.token;
		if (token.letter === "T" && token.number !== null && token.number >= 0) {
			this.events.push({ kind: "tool", tool: token.number });
			return;
		}
		if (token.letter === "M") {
			this.applyM(token.code, token.body, ctx);
		} else if (token.letter === "G") {
			this.applyG(token.code, token.body, ctx);
		}
	}

	private applyM(code: string | null, body: string, ctx: LineContext): void {
		const params = parseParams(body);
		switch (code) {
			case "M104":
			case "M109": {
				const s = paramNumber(params, "S");
				// With no T and no tool selected yet, RRF targets "the lowest-numbered tool"
				// (MovementState::GetLockedCurrentOrDefaultTool, RawMove.cpp) — not necessarily tool 0,
				// and not knowable here without the machine's own tool list. Guessing a number would be
				// exactly the kind of invented fact this module's own comment promises not to produce,
				// so this case is simply not attributed to any tool. In practice every real slicer
				// selects a tool before its first M104, so this only affects a hand-written fixture.
				const t = paramNumber(params, "T") ?? ctx.tool;
				if (s !== null && t >= 0) this.events.push({ kind: "toolTemp", tool: t, temp: s });
				break;
			}
			case "M140":
			case "M190": {
				const s = paramNumber(params, "S");
				if (s !== null) this.events.push({ kind: "bedTemp", temp: s });
				break;
			}
			case "M106": {
				const fan = paramNumber(params, "P") ?? 0;
				const speed = paramNumber(params, "S") ?? 0;
				this.events.push({ kind: "fan", index: fan, speed });
				break;
			}
			case "M107": {
				const fan = paramNumber(params, "P") ?? 0;
				this.events.push({ kind: "fan", index: fan, speed: 0 });
				break;
			}
			case "M82":
				this.events.push({ kind: "extrusionMode", relative: false });
				break;
			case "M83":
				this.events.push({ kind: "extrusionMode", relative: true });
				break;
			case "M486": {
				// Read the index directly from S, rather than LineContext.object — that field conflates
				// a bare M486 S<n>'s stringified index with an M486 S<n> A"name"'s name into one string
				// (state.ts's own convention), and correctly restoring the index (what DWC's
				// cancel-object UI actually keys on) needs the two kept apart.
				const s = paramNumber(params, "S");
				if (s === null) break;
				if (s < 0) {
					this.events.push({ kind: "object", index: null, name: null });
					break;
				}
				let name: string | null = null;
				for (const p of params) {
					if (p.letter === "A") {
						name = unquoteString(p.value);
						break;
					}
				}
				this.events.push({ kind: "object", index: Math.trunc(s), name });
				break;
			}
		}
	}

	private applyG(code: string | null, body: string, ctx: LineContext): void {
		const params = parseParams(body);
		switch (code) {
			case "G90":
				this.events.push({ kind: "moveMode", relative: false });
				break;
			case "G91":
				this.events.push({ kind: "moveMode", relative: true });
				break;
			case "G0":
			case "G1": {
				const relative = ctx.relativeMoves;
				const xp = paramNumber(params, "X");
				const yp = paramNumber(params, "Y");
				const zp = paramNumber(params, "Z");
				const ep = paramNumber(params, "E");
				const nextX = xp !== null ? (relative ? this.x + xp : xp) : null;
				const nextY = yp !== null ? (relative ? this.y + yp : yp) : null;
				if (nextX !== null) this.x = nextX;
				if (nextY !== null) this.y = nextY;
				if (nextX !== null || nextY !== null || zp !== null) {
					this.events.push({ kind: "position", x: nextX, y: nextY, z: zp !== null ? ctx.z : null });
				}
				if (ep !== null) {
					this.e = ctx.relativeE ? this.e + ep : ep;
					this.events.push({ kind: "absoluteE", value: this.e });
				}
				break;
			}
			case "G92": {
				const xp = paramNumber(params, "X");
				const yp = paramNumber(params, "Y");
				const ep = paramNumber(params, "E");
				if (xp !== null) this.x = xp;
				if (yp !== null) this.y = yp;
				if (xp !== null || yp !== null) this.events.push({ kind: "position", x: xp, y: yp, z: null });
				if (ep !== null) {
					this.e = ep;
					this.events.push({ kind: "absoluteE", value: ep });
				}
				break;
			}
		}
	}

	result(): RecoveryState {
		return recoveryPlan(this.events);
	}
}

/** Builds the preamble in the order §2 of the task specifies — see the module comment for why each
 *  position in that order matters. Pure: takes the reconstructed state and the config, nothing else. */
function buildPreamble(state: RecoveryState, config: RestartFromConfig, sourcePath: string): Array<string> {
	const lines: Array<string> = [
		`; --- Restart generated by G-code Post-Processor: resuming ${sourcePath || "the source file"} `
		+ `from layer ${config.cutLayer} ---`,
		"; This reconstructs machine state as it was at that layer: temperatures, fan, tool, extrusion",
		"; and move mode, and absolute E. It does NOT re-home Z"
		+ (config.rehomeZ ? " — G28 Z below, because this was opted into." : ", since a probe would probe the part."),
		"; The original start block (homing, bed levelling, initial temperatures) has been removed.",
	];

	if (config.rehomeZ) lines.push("G28 Z");

	lines.push("G21");
	lines.push(state.relativeMoves ? "G91" : "G90");
	lines.push(state.relativeE ? "M83" : "M82");

	if (state.bedTemp !== null) {
		lines.push(`M140 S${formatNumber(state.bedTemp, 0)}`);
		if (state.bedTemp > 0) lines.push(`M190 S${formatNumber(state.bedTemp, 0)}`);
	}
	for (const [tool, temp] of state.toolTemps) {
		lines.push(`M104 T${tool} S${formatNumber(temp, 0)}`);
		if (temp > 0) lines.push(`M116 P${tool}`);
	}

	if (state.tool >= 0) lines.push(`T${state.tool}`);

	if (state.fan !== null) lines.push(`M106 P${state.fan.index} S${formatNumber(state.fan.speed, 0)}`);

	if (!state.relativeE && state.absoluteE !== null) lines.push(`G92 E${formatNumber(state.absoluteE, 5)}`);

	if (state.object !== null) {
		const name = state.object.name !== null ? ` A"${state.object.name.replace(/"/g, "\"\"")}"` : "";
		lines.push(`M486 S${state.object.index}${name}`);
	}

	if (state.z !== null && state.x !== null && state.y !== null) {
		lines.push(`G1 Z${formatNumber(state.z + config.liftMm, 3)} F${formatNumber(config.liftFeedrateMmPerMin, 0)}`);
		lines.push(`G1 X${formatNumber(state.x, 3)} Y${formatNumber(state.y, 3)} F${formatNumber(config.travelFeedrateMmPerMin, 0)}`);
		lines.push(`G1 Z${formatNumber(state.z, 3)} F${formatNumber(config.descendFeedrateMmPerMin, 0)}`);
	}

	return lines;
}

export const restartFromStep: StepDefinition<RestartFromConfig> = {
	id: "restartFrom",
	label: "Restart from layer",
	description: "Rebuilds a runnable file starting at a chosen layer, reconstructing machine state at the cut.",
	tip: "For recovering from a failed print without starting over: pick the layer it failed at, "
		+ "and this reconstructs everything the resumed print needs — active tool, bed and tool "
		+ "temperatures, fan, extrusion/move mode, absolute E, last X/Y/Z — by reading the whole "
		+ "original file up to that point, exactly like a second reader would. What it deliberately "
		+ "does NOT do: re-home Z (unless you opt in below — a probe would probe the part already on "
		+ "the bed, not the bed itself) or add any first-layer-adhesion trickery for a bed that has "
		+ "sat with a part on it. That is a physical decision for a human, not something this step "
		+ "should guess at. The reposition sequence is always lift, then travel, then descend — never "
		+ "a direct diagonal move at the old Z, which would drag the nozzle across the existing part.",
	docsAnchor: "restart-from-layer",
	icon: "mdi-restart",
	fields: [
		{
			key: "cutLayer", label: "Resume from layer", type: "number", default: 0, min: 0,
			help: "0 is the first layer. Everything before this layer, including the original start block, is replaced by a generated preamble.",
		},
		{
			key: "rehomeZ", label: "Re-home Z (G28 Z)", type: "boolean", default: false,
			help: "Only safe if this machine homes Z to a fixed endstop, not by probing — a probe would probe the part already on the bed. Off by default.",
		},
		{
			key: "liftMm", label: "Lift height (mm)", type: "number", default: 5, min: 0.1,
			help: "How far above the resumed layer's own Z to lift before travelling in XY. Default: 5.",
		},
		{
			key: "liftFeedrateMmPerMin", label: "Lift feedrate (mm/min)", type: "number", default: 600, min: 1,
			help: "How fast to raise Z clear of the part before moving over it in XY. Default: 600.",
		},
		{
			key: "travelFeedrateMmPerMin", label: "Travel feedrate (mm/min)", type: "number", default: 3000, min: 1,
			help: "How fast to move in XY once lifted clear, before descending back to the resumed layer. Default: 3000.",
		},
		{
			key: "descendFeedrateMmPerMin", label: "Descend feedrate (mm/min)", type: "number", default: 300, min: 1,
			help: "Slower than the lift/travel — this move ends at the part, so a gentle approach matters. Default: 300.",
		},
	],

	analysis(config: RestartFromConfig, ctx: StepFactoryContext): Array<AnalysisCollector> {
		return [new RestartFromCollector(collectorId(ctx), config.cutLayer)];
	},

	create(config: RestartFromConfig, ctx: StepFactoryContext): Transform {
		const resultKey = collectorId(ctx);
		let state: RecoveryState | null = null;
		let sourcePath = "";
		let emittedPreamble = false;

		return {
			id: "restartFrom",

			onStart(runCtx: RunContext): void {
				state = (runCtx.analysis.get(resultKey) as RecoveryState | undefined) ?? null;
				sourcePath = runCtx.sourcePath;
			},

			onLine(lineCtx: LineContext, line: string): string | Array<string> | null | undefined {
				if (lineCtx.layer < config.cutLayer) return null;
				if (!emittedPreamble) {
					emittedPreamble = true;
					const preamble = buildPreamble(state ?? emptyRecoveryState(), config, sourcePath);
					return [...preamble, line];
				}
				return undefined;
			},

			onEnd(runCtx: RunContext): void {
				if (!emittedPreamble) {
					runCtx.warn(
						`No lines were found at or after layer ${config.cutLayer} — the output would be empty `
						+ "except for the preamble. Check the layer number against this file's actual layer count.",
					);
				}
			},
		};
	},

	validate(config: RestartFromConfig): Array<string> {
		const errors: Array<string> = [];
		if (config.cutLayer < 0) errors.push("Resume layer cannot be negative");
		if (config.liftMm <= 0) errors.push("Lift height must be positive");
		return errors;
	},
};
