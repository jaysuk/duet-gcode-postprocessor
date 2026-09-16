/**
 * Random(-ish) access to "what layer/Z/tool is line N on", for the editor's own gutter — the
 * G-code-native panel `dwc-gcode-editor` deliberately has no opinion on (its own doc comment: "this
 * package has no opinion on what that gutter shows").
 *
 * `state.ts`'s tracker is inherently sequential (each line's effect depends on every line before
 * it), so answering "what's the state at line 4,000,000" naively means replaying 4 million lines —
 * fine once, expensive on every scroll/cursor-move in a huge file. This builds a sparse index of
 * checkpoints (one full `MachineState` snapshot every `checkpointEvery` lines) once, then answers
 * any range query by replaying from the nearest checkpoint rather than from line 1 — bounded work
 * per query regardless of how far into the file it lands.
 */

import type { Text } from "@codemirror/state";
import { tokenise } from "dwc-gcode-core";

import { applyToken, beginLine, createState, type MachineState } from "./state";
import { splitCommands } from "./splitCommands";

export interface LineStateIndex {
	readonly checkpointEvery: number;
	/** `checkpoints[i]` is the state as of just after completing line `i * checkpointEvery` (1-based
	 *  line numbering) — `checkpoints[0]` is the initial state, before line 1 has been applied. */
	readonly checkpoints: ReadonlyArray<MachineState>;
	readonly totalLines: number;
}

const DEFAULT_CHECKPOINT_EVERY = 500;

function applyLineToState(state: MachineState, raw: string): void {
	const subLines = splitCommands(raw);
	beginLine(state);
	for (const subRaw of subLines) applyToken(state, tokenise(subRaw));
}

/** Walks the whole document once. A real, one-time O(n) cost (paid once when a file is opened, not
 *  on every render) — the same tradeoff `AnalysisRunner`'s own full-file pass already makes for
 *  this plugin's other file-wide features. */
export function buildLineStateIndex(doc: Text, checkpointEvery = DEFAULT_CHECKPOINT_EVERY): LineStateIndex {
	const state = createState();
	const checkpoints: Array<MachineState> = [{ ...state }];
	for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
		applyLineToState(state, doc.line(lineNo).text);
		if (lineNo % checkpointEvery === 0) checkpoints.push({ ...state });
	}
	return { checkpointEvery, checkpoints, totalLines: doc.lines };
}

/**
 * The state as of just after completing each line in `[fromLine, toLine]` (1-based, inclusive),
 * replaying from the nearest checkpoint at or before `fromLine` — the shape a gutter actually wants
 * (one lookup per visible-range render, not one per visible line), rather than a single-line query
 * repeated per line, which would redo the checkpoint-to-fromLine replay once per line for no reason.
 */
export function statesForLineRange(
	index: LineStateIndex,
	doc: Text,
	fromLine: number,
	toLine: number,
): Map<number, MachineState> {
	const result = new Map<number, MachineState>();
	const clampedFrom = Math.max(1, fromLine);
	const clampedTo = Math.min(index.totalLines, toLine);
	if (clampedFrom > clampedTo) return result;

	const checkpointNumber = Math.floor((clampedFrom - 1) / index.checkpointEvery);
	const state = { ...index.checkpoints[checkpointNumber] };
	const replayFrom = checkpointNumber * index.checkpointEvery + 1;

	for (let lineNo = replayFrom; lineNo <= clampedTo; lineNo++) {
		applyLineToState(state, doc.line(lineNo).text);
		if (lineNo >= clampedFrom) result.set(lineNo, { ...state });
	}
	return result;
}

/** Convenience for a single line — internally just a one-line `statesForLineRange`. Prefer
 *  `statesForLineRange` when querying more than one line (e.g. a gutter's whole visible range). */
export function stateAtLine(index: LineStateIndex, doc: Text, lineNo: number): MachineState | null {
	return statesForLineRange(index, doc, lineNo, lineNo).get(lineNo) ?? null;
}
