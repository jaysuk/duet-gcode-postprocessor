/**
 * G-code line tokeniser.
 *
 * Deliberately allocation-light: a full pass over a 200 MB file tokenises every line, so this
 * returns index spans into the original string rather than a bag of substrings, and parameter
 * parsing is a separate opt-in call that most lines never pay for.
 *
 * Quote handling matters more than it looks: RepRapFirmware string parameters routinely contain
 * semicolons (`M291 P"done; resuming"`), so a naive indexOf(";") splits a comment out of the middle
 * of a perfectly good command and corrupts the file. Quotes are escaped by doubling in RRF (`""`).
 */

export interface Tokenised {
	/** The original line, without its newline. */
	raw: string;
	/** Uppercase command, e.g. "G1", "M104", "T0", "G38.2". Null when the line has no command. */
	code: string | null;
	/** Command letter (G/M/T) or null. */
	letter: string | null;
	/** Numeric part of the command (may be fractional), or null. */
	number: number | null;
	/** Index of the comment-introducing ";" in `raw`, or -1. */
	commentIndex: number;
	/** Comment text without the leading ";", or null when there is no comment. */
	comment: string | null;
	/** The command + parameters section of `raw` (everything before the comment). */
	body: string;
	/** True for a blank line or a line that is only a comment. */
	isCommentOnly: boolean;
}

export interface ParsedParam {
	/** Uppercase parameter letter. */
	letter: string;
	/** Raw value text exactly as it appeared (quotes and braces included). */
	value: string;
	/** Start index of the letter within the line the params were parsed from. */
	start: number;
	/** End index (exclusive) of the value. */
	end: number;
}

const EMPTY_PARAMS: ReadonlyArray<ParsedParam> = Object.freeze([]);

/**
 * Find the index of the comment separator, skipping any ";" inside a quoted string.
 * Returns -1 when the line has no comment.
 */
export function findCommentIndex(raw: string): number {
	let inQuotes = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw.charCodeAt(i);
		if (ch === 34 /* " */) {
			// RRF escapes a literal quote by doubling it; skip the pair and stay in the same state
			if (inQuotes && raw.charCodeAt(i + 1) === 34) {
				i++;
				continue;
			}
			inQuotes = !inQuotes;
		} else if (ch === 59 /* ; */ && !inQuotes) {
			return i;
		}
	}
	return -1;
}

/** Split a line into its command, parameter body and comment. Never throws. */
export function tokenise(raw: string): Tokenised {
	const commentIndex = findCommentIndex(raw);
	const body = commentIndex === -1 ? raw : raw.slice(0, commentIndex);
	const comment = commentIndex === -1 ? null : raw.slice(commentIndex + 1);

	// Skip leading whitespace, then an optional line number (N123) that some senders prepend
	let i = 0;
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && (body[i] === "N" || body[i] === "n")) {
		let j = i + 1;
		while (j < body.length && isDigit(body.charCodeAt(j))) j++;
		if (j > i + 1) {
			i = j;
			while (i < body.length && isSpace(body.charCodeAt(i))) i++;
		}
	}

	const letterChar = i < body.length ? body[i].toUpperCase() : "";
	if (letterChar !== "G" && letterChar !== "M" && letterChar !== "T") {
		return {
			raw, code: null, letter: null, number: null,
			commentIndex, comment, body,
			isCommentOnly: body.trim().length === 0,
		};
	}

	let j = i + 1;
	while (j < body.length && (isDigit(body.charCodeAt(j)) || body[j] === ".")) j++;
	if (j === i + 1) {
		// A bare letter with no number is not a command (e.g. a stray "T" or an expression)
		return {
			raw, code: null, letter: null, number: null,
			commentIndex, comment, body,
			isCommentOnly: body.trim().length === 0,
		};
	}

	const numberText = body.slice(i + 1, j);
	const number = Number(numberText);
	return {
		raw,
		code: letterChar + numberText,
		letter: letterChar,
		number: Number.isFinite(number) ? number : null,
		commentIndex,
		comment,
		body,
		isCommentOnly: false,
	};
}

/**
 * Parse the parameters of a command body (the string returned as `Tokenised.body`).
 *
 * Handles plain values (`X1.5`, `S-40`, `E1e-3`), quoted strings (`P"a b"`, with `""` escapes) and
 * RRF expressions (`S{move.axes[0].max}`), returning index spans so a caller can rewrite one
 * parameter in place without reconstructing (and subtly reformatting) the whole line.
 */
