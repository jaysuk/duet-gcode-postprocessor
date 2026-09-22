/**
 * The offline stepper's execution-order counterpart to `lineState.ts`'s flat, checkpointed
 * physical-line index. `lineState.ts` assumes every line runs exactly once, top to bottom - fine for
 * the always-on gutter, wrong for a stepper walking a file with real `if`/`while` control flow (a
 * false branch's body never runs; a loop body runs more than once).
 *
 * `dwc-gcode-core`'s `walkExecution` (task: offline conditional stepping) does the RRF-faithful
 * control-flow interpretation; this module derives the same per-step `MachineState` progression
 * `lineState.ts` already knows how to compute for one line (`applyLineToState`, exported from there
 * for exactly this reuse), INCREMENTALLY as the walk proceeds (`WalkOptions.onStep`, `dwc-gcode-core`
 * 1.7.0+) rather than replaying `steps` afterwards - the reason is `resolveKnownPath` below, which
 * needs to read state AS OF the condition currently being evaluated, not the finished state after
 * the whole file has run.
 */

import type { Text } from "@codemirror/state";
import { parseDocument, walkExecution, type EvalValue } from "dwc-gcode-core";

import { applyLineToState } from "./lineState";
import { createState, type MachineState } from "./state";

export interface ExecutionStepState {
	/** 0-based physical line index, matching `dwc-gcode-core`'s `walkExecution` and `doc.blocks` - one
	 *  past `setCurrentLine`'s 1-based convention, converted where the two meet (see `GcodeEditor.vue`). */
	readonly line: number;
	readonly state: MachineState;
}

export type ExecutionIndex =
	| { status: "complete"; steps: ReadonlyArray<ExecutionStepState> }
	/** Stopped at a condition needing a value `resolvePath` doesn't have - `steps` holds everything
	 *  executed before it. Rebuild with a `resolvePath` that now answers `path` to get further. */
	| { status: "paused"; steps: ReadonlyArray<ExecutionStepState>; line: number; path: string }
	| { status: "error"; steps: ReadonlyArray<ExecutionStepState>; line: number; message: string };

/**
 * Answers an object-model path from state this plugin's own `MachineState` ALREADY tracks, as of the
 * point the walk has reached so far - `undefined` (never a real `EvalValue`) means "not one of these,
 * fall through to the next resolver" rather than "unknown". Currently just axis-homed status
 * (`move.axes[0..2].homed`, assuming the default X/Y/Z axis order - see `MachineState.homedX`'s own
 * doc comment for exactly what "homed" means here and why it's a simplification, not real RRF
 * semantics). `state.homedX`/`Y`/`Z` default to `false`, so a homed check answers confidently even
 * BEFORE any `G28` has run in the walk - "no evidence of homing yet" genuinely IS "not homed" for an
 * isolated single-file walk with no wider context, and it's exactly the useful answer when the file
 * being stepped is a homing macro itself (which typically opens with `if !move.axes[0].homed`, e.g.
 * RRF's own `homeall.g`). Deliberately small otherwise: every other object-model path this plugin
 * doesn't itself track (temperatures, endstops, GPIO, ...) still falls through to asking the user,
 * which is the honest answer for a plugin with no live machine connection.
 */
export function resolveKnownPath(path: string, state: MachineState): EvalValue | undefined {
	switch (path) {
		case "move.axes[0].homed": return state.homedX;
		case "move.axes[1].homed": return state.homedY;
		case "move.axes[2].homed": return state.homedZ;
		default: return undefined;
	}
}

/** Walks `doc` in real execution order and derives the machine state after each step. A real,
 *  synchronous O(steps) cost - callers defer this the same way `GcodeEditor.vue` already defers
 *  `buildLineStateIndex`, so it doesn't delay the editor's first paint. */
export function buildExecutionIndex(doc: Text, resolvePath: (path: string) => EvalValue): ExecutionIndex {
	const gdoc = parseDocument(doc.toString());
	const state = createState();
	const steps: Array<ExecutionStepState> = [];

	const outcome = walkExecution(gdoc, {
		resolvePath: (path) => {
			const known = resolveKnownPath(path, state);
			return known !== undefined ? known : resolvePath(path);
		},
		onStep: (step) => {
			applyLineToState(state, doc.line(step.line + 1).text);
			steps.push({ line: step.line, state: { ...state } });
		},
	});

	switch (outcome.status) {
		case "complete": return { status: "complete", steps };
		case "paused": return { status: "paused", steps, line: outcome.line, path: outcome.path };
		case "error": return { status: "error", steps, line: outcome.line, message: outcome.message };
		default: {
			const exhaustive: never = outcome;
			throw new Error(`walkExecution returned an unknown status: ${JSON.stringify(exhaustive)}`);
		}
	}
}
