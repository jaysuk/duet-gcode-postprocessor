/**
 * A safe expression evaluator for the rules tier's computed values — `F * 0.8 + 100`,
 * `layer < totalLayers / 2` — without dropping to the JavaScript step for arithmetic this simple.
 *
 * Uses **`expr-eval-fork`, not the original `expr-eval`** package `docs/scripting-engines.md` named:
 * the original carries two unpatched high-severity advisories, both exploitable through the
 * *values* object handed to `evaluate()`, not the expression string —
 * [GHSA-8gw3-rxh4-v6jx](https://github.com/advisories/GHSA-8gw3-rxh4-v6jx) (prototype pollution) and
 * [GHSA-jc85-fpwf-qm7x](https://github.com/advisories/GHSA-jc85-fpwf-qm7x) (unrestricted function
 * values in that object). That matters specifically here: part of the scope this module builds comes
 * from a G-code file's own metadata, and this plugin explicitly processes files that may not be the
 * user's own ("sent by someone else, downloaded from a model site" — README). `expr-eval-fork` fixes
 * both (2.0.2+ and 3.0.1+ respectively; this pins `^3.0.3`), confirmed via `npm audit`: zero
 * vulnerabilities with the fork installed, one high-severity with the original.
 *
 * The scope built below is deliberately **flat** — no dotted `meta.totalLayers`-style member access,
 * even though expr-eval supports it via `allowMemberAccess` — matching `stepCondition.ts`'s own
 * flat-key convention for exactly the same fields, and never handing the parser a nested object,
 * which is where a pollution-style attack would have the most surface even on a patched version.
 */

import { Parser, type Expression } from "expr-eval-fork";
import { parseParams, tokenise } from "./tokenise";
import type { LineContext } from "../steps/types";

const parser = new Parser();

/**
 * `compileExpr` is called once per line for every `expr`/`setParamExpr` rule (`rules.ts`'s
 * `testCondition`/`applyAction`, which have no per-line state of their own to cache a `CompiledExpr`
 * in) — without this, a rule that gates on a computed condition re-parses its expression on every
 * line of the file. Measured: 4.6× slower than an equivalent `param` condition over 20,000 lines
 * (task 14, Finding D). Keyed on the source string, not the `Condition`/`Action` object, since a
 * recipe with several rules sharing the same expression text should only ever compile it once.
 *
 * Only successes are cached: a malformed expression is already rejected once, at `parseRules` time
 * (`rules.ts`), so a bad source string reaching `compileExpr` a second time is not a hot path worth
 * caching the throw for. Bounded rather than unbounded — a real recipe holds a handful of distinct
 * expressions, so the cap only guards against a pathological caller compiling many one-off strings.
 */
const MAX_CACHE_ENTRIES = 256;
const compiledCache = new Map<string, CompiledExpr>();

export interface CompiledExpr {
	/**
	 * Raw result, whatever expr-eval-fork itself produces — a `number` for arithmetic
	 * (`F * 0.8 + 100`) or a `boolean` for a comparison (`F > 1500`, used as a condition). Throws on
	 * a genuine evaluation failure — most commonly a variable the current line does not carry (e.g.
	 * `F` referenced on a line with no F) — which the caller decides how to handle (skip the line,
	 * leave it unchanged) rather than this module inventing a default.
	 */
	evaluate(scope: Readonly<Record<string, number>>): number | boolean;
	/** For a caller that needs a number specifically (writing a G-code parameter) — same failure
	 *  modes as {@link evaluate}, plus throwing if the result is a boolean or otherwise not finite. */
	evaluateNumber(scope: Readonly<Record<string, number>>): number;
}

/** Compiles once (and memoises — see the cache's own doc comment above); throws a message usable
 *  directly as a validation error, not expr-eval's own (parser-internal, sometimes cryptic)
 *  exception text. */
export function compileExpr(source: string): CompiledExpr {
	const cached = compiledCache.get(source);
	if (cached !== undefined) return cached;

	if (source.trim() === "") throw new Error("Expression is empty");
	let expr: Expression;
	try {
		expr = parser.parse(source);
	} catch (e) {
		throw new Error(`"${source}" is not a valid expression: ${(e as Error).message}`);
	}
	function evaluate(scope: Readonly<Record<string, number>>): number | boolean {
		let value: unknown;
		try {
			value = expr.evaluate(scope as Record<string, number>);
		} catch (e) {
			// Most commonly a variable the current line does not carry (expr-eval-fork throws
			// "undefined variable: X" itself).
			throw new Error(`"${source}" could not be evaluated: ${(e as Error).message}`);
		}
		if (typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		throw new Error(`"${source}" did not evaluate to a number or a true/false comparison`);
	}
	const compiled: CompiledExpr = {
		evaluate,
		evaluateNumber(scope) {
			const value = evaluate(scope);
			if (typeof value !== "number") {
				throw new Error(`"${source}" evaluated to true/false, not a number`);
			}
			return value;
		},
	};

	if (compiledCache.size >= MAX_CACHE_ENTRIES) compiledCache.clear();
	compiledCache.set(source, compiled);
	return compiled;
}

/** The same known metadata fields `stepCondition.ts`'s `KNOWN_FIELDS` exposes for conditions,
 *  under the same names — kept in sync deliberately since both read `SlicerMetadata` directly. */
function metaScope(ctx: LineContext): Record<string, number> {
	const scope: Record<string, number> = {};
	if (ctx.meta.totalLayers !== null) scope.totalLayers = ctx.meta.totalLayers;
	if (ctx.meta.layerHeight !== null) scope.layerHeight = ctx.meta.layerHeight;
	if (ctx.meta.filamentMm !== null) scope.filamentMm = ctx.meta.filamentMm;
	if (ctx.meta.printTimeSeconds !== null) scope.printTimeSeconds = ctx.meta.printTimeSeconds;
	return scope;
}

/**
 * The flat scope an expression is evaluated against: this line's own machine state, every numeric
 * parameter the line itself carries (by its own letter — `F`, `X`, `Z`, ...), and the handful of
 * known slicer metadata fields above. Never the raw `meta.values` map, and never anything from a
 * line other than this one.
 */
export function buildExprScope(ctx: LineContext, line: string): Record<string, number> {
	const scope: Record<string, number> = metaScope(ctx);
	scope.layer = ctx.layer;
	scope.tool = ctx.tool;
	if (ctx.z !== null) scope.z = ctx.z;
	if (ctx.feedrate !== null) scope.feedrate = ctx.feedrate;

	// tokenise(), not a naive indexOf(";") — a quoted string parameter can legitimately contain a
	// semicolon (tokenise.ts's own module comment), and splitting on it would parse comment text as
	// parameters
	const body = tokenise(line).body;
	for (const p of parseParams(body)) {
		const n = Number(p.value);
		if (Number.isFinite(n)) scope[p.letter] = n;
	}
	return scope;
}
