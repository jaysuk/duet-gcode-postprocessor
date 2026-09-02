/**
 * The sandboxed engine's standard library — a hand-ported, plain-JS (no TypeScript syntax, since it
 * is evaluated *inside* a QuickJS context, not compiled by this project's own TypeScript toolchain)
 * copy of `../../gcode/tokenise.ts` + `../scriptApi.ts`'s pure logic, plus the `runLine`/`setMeta`
 * entry points the sandboxed engine calls.
 *
 * **Why a second copy exists at all.** The host engine's `tokenise.ts`/`scriptApi.ts` cannot run
 * inside the VM directly — nothing crosses the QuickJS boundary except plain data (strings, numbers,
 * JSON-shaped values), so a real `import` is not an option, and this whole codebase builds as a
 * single IIFE with no dynamic `import()` regardless. The user's own decision (full API parity for the
 * sandboxed engine from day one, not a reduced first version) accepted this duplication's maintenance
 * cost; `quickjsStdlibParity.test.ts` is the safety net — it runs the same battery of real G-code
 * lines through both copies inside a real QuickJS context and fails loudly on any divergence.
 *
 * **Isolation is real here**, unlike the fast engine's `SHADOWED_GLOBALS` guardrail: QuickJS is a
 * standalone JS engine with no network, DOM, or filesystem globals to begin with, so there is nothing
 * to shadow — `fetch`/`XMLHttpRequest`/`localStorage`/etc. simply do not exist inside this VM.
 *
 * **One VM call per line, not per chunk** (task 14, Findings A and B — an earlier chunked design
 * bypassed downstream pipeline steps for the tail of the file, handed buffered lines the wrong
 * `LineContext`, corrupted the dry-run diff, and re-serialised the whole slicer metadata block on
 * every single line). `setMeta` hoists that metadata into the VM exactly once per run; `runLine`
 * reattaches it to each line's own small context rather than expecting it in the marshalled payload.
 *
 * Written in a conservative ES5-with-let/const/template-literals subset deliberately: this string is
 * never type-checked or linted, so a syntax slip here would only surface as a runtime `evalCode`
 * failure inside the VM — the parity test is what actually exercises it.
 */

