/**
 * Renumber tools for a file sliced against a different tool assignment.
 *
 * A find-and-replace on "T0" also rewrites it inside `; use T0 for this` and inside `M117 T0`, and
 * does nothing sensible with `M568 P0`. This operates on parsed parameters via the tokeniser instead,
 * exactly like every other parameter-rewriting step in this plugin.
 */

import { findParam, parseParams, setParam, tokenise, withBody } from "../gcode/tokenise";
import { StepConfigError, type LineContext, type StepDefinition, type Transform } from "./types";

export interface ToolRenumberConfig {
	mapping: string;
}

/**
 * Commands whose `P` parameter is a real tool number — verified command-by-command against
 * `Duet3D/wiki-content`'s G-code dictionary (`User_manual/Reference/Gcodes.md`), never guessed from
 * a pattern like "P after an M-code is a tool":
 *
 * - `M563 P` — "Tool number (0 to 49 in RRF 3.x)", defines/redefines a tool.
 * - `M567 P` — "Tool number. If this parameter is not provided, the current tool is used" (mix ratios).
 * - `M568 P` — "Tool number. If this parameter is not provided, the current tool is used" (settings).
 * - `M116 P` — "Tool number... waits for temperatures associated with that tool"; plausible in a
 *   sliced file around a tool change, unlike the config.g-only commands excluded below.
 *
 * Deliberately **not** included:
 *
 * - `M106`/`M107` — `P` is a **fan index**, not a tool. This is the exact regression this allow-list
 *   exists to prevent: a find-and-replace or a heuristic rewrite would silently redirect part
 *   cooling on a file that also renumbers tools, with no error anywhere.
 * - `M585` — `P` is a **Z probe number** (see this project's own `CLAUDE.md` gotcha about M585's
 *   real purpose), not a tool.
 * - `G10` — genuinely ambiguous, not merely unlikely: the wiki documents `G10 P<n> R<n> S<n>` (tool
 *   temperatures, P = tool) and a *separate* `G10 [L1] P<n> X Y Z` (tool offsets, P = tool) alongside
 *   `G10 L2 P<n> ...` / `G10 L20 P<n> ...` (workplace coordinate system number, P = **not** a tool)
 *   — correctly telling these apart needs parsing `L` too, which is more than this step attempts. A
 *   file that sets tool offsets via `G10` keeps its original tool numbers there; renumber it by hand
 *   if it uses G10.
 * - `M207` (per-tool retraction) and `M309` (per-tool heater feedforward) — both are config.g-only
 *   tuning commands that do not appear in a slicer's own G-code output, excluded on realistic scope
 *   rather than on ambiguity.
 */
export const TOOL_PARAM_COMMANDS: ReadonlyArray<{ command: string; param: string }> = [
	{ command: "M563", param: "P" },
	{ command: "M567", param: "P" },
	{ command: "M568", param: "P" },
	{ command: "M116", param: "P" },
];

/**
 * Parse "0->2, 1->0" into a mapping applied simultaneously against the ORIGINAL tool numbers — not
 * a `StepField` list type, because there isn't one (`FieldType` has no "list of pairs"); a compact
 * self-parsed `text` field is the existing precedent for structured config in this plugin (see
 * `rules.ts`'s JSON `textarea`, the same idea at a larger scale).
 */
export function parseToolMapping(text: string): Map<number, number> {
	const mapping = new Map<number, number>();
	const trimmed = text.trim();
	if (trimmed === "") return mapping;
	for (const part of trimmed.split(",")) {
		const piece = part.trim();
		if (piece === "") continue;
		const m = /^(\d+)\s*->\s*(\d+)$/.exec(piece);
		if (m === null) {
			throw new StepConfigError(`"${piece}" is not a valid mapping — use the form "0->2"`);
		}
		const from = Number(m[1]);
		if (mapping.has(from)) {
			throw new StepConfigError(`Tool ${from} is mapped more than once`);
		}
		mapping.set(from, Number(m[2]));
	}
	return mapping;
}

export const toolRenumberStep: StepDefinition<ToolRenumberConfig> = {
	id: "toolRenumber",
	label: "Renumber tools",
	description: "Remaps tool numbers for a file sliced against a different tool assignment.",
	tip: "Rewrites bare T<n> command lines and the tool-number parameter of M563/M567/M568/M116 — "
		+ "never inside a comment, and never M106/M107's fan index or M585's probe number, which reuse "
		+ "the same P letter for something else entirely (see this step's own module comment for the "
		+ "full, wiki-verified list). Every mapping is resolved against the file's ORIGINAL tool "
		+ "numbers at once, so \"0->1, 1->0\" is a genuine swap rather than every T0 becoming T1 and "
		+ "then, on the very next rule, turning straight back into T0. A tool number not listed is "
		+ "left completely unchanged. Does not touch G10 tool offsets — see the module comment for why.",
	docsAnchor: "renumber-tools",
	icon: "mdi-swap-horizontal",
	fields: [
		{
			key: "mapping", label: "Mapping", type: "text", required: true, default: "0->1",
			placeholder: "0->2, 1->0",
			help: "Comma-separated old->new pairs, e.g. \"0->2, 1->0\". Applied simultaneously against "
				+ "the file's original tool numbers, so a swap works correctly. A tool number not "
				+ "listed here is left alone.",
		},
	],

	create(config): Transform {
		const mapping = parseToolMapping(config.mapping);
		return {
			id: "toolRenumber",
			onLine(_ctx: LineContext, line: string) {
				if (mapping.size === 0) return undefined;
				const token = tokenise(line);
				if (token.code === null) return undefined;

				if (token.letter === "T" && token.number !== null) {
					const next = mapping.get(token.number);
					if (next === undefined) return undefined;
					// Preserve anything unusual after the number itself (a checksum, a trailing
					// space before the comment) by only replacing the code's own span.
					const rest = token.body.slice(token.code.length);
					return withBody(token, `T${next}${rest}`);
				}

				for (const { command, param } of TOOL_PARAM_COMMANDS) {
					if (token.code !== command) continue;
					const found = findParam(parseParams(token.body), param);
					if (found === null) return undefined;
					const current = Number(found.value);
					if (!Number.isFinite(current)) return undefined; // an expression, not a plain number
					const next = mapping.get(current);
					if (next === undefined) return undefined;
					return withBody(token, setParam(token.body, param, String(next)));
				}
				return undefined;
			},
		};
	},

	validate(config) {
		try {
			parseToolMapping(config.mapping);
			return [];
		} catch (e) {
			return [(e as Error).message];
		}
	},
};
