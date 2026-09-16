/**
 * Split a raw source line into one substring per G/M/T command it holds.
 *
 * RRF allows several commands on one line (`dwc-gcode-core`'s `lex.ts`: "`G90 G1 X10` is two"), but
 * this plugin's whole model — `state.ts`'s tracker, every step's `onLine`, the analysis pass —
 * was built on `tokenise()`, which only ever sees a line's FIRST command (that function's own
 * `@deprecated` note). A hand-written start/end/pause macro combining a mode change with a move on
 * one line (`G90 G1 Z5`, `M83 G92 E0`) silently lost the second command everywhere: the state
 * machine never saw the move (so Z/feedrate/layer tracking, and any anchor depending on them, missed
 * it entirely), and any rewriting step only ever matched/touched the first command.
 *
 * The fix lives here rather than in each of the ~20 call sites: split the line into per-command
 * substrings using `dwc-gcode-core`'s real, faithful `lexLine()`, and let every existing caller keep
 * calling the simple, first-command `tokenise()` on each substring in turn — each one only ever
 * holds a single command, exactly what `tokenise()` was already correct for.
 */

import { lexLine } from "dwc-gcode-core";

/**
 * Returns `[raw]` unchanged for the overwhelmingly common case (zero or one command on the line) —
 * every existing single-command code path stays byte-for-byte untouched. For a line with N (>1)
 * commands, returns N substrings in source order; the first includes whatever precedes the first
 * command (indentation, a line number, a checksum — none of which any caller here reads today), and
 * the last includes any trailing comment. Concatenating the result always reconstructs `raw` exactly.
 */
export function splitCommands(raw: string): ReadonlyArray<string> {
	const lexed = lexLine(raw);
	const commands = lexed.commands;
	if (commands.length <= 1) return [raw];

	const out: Array<string> = [];
	for (let i = 0; i < commands.length; i++) {
		const isLast = i === commands.length - 1;
		const end = isLast ? raw.length : commands[i + 1].start;
		out.push(i === 0 ? raw.slice(0, end) : raw.slice(commands[i].start, end));
	}
	return out;
}
