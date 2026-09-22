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
import { parseDocument, walkExecution, type EvalValue, type MessageBoxAnswer, type MessageBoxPrompt } from "dwc-gcode-core";

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
	/** Stopped at a blocking `M291` needing an answer `resolveMessageBox` doesn't have - same shape,
	 *  same "rebuild once you have one" story, just triggered by a command instead of a path. */
	| { status: "message-box"; steps: ReadonlyArray<ExecutionStepState>; line: number; prompt: MessageBoxPrompt }
	| { status: "error"; steps: ReadonlyArray<ExecutionStepState>; line: number; message: string };

/**
 * Answers an object-model path from state this plugin's own `MachineState` ALREADY tracks, as of the
 * point the walk has reached so far - `undefined` (never a real `EvalValue`) means "not one of these,
 * fall through to the next resolver" rather than "unknown". Assumes the default X/Y/Z axis order
 * throughout (a config that reassigns axis letters via `M584` isn't accounted for) and stays
 * deliberately small otherwise: every other object-model path this plugin doesn't itself track
 * (temperatures, endstops, GPIO, ...) still falls through to asking the user, which is the honest
 * answer for a plugin with no live machine connection.
 *
 * - `move.axes[0..2].homed` - see `MachineState.homedX`'s own doc comment for exactly what "homed"
 *   means here and why it's a simplification, not real RRF semantics. `state.homedX`/`Y`/`Z` default
 *   to `false`, so a homed check answers confidently even BEFORE any `G28` has run in the walk - "no
 *   evidence of homing yet" genuinely IS "not homed" for an isolated single-file walk with no wider
 *   context, and it's exactly the useful answer when the file being stepped is a homing macro itself
 *   (which typically opens with `if !move.axes[0].homed`, e.g. RRF's own `homeall.g`).
 * - `move.axes[0..2].userPosition` - the last COMMANDED coordinate (`state.x`/`y`/`z`), `undefined`
 *   (fall through) before any move on that axis. Deliberately NOT `machinePosition` too - real RRF's
 *   `machinePosition` can differ from the commanded position by workplace and tool-length offsets,
 *   neither of which this tracker has any visibility into, so claiming to know it would be a
 *   materially less honest simplification than this one.
 * - `state.currentTool` - directly `state.tool` (`-1` when none selected, matching both this
 *   tracker's own convention and RRF's real one for this specific path).
 */
export function resolveKnownPath(path: string, state: MachineState): EvalValue | undefined {
	switch (path) {
		case "move.axes[0].homed": return state.homedX;
		case "move.axes[1].homed": return state.homedY;
		case "move.axes[2].homed": return state.homedZ;
		case "move.axes[0].userPosition": return state.x ?? undefined;
		case "move.axes[1].userPosition": return state.y ?? undefined;
		case "move.axes[2].userPosition": return state.z ?? undefined;
		case "state.currentTool": return state.tool;
		default: return undefined;
	}
}

/** Walks `doc` in real execution order and derives the machine state after each step. A real,
 *  synchronous O(steps) cost - callers defer this the same way `GcodeEditor.vue` already defers
 *  `buildLineStateIndex`, so it doesn't delay the editor's first paint.
 *
 *  `objectModelVersion`, when given, is passed straight through to `walkExecution`'s own option of the
 *  same name: every referenced object-model path is checked against `dwc-gcode-core`'s schema for that
 *  exact RRF version, turning a typo'd/nonexistent path into a hard error instead of a pause asking
 *  for a value that could never be right. Callers should only ever pass a version confirmed to have
 *  real schema data (`machineSnapshot.ts`'s `trackedObjectModelVersion` does that check) - passing an
 *  untracked version makes `walkExecution` throw internally on every blocking condition instead. */
export function buildExecutionIndex(
	doc: Text,
	resolvePath: (path: string) => EvalValue,
	resolveMessageBox: (prompt: MessageBoxPrompt) => MessageBoxAnswer,
	objectModelVersion?: string,
): ExecutionIndex {
	const gdoc = parseDocument(doc.toString());
	const state = createState();
	const steps: Array<ExecutionStepState> = [];

	const outcome = walkExecution(gdoc, {
		resolvePath: (path) => {
			const known = resolveKnownPath(path, state);
			return known !== undefined ? known : resolvePath(path);
		},
		resolveMessageBox,
		objectModelVersion,
		onStep: (step) => {
			applyLineToState(state, doc.line(step.line + 1).text);
			steps.push({ line: step.line, state: { ...state } });
		},
	});

	switch (outcome.status) {
		case "complete": return { status: "complete", steps };
		case "paused": return { status: "paused", steps, line: outcome.line, path: outcome.path };
		case "message-box": return { status: "message-box", steps, line: outcome.line, prompt: outcome.prompt };
		case "error": return { status: "error", steps, line: outcome.line, message: outcome.message };
		default: {
			const exhaustive: never = outcome;
			throw new Error(`walkExecution returned an unknown status: ${JSON.stringify(exhaustive)}`);
		}
	}
}
