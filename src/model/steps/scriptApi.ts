/**
 * The standard library handed to a script step.
 *
 * Without this, every script starts by re-implementing G-code parsing with a regular expression —
 * which is exactly how post-processing scripts corrupt files (a `;` inside a quoted string, a
 * parameter written as `X 10`, a line with a checksum). Handing scripts the same tested tokeniser
 * the rest of the plugin uses is the single biggest thing that makes them safe to write.
 *
 * Deliberately dependency-free and pure, so every helper is unit-tested directly.
 */

import {
	findParam, formatNumber, parseParams, removeParam as removeParamFromBody, setParam as setParamInBody,
	tokenise, withBody,
} from "../gcode/tokenise";

export interface ParsedLine {
	/** Command such as "G1", "M104", "T0", or null for a comment or blank line. */
	code: string | null;
	/** Parameters as a plain object keyed by upper-case letter, values as written. */
	params: Record<string, string>;
	/** Comment text without the leading ";", or null. */
	comment: string | null;
	/** True for a blank or comment-only line. */
	isComment: boolean;
}

export interface GcodeApi {
	/** Parse a line into its command, parameters and comment. */
	parse(line: string): ParsedLine;
	/** Numeric value of a parameter, or null when absent or non-numeric. */
	num(line: string, letter: string): number | null;
	/** Raw text of a parameter (quotes and braces included), or null. */
	str(line: string, letter: string): string | null;
	/** True when the line has the given parameter. */
	has(line: string, letter: string): boolean;
	/** Set or add a parameter, leaving the rest of the line byte-identical. */
	set(line: string, letter: string, value: number | string, decimals?: number): string;
	/** Multiply a numeric parameter. Returns the line unchanged when it is absent or non-numeric. */
	scale(line: string, letter: string, factor: number, decimals?: number): string;
	/** Add to a numeric parameter. Returns the line unchanged when it is absent or non-numeric. */
	offset(line: string, letter: string, delta: number, decimals?: number): string;
	/** Remove a parameter. */
	remove(line: string, letter: string): string;
	/** True when the line is a G0/G1/G2/G3 move. */
	isMove(line: string): boolean;
	/** True when the line is a move that extrudes (a positive E, or any E in relative mode). */
	isExtrusion(line: string, relativeE?: boolean): boolean;
	/** Replace the comment on a line (pass null to strip it). */
	setComment(line: string, comment: string | null): string;
	/** Format a number the way the rest of the plugin does: fixed decimals, trailing zeros trimmed. */
	format(value: number, decimals?: number): string;
	/** The command of a line, upper-cased, or null. */
	command(line: string): string | null;
}

const DEFAULT_DECIMALS = 3;

/**
 * Build the helper object. Stateless, so one instance is shared for a whole run — but it is created
 * per step so a future engine (a worker, QuickJS) can hand across a marshalled equivalent instead.
 */
export function createGcodeApi(): GcodeApi {
	return {
		parse(line: string): ParsedLine {
			const token = tokenise(line);
			const params: Record<string, string> = {};
			if (token.code !== null) {
				for (const p of parseParams(token.body)) {
					if (!(p.letter in params)) params[p.letter] = p.value;
				}
			}
			return {
				code: token.code,
				params,
				comment: token.comment,
				isComment: token.isCommentOnly,
			};
		},

		num(line: string, letter: string): number | null {
			const token = tokenise(line);
			const p = findParam(parseParams(token.body), letter);
			if (p === null) return null;
			const n = Number(p.value);
			return Number.isFinite(n) ? n : null;
		},

		str(line: string, letter: string): string | null {
			const token = tokenise(line);
			return findParam(parseParams(token.body), letter)?.value ?? null;
		},

		has(line: string, letter: string): boolean {
			const token = tokenise(line);
			return findParam(parseParams(token.body), letter) !== null;
		},

		set(line: string, letter: string, value: number | string, decimals = DEFAULT_DECIMALS): string {
			const token = tokenise(line);
			const text = typeof value === "number" ? formatNumber(value, decimals) : value;
			return withBody(token, setParamInBody(token.body, letter, text));
		},

		scale(line: string, letter: string, factor: number, decimals = DEFAULT_DECIMALS): string {
			return arithmetic(line, letter, (current) => current * factor, decimals);
		},

		offset(line: string, letter: string, delta: number, decimals = DEFAULT_DECIMALS): string {
			return arithmetic(line, letter, (current) => current + delta, decimals);
		},

		remove(line: string, letter: string): string {
			const token = tokenise(line);
			return withBody(token, removeParamFromBody(token.body, letter));
		},

		isMove(line: string): boolean {
			const code = tokenise(line).code?.toUpperCase() ?? "";
			return code === "G0" || code === "G1" || code === "G2" || code === "G3";
		},

		isExtrusion(line: string, relativeE = false): boolean {
			if (!this.isMove(line)) return false;
			const e = this.num(line, "E");
			if (e === null) return false;
			return relativeE ? e !== 0 : true;
		},

		setComment(line: string, comment: string | null): string {
			const token = tokenise(line);
			const body = token.commentIndex === -1 ? line : line.slice(0, token.commentIndex);
			if (comment === null) return body.replace(/\s+$/, "");
			return `${body.replace(/\s+$/, "")} ;${comment}`;
		},

		format(value: number, decimals = DEFAULT_DECIMALS): string {
			return formatNumber(value, decimals);
		},

		command(line: string): string | null {
			return tokenise(line).code?.toUpperCase() ?? null;
		},
	};
}

function arithmetic(line: string, letter: string, fn: (current: number) => number, decimals: number): string {
	const token = tokenise(line);
	const p = findParam(parseParams(token.body), letter);
	if (p === null) return line;
	const current = Number(p.value);
	if (!Number.isFinite(current)) return line;
	const next = fn(current);
	if (!Number.isFinite(next)) return line;
	return withBody(token, token.body.slice(0, p.start + 1) + formatNumber(next, decimals) + token.body.slice(p.end));
}