export function parseParams(body: string, startIndex = 0): ReadonlyArray<ParsedParam> {
	let i = startIndex;
	// Skip whitespace, an optional line number, and the command itself
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && (body[i] === "N" || body[i] === "n")) {
		let j = i + 1;
		while (j < body.length && isDigit(body.charCodeAt(j))) j++;
		if (j > i + 1) i = j;
	}
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && isLetter(body.charCodeAt(i))) {
		const c = body[i].toUpperCase();
		if (c === "G" || c === "M" || c === "T") {
			let j = i + 1;
			while (j < body.length && (isDigit(body.charCodeAt(j)) || body[j] === ".")) j++;
			if (j > i + 1) i = j;
		}
	}

	let params: Array<ParsedParam> | null = null;
	while (i < body.length) {
		while (i < body.length && isSpace(body.charCodeAt(i))) i++;
		if (i >= body.length) break;
		if (!isLetter(body.charCodeAt(i))) {
			// Not a parameter (a checksum "*42", a stray token) — stop rather than guess
			break;
		}
		const letter = body[i].toUpperCase();
		const start = i;
		i++;
		const valueStart = i;
		if (body[i] === "\"") {
			i++;
			while (i < body.length) {
				if (body[i] === "\"") {
					if (body[i + 1] === "\"") { i += 2; continue; }
					i++;
					break;
				}
				i++;
			}
		} else if (body[i] === "{") {
			let depth = 0;
			while (i < body.length) {
				if (body[i] === "{") depth++;
				else if (body[i] === "}") { depth--; if (depth === 0) { i++; break; } }
				i++;
			}
		} else {
			while (i < body.length && !isSpace(body.charCodeAt(i))) i++;
		}
		(params ??= []).push({ letter, value: body.slice(valueStart, i), start, end: i });
	}
	return params ?? EMPTY_PARAMS;
}

/** Numeric value of a parameter, or null when absent or non-numeric (a string/expression). */
export function paramNumber(params: ReadonlyArray<ParsedParam>, letter: string): number | null {
	const p = findParam(params, letter);
	if (p === null) return null;
	const n = Number(p.value);
	return Number.isFinite(n) ? n : null;
}

/** First parameter with the given letter, or null. Letter comparison is case-insensitive. */
export function findParam(params: ReadonlyArray<ParsedParam>, letter: string): ParsedParam | null {
	const want = letter.toUpperCase();
	for (const p of params) {
		if (p.letter === want) return p;
	}
	return null;
}

/**
 * Replace (or append) one parameter's value in a command body, leaving the rest of the line —
 * spacing, other parameters, capitalisation — byte-identical.
 */
export function setParam(body: string, letter: string, value: string): string {
	const params = parseParams(body);
	const existing = findParam(params, letter);
	if (existing !== null) {
		return body.slice(0, existing.start + 1) + value + body.slice(existing.end);
	}
	const trimmedEnd = body.replace(/\s+$/, "");
	const trailing = body.slice(trimmedEnd.length);
	return `${trimmedEnd} ${letter.toUpperCase()}${value}${trailing}`;
}

/** Remove a parameter from a command body. Returns the body unchanged when it is not present. */
export function removeParam(body: string, letter: string): string {
	const params = parseParams(body);
	const existing = findParam(params, letter);
	if (existing === null) return body;
	// Swallow one leading space so removing a middle parameter does not leave a double space
	let start = existing.start;
	if (start > 0 && isSpace(body.charCodeAt(start - 1))) start--;
	return body.slice(0, start) + body.slice(existing.end);
}

/**
 * Format a number the way G-code readers expect: fixed decimals, but without the trailing zeros
 * that make a diff noisy (`0.80` -> `0.8`, `5.000` -> `5`).
 */
export function formatNumber(value: number, decimals: number): string {
	if (!Number.isFinite(value)) return "0";
	const fixed = value.toFixed(Math.max(0, Math.min(10, decimals)));
	return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Rebuild a full line from a (possibly rewritten) body, preserving the original comment. */
export function withBody(token: Tokenised, body: string): string {
	return token.commentIndex === -1 ? body : body + ";" + (token.comment ?? "");
}

function isSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 13;
}
function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}
function isLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