export const VM_STDLIB_SOURCE = `
"use strict";

// #region tokenise.ts port

function isSpace(code) { return code === 32 || code === 9 || code === 13; }
function isDigit(code) { return code >= 48 && code <= 57; }
function isLetter(code) { return (code >= 65 && code <= 90) || (code >= 97 && code <= 122); }

function findCommentIndex(raw) {
	var inQuotes = false;
	for (var i = 0; i < raw.length; i++) {
		var ch = raw.charCodeAt(i);
		if (ch === 34) {
			if (inQuotes && raw.charCodeAt(i + 1) === 34) { i++; continue; }
			inQuotes = !inQuotes;
		} else if (ch === 59 && !inQuotes) {
			return i;
		}
	}
	return -1;
}

function tokenise(raw) {
	var commentIndex = findCommentIndex(raw);
	var body = commentIndex === -1 ? raw : raw.slice(0, commentIndex);
	var comment = commentIndex === -1 ? null : raw.slice(commentIndex + 1);

	var i = 0;
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && (body[i] === "N" || body[i] === "n")) {
		var j0 = i + 1;
		while (j0 < body.length && isDigit(body.charCodeAt(j0))) j0++;
		if (j0 > i + 1) {
			i = j0;
			while (i < body.length && isSpace(body.charCodeAt(i))) i++;
		}
	}

	var letterChar = i < body.length ? body[i].toUpperCase() : "";
	if (letterChar !== "G" && letterChar !== "M" && letterChar !== "T") {
		return {
			raw: raw, code: null, letter: null, number: null,
			commentIndex: commentIndex, comment: comment, body: body,
			isCommentOnly: body.trim().length === 0,
		};
	}

	var j = i + 1;
	while (j < body.length && (isDigit(body.charCodeAt(j)) || body[j] === ".")) j++;
	if (j === i + 1) {
		return {
			raw: raw, code: null, letter: null, number: null,
			commentIndex: commentIndex, comment: comment, body: body,
			isCommentOnly: body.trim().length === 0,
		};
	}

	var numberText = body.slice(i + 1, j);
	var number = Number(numberText);
	return {
		raw: raw,
		code: letterChar + numberText,
		letter: letterChar,
		number: Number.isFinite(number) ? number : null,
		commentIndex: commentIndex,
		comment: comment,
		body: body,
		isCommentOnly: false,
	};
}

function parseParams(body, startIndex) {
	var i = startIndex || 0;
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && (body[i] === "N" || body[i] === "n")) {
		var j0 = i + 1;
		while (j0 < body.length && isDigit(body.charCodeAt(j0))) j0++;
		if (j0 > i + 1) i = j0;
	}
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && isLetter(body.charCodeAt(i))) {
		var c = body[i].toUpperCase();
		if (c === "G" || c === "M" || c === "T") {
			var j1 = i + 1;
			while (j1 < body.length && (isDigit(body.charCodeAt(j1)) || body[j1] === ".")) j1++;
			if (j1 > i + 1) i = j1;
		}
	}

	var params = [];
	while (i < body.length) {
		while (i < body.length && isSpace(body.charCodeAt(i))) i++;
		if (i >= body.length) break;
		if (!isLetter(body.charCodeAt(i))) break;
		var letter = body[i].toUpperCase();
		var start = i;
		i++;
		var valueStart = i;
		if (body[i] === "\\"") {
			i++;
			while (i < body.length) {
				if (body[i] === "\\"") {
					if (body[i + 1] === "\\"") { i += 2; continue; }
					i++;
					break;
				}
				i++;
			}
		} else if (body[i] === "{") {
			var depth = 0;
			while (i < body.length) {
				if (body[i] === "{") depth++;
				else if (body[i] === "}") { depth--; if (depth === 0) { i++; break; } }
				i++;
			}
		} else {
			while (i < body.length && !isSpace(body.charCodeAt(i))) i++;
		}
		params.push({ letter: letter, value: body.slice(valueStart, i), start: start, end: i });
	}
	return params;
}

function findParam(params, letter) {
	var want = letter.toUpperCase();
	for (var i = 0; i < params.length; i++) {
		if (params[i].letter === want) return params[i];
	}
	return null;
}

function setParamInBody(body, letter, value) {
	var params = parseParams(body, 0);
	var existing = findParam(params, letter);
	if (existing !== null) {
		return body.slice(0, existing.start + 1) + value + body.slice(existing.end);
	}
	var trimmedEnd = body.replace(/\\s+$/, "");
	var trailing = body.slice(trimmedEnd.length);
	return trimmedEnd + " " + letter.toUpperCase() + value + trailing;
}

function removeParamFromBody(body, letter) {
	var params = parseParams(body, 0);
	var existing = findParam(params, letter);
	if (existing === null) return body;
	var start = existing.start;
	if (start > 0 && isSpace(body.charCodeAt(start - 1))) start--;
	return body.slice(0, start) + body.slice(existing.end);
}

function formatNumber(value, decimals) {
	if (!Number.isFinite(value)) return "0";
	var d = Math.max(0, Math.min(10, decimals));
	var fixed = value.toFixed(d);
	return fixed.indexOf(".") !== -1 ? fixed.replace(/\\.?0+$/, "") : fixed;
}

function withBody(token, body) {
	return token.commentIndex === -1 ? body : body + ";" + (token.comment === null ? "" : token.comment);
}

// #endregion

// #region scriptApi.ts port

var DEFAULT_DECIMALS = 3;

function gcodeArithmetic(line, letter, fn, decimals) {
	var token = tokenise(line);
	var p = findParam(parseParams(token.body, 0), letter);
	if (p === null) return line;
	var current = Number(p.value);
	if (!Number.isFinite(current)) return line;
	var next = fn(current);
	if (!Number.isFinite(next)) return line;
	return withBody(token, token.body.slice(0, p.start + 1) + formatNumber(next, decimals) + token.body.slice(p.end));
}

var gcode = {
	parse: function (line) {
		var token = tokenise(line);
		var params = {};
		if (token.code !== null) {
			var parsed = parseParams(token.body, 0);
			for (var i = 0; i < parsed.length; i++) {
				if (!(parsed[i].letter in params)) params[parsed[i].letter] = parsed[i].value;
			}
		}
		return { code: token.code, params: params, comment: token.comment, isComment: token.isCommentOnly };
	},
	num: function (line, letter) {
		var token = tokenise(line);
		var p = findParam(parseParams(token.body, 0), letter);
		if (p === null) return null;
		var n = Number(p.value);
		return Number.isFinite(n) ? n : null;
	},
	str: function (line, letter) {
		var token = tokenise(line);
		var p = findParam(parseParams(token.body, 0), letter);
		return p === null ? null : p.value;
	},
	has: function (line, letter) {
		var token = tokenise(line);
		return findParam(parseParams(token.body, 0), letter) !== null;
	},
	set: function (line, letter, value, decimals) {
		var d = decimals === undefined ? DEFAULT_DECIMALS : decimals;
		var token = tokenise(line);
		var text = typeof value === "number" ? formatNumber(value, d) : value;
		return withBody(token, setParamInBody(token.body, letter, text));
	},
	scale: function (line, letter, factor, decimals) {
		var d = decimals === undefined ? DEFAULT_DECIMALS : decimals;
		return gcodeArithmetic(line, letter, function (current) { return current * factor; }, d);
	},
	offset: function (line, letter, delta, decimals) {
		var d = decimals === undefined ? DEFAULT_DECIMALS : decimals;
		return gcodeArithmetic(line, letter, function (current) { return current + delta; }, d);
	},
	remove: function (line, letter) {
		var token = tokenise(line);
		return withBody(token, removeParamFromBody(token.body, letter));
	},
	isMove: function (line) {
		var code = tokenise(line).code;
		code = code === null ? "" : code.toUpperCase();
		return code === "G0" || code === "G1" || code === "G2" || code === "G3";
	},
	isExtrusion: function (line, relativeE) {
		if (!this.isMove(line)) return false;
		var e = this.num(line, "E");
		if (e === null) return false;
		return relativeE ? e !== 0 : true;
	},
	setComment: function (line, comment) {
		var token = tokenise(line);
		var body = token.commentIndex === -1 ? line : line.slice(0, token.commentIndex);
		if (comment === null) return body.replace(/\\s+$/, "");
		return body.replace(/\\s+$/, "") + " ;" + comment;
	},
	format: function (value, decimals) {
		return formatNumber(value, decimals === undefined ? DEFAULT_DECIMALS : decimals);
	},
	command: function (line) {
		var code = tokenise(line).code;
		return code === null ? null : code.toUpperCase();
	},
};

// #endregion

// #region runLine entry point

var state = {};
var __logs = [];
var __logCursor = 0;

// Well-formed even before setMeta() is ever called, so ctx.meta.values reads as an object (never
// undefined) from a script's very first line — a run whose recipe happens to have no metadata-aware
// step never calls setMeta at all, and that must not change what a script sees on ctx.meta's shape.
var __meta = {
	slicer: "unknown", slicerVersion: null, totalLayers: null, layerHeight: null,
	filamentMm: null, printTimeSeconds: null, filamentDiameterMm: null,
	maxVolumetricSpeedMm3PerSec: null, values: {},
};

function setMeta(metaJson) {
	__meta = JSON.parse(metaJson);
}

function drainLogs() {
	var out = __logs.slice(__logCursor);
	__logCursor = __logs.length;
	return out;
}

function runLine(inputJson) {
	var item = JSON.parse(inputJson);
	var ctx = item.ctx;
	ctx.meta = __meta;

	var before = [];
	var after = [];
	var dropped = false;
	var api = {
		emit: function (t) {
			var parts = String(t).split("\\n");
			for (var p = 0; p < parts.length; p++) after.push(parts[p]);
		},
		emitBefore: function (t) {
			var parts = String(t).split("\\n");
			for (var p = 0; p < parts.length; p++) before.push(parts[p]);
		},
		drop: function () { dropped = true; },
		state: state,
		log: function (m) { if (__logs.length < 200) __logs.push(String(m)); },
		gcode: gcode,
	};

	var result;
	try {
		result = __userTransform(item.line, ctx, api);
	} catch (e) {
		throw new Error("Script failed on line " + ctx.lineNo + ": " + (e && e.message !== undefined ? e.message : String(e)));
	}

	var replaced = dropped ? null : (typeof result === "string" ? result : (result === null ? null : item.line));
	return JSON.stringify({ line: replaced, before: before, after: after, logs: drainLogs() });
}

// #endregion
`;
