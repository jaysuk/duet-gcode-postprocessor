/**
 * The offline stepper's execution-order counterpart to `lineState.ts`'s flat, checkpointed
 * physical-line index. `lineState.ts` assumes every line runs exactly once, top to bottom - fine for
 * the always-on gutter, wrong for a stepper walking a file with real `if`/`while` control flow (a
 * false branch's body never runs; a loop body runs more than once).
 *
 * `dwc-gcode-core`'s `walkExecution` (task: offline conditional stepping) does the RRF-faithful
 * control-flow interpretation; this module's only job is turning its `steps` (a sequence of physical
 * line numbers) into the same per-step `MachineState` progression `lineState.ts` already knows how to
 * compute for one line (`applyLineToState`, exported from there for exactly this reuse).
 *
 * Built whole, in one synchronous pass, same as `buildLineStateIndex` - no checkpoint tiering, since
 * `walkExecution`'s own `maxSteps` (default 200 000) already bounds the array this produces.
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

/** Walks `doc` in real execution order and derives the machine state after each step. A real,
 *  synchronous O(steps) cost - callers defer this the same way `GcodeEditor.vue` already defers
 *  `buildLineStateIndex`, so it doesn't delay the editor's first paint. */
export function buildExecutionIndex(doc: Text, resolvePath: (path: string) => EvalValue): ExecutionIndex {
	const gdoc = parseDocument(doc.toString());
	const outcome = walkExecution(gdoc, { resolvePath });

	const state = createState();
	const steps: Array<ExecutionStepState> = [];
	for (const step of outcome.steps) {
		applyLineToState(state, doc.line(step.line + 1).text);
		steps.push({ line: step.line, state: { ...state } });
	}

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
