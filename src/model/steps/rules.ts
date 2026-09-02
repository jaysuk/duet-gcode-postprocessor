/**
 * The no-eval scripting tier: a declarative when/then rule list.
 *
 * This exists because most "post-processing scripts" are not really programs — they are a handful
 * of conditional rewrites. Expressed as data they are serialisable, diffable, shareable, immune to
 * any Content-Security-Policy, and every one of them is a unit test. The JavaScript step
 * (`script.ts`) is the escape hatch for the rest, not the default.
 *
 * Rules are written as JSON so there is no bespoke grammar to learn, get wrong, or version:
 *
 * ```json
 * [
 *   {
 *     "name": "Slow the first two layers",
 *     "when": [{ "type": "command", "codes": ["G1"] }, { "type": "layer", "to": 1 }],
 *     "then": [{ "type": "scaleParam", "letter": "F", "factor": 0.5 }]
 *   }
 * ]
 * ```
 */

import { formatNumber, parseParams, removeParam, setParam, tokenise, withBody } from "../gcode/tokenise";
import { buildExprScope, compileExpr } from "../gcode/exprEval";
import {
	buildMatcher, expandPlaceholders, StepConfigError,
	type LineContext, type StepDefinition, type Transform,
} from "./types";

export type Condition =
	| { type: "matches"; pattern: string; regex?: boolean; caseSensitive?: boolean; negate?: boolean }
	| { type: "command"; codes: Array<string> }
	| { type: "layer"; from?: number; to?: number }
	| { type: "tool"; tool: number }
	| { type: "z"; from?: number; to?: number }
	| { type: "param"; letter: string; op?: "present" | "absent" | "gt" | "lt" | "eq"; value?: number }
	| { type: "comment" }
	| { type: "object"; name: string }
	| { type: "feature"; name: string }
	| { type: "expr"; expression: string };

export type Action =
	| { type: "replace"; pattern: string; replacement: string; regex?: boolean; caseSensitive?: boolean; all?: boolean }
	| { type: "replaceLine"; text: string }
	| { type: "setParam"; letter: string; value: number; decimals?: number }
	| { type: "scaleParam"; letter: string; factor: number; decimals?: number }
	| { type: "offsetParam"; letter: string; delta: number; decimals?: number }
	| { type: "setParamExpr"; letter: string; expression: string; decimals?: number }
	| { type: "removeParam"; letter: string }
	| { type: "insertBefore"; text: string }
	| { type: "insertAfter"; text: string }
	| { type: "appendComment"; text: string }
	| { type: "commentOut" }
	| { type: "drop" };

export interface Rule {
	name?: string;
	when: Array<Condition>;
	then: Array<Action>;
	/** Stop evaluating later rules for this line once this one fires. Default: false. */
	stop?: boolean;
}

export interface RulesConfig {
	rules: string;
}

/** Parse and validate the JSON rule list. Throws {@link StepConfigError} with a usable message. */
export function parseRules(json: string): Array<Rule> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (e) {
		throw new StepConfigError(`Rules are not valid JSON: ${(e as Error).message}`);
	}
	if (!Array.isArray(parsed)) throw new StepConfigError("Rules must be a JSON array of rule objects");

	return parsed.map((raw, index) => {
		const rule = raw as Partial<Rule>;
		if (typeof rule !== "object" || rule === null) throw new StepConfigError(`Rule ${index + 1} is not an object`);
		if (!Array.isArray(rule.when)) throw new StepConfigError(`Rule ${index + 1} has no "when" array`);
		if (!Array.isArray(rule.then) || rule.then.length === 0) {
			throw new StepConfigError(`Rule ${index + 1} has no "then" actions`);
		}
		for (const cond of rule.when) {
			if (typeof (cond as Condition).type !== "string") throw new StepConfigError(`Rule ${index + 1} has a condition with no "type"`);
			if ((cond as Condition).type === "expr") {
				try {
					compileExpr((cond as Extract<Condition, { type: "expr" }>).expression);
				} catch (e) {
					throw new StepConfigError(`Rule ${index + 1}: ${(e as Error).message}`);
				}
			}
		}
		for (const action of rule.then) {
			if (typeof (action as Action).type !== "string") throw new StepConfigError(`Rule ${index + 1} has an action with no "type"`);
			if ((action as Action).type === "setParamExpr") {
				try {
					compileExpr((action as Extract<Action, { type: "setParamExpr" }>).expression);
				} catch (e) {
					throw new StepConfigError(`Rule ${index + 1}: ${(e as Error).message}`);
				}
			}
		}
		return rule as Rule;
	});
}

/** Evaluate one condition against a line. Pure — the whole point of this tier. */
export function testCondition(cond: Condition, ctx: LineContext, line: string): boolean {
	switch (cond.type) {
		case "matches": {
			const re = buildMatcher({
				pattern: cond.pattern,
				regex: cond.regex !== false,
				caseSensitive: cond.caseSensitive !== false,
			});
			const hit = re.test(line);
			return cond.negate === true ? !hit : hit;
		}
		case "command": {
			const token = tokenise(line);
			if (token.code === null) return false;
			const code = token.code.toUpperCase();
			return cond.codes.some((c) => c.trim().toUpperCase() === code);
		}
		case "layer": {
			if (cond.from !== undefined && ctx.layer < cond.from) return false;
			if (cond.to !== undefined && ctx.layer > cond.to) return false;
			return true;
		}
		case "tool":
			return ctx.tool === cond.tool;
		case "z": {
			if (ctx.z === null) return false;
			if (cond.from !== undefined && ctx.z < cond.from) return false;
			if (cond.to !== undefined && ctx.z > cond.to) return false;
			return true;
		}
		case "param": {
			const token = tokenise(line);
			const params = parseParams(token.body);
			const found = params.find((p) => p.letter === cond.letter.toUpperCase()) ?? null;
			const op = cond.op ?? "present";
			if (op === "absent") return found === null;
			if (found === null) return false;
			if (op === "present") return true;
			const value = Number(found.value);
			if (!Number.isFinite(value) || cond.value === undefined) return false;
			if (op === "gt") return value > cond.value;
			if (op === "lt") return value < cond.value;
			return value === cond.value;
		}
		case "comment":
			return tokenise(line).isCommentOnly;
		case "object":
			return ctx.object === cond.name;
		case "feature":
			return (ctx.featureType ?? "").toLowerCase() === cond.name.toLowerCase();
		case "expr": {
			// A line that cannot supply every variable the expression needs (most commonly a
			// parameter this specific line does not carry) fails the condition rather than aborting
			// the run — the same graceful-miss behaviour "param"/"z" above already have for a line
			// that cannot be evaluated at all.
			try {
				const result = compileExpr(cond.expression).evaluate(buildExprScope(ctx, line));
				return typeof result === "boolean" ? result : result !== 0;
			} catch {
				return false;
			}
		}
	}
	return false;
}

interface ActionState {
	line: string | null;
	before: Array<string>;
	after: Array<string>;
}

/** Apply one action to the working state. Pure. */
export function applyAction(action: Action, state: ActionState, ctx: LineContext): void {
	if (state.line === null && action.type !== "insertBefore" && action.type !== "insertAfter") return;
	const line = state.line as string;

	switch (action.type) {
		case "replace": {
			const re = buildMatcher({
				pattern: action.pattern,
				regex: action.regex !== false,
				caseSensitive: action.caseSensitive !== false,
				all: action.all !== false,
			});
			state.line = line.replace(re, action.replacement);
			break;
		}
		case "replaceLine":
			state.line = expandPlaceholders(action.text, ctx);
			break;
		case "setParam":
		case "scaleParam":
		case "offsetParam": {
			const token = tokenise(line);
			const params = parseParams(token.body);
			const letter = action.letter.toUpperCase();
			const found = params.find((p) => p.letter === letter) ?? null;
			const decimals = action.decimals ?? 3;
			if (action.type === "setParam") {
				state.line = withBody(token, setParam(token.body, letter, formatNumber(action.value, decimals)));
				break;
			}
			if (found === null) break;
			const current = Number(found.value);
			if (!Number.isFinite(current)) break;
			const next = action.type === "scaleParam" ? current * action.factor : current + action.delta;
			state.line = withBody(
				token,
				token.body.slice(0, found.start + 1) + formatNumber(next, decimals) + token.body.slice(found.end),
			);
			break;
		}
		case "setParamExpr": {
			// Evaluated with the line's own current value of this parameter additionally exposed as
			// `value` in scope, mirroring scaleParam/offsetParam's own `current` — a line that cannot
			// supply every variable the expression needs is left unchanged, the same graceful-miss
			// behaviour scaleParam/offsetParam already have when their own target parameter is absent.
			const token = tokenise(line);
			const letter = action.letter.toUpperCase();
			const found = parseParams(token.body).find((p) => p.letter === letter) ?? null;
			const scope = buildExprScope(ctx, line);
			const current = found === null ? null : Number(found.value);
			if (current !== null && Number.isFinite(current)) scope.value = current;
			try {
				const next = compileExpr(action.expression).evaluateNumber(scope);
				state.line = withBody(token, setParam(token.body, letter, formatNumber(next, action.decimals ?? 3)));
			} catch {
				// leave state.line unchanged
			}
			break;
		}
		case "removeParam": {
			const token = tokenise(line);
			state.line = withBody(token, removeParam(token.body, action.letter.toUpperCase()));
			break;
		}
		case "insertBefore":
			state.before.push(...expandPlaceholders(action.text, ctx).split("\n"));
			break;
		case "insertAfter":
			state.after.push(...expandPlaceholders(action.text, ctx).split("\n"));
			break;
		case "appendComment":
			state.line = `${line} ; ${expandPlaceholders(action.text, ctx)}`;
			break;
		case "commentOut":
			state.line = `;${line}`;
			break;
		case "drop":
			state.line = null;
			break;
	}
}

/** Run a whole rule list against one line. Exported for direct testing. */
export function applyRules(rules: Array<Rule>, ctx: LineContext, line: string): string | Array<string> | null | undefined {
	let state: ActionState | null = null;
	for (const rule of rules) {
		const current = state?.line ?? line;
		if (state !== null && state.line === null && rule.when.length > 0) {
			// The line has been dropped; only insertions can still apply, and only from a rule
			// whose conditions do not depend on the line text
			if (rule.when.some((c) => c.type === "matches" || c.type === "command" || c.type === "param")) continue;
		}
		if (!rule.when.every((cond) => testCondition(cond, ctx, current))) continue;
		state ??= { line, before: [], after: [] };
		for (const action of rule.then) applyAction(action, state, ctx);
		if (rule.stop === true) break;
	}

	if (state === null) return undefined;
	const out: Array<string> = [...state.before];
	if (state.line !== null) out.push(state.line);
	out.push(...state.after);
	if (out.length === 0) return null;
	if (out.length === 1 && out[0] === line) return undefined;
	return out.length === 1 ? out[0] : out;
}

const EXAMPLE_RULES = `[
  {
    "name": "Slow the first two layers by half",
    "when": [
      { "type": "command", "codes": ["G1"] },
      { "type": "layer", "to": 1 }
    ],
    "then": [
      { "type": "scaleParam", "letter": "F", "factor": 0.5 }
    ]
  }
]`;

export const rulesStep: StepDefinition<RulesConfig> = {
	id: "rules",
	label: "Rules (no scripting)",
	description: "A when/then rule list in JSON — conditional rewrites without running any code.",
	tip: "Covers most of what a post-processing script actually does, expressed as data instead of "
		+ "code — diffable, shareable, immune to any Content-Security-Policy, and every one of them "
		+ "is a unit test. Rules are evaluated in order against each line; every rule whose "
		+ "conditions all hold applies (not just the first match) unless it sets \"stop\": true. A "
		+ "line dropped by an earlier rule's \"drop\" action can still receive insertions from a "
		+ "later rule, but not a rewrite, since there is no line left to rewrite. The \"expr\" "
		+ "condition and \"setParamExpr\" action cover computed values (\"F * 0.8 + 100\") with a "
		+ "safe expression evaluator, not real code, so they keep a rule diffable and unable to do "
		+ "anything beyond arithmetic on the current line. Reach for the JavaScript step instead only "
		+ "when a rule genuinely cannot express what you need — most \"scripts\" people reach for "
		+ "turn out to be exactly this shape.",
	docsAnchor: "rules--scripting-without-code",
	icon: "mdi-format-list-checks",
	fields: [
		{
			key: "rules", label: "Rules (JSON)", type: "textarea", required: true, default: EXAMPLE_RULES,
			help: "An array of { when: [conditions], then: [actions], stop?: boolean }. All conditions "
				+ "in a rule must hold. Conditions: matches (pattern, regex, caseSensitive, negate), "
				+ "command (codes), layer (from, to), tool, z (from, to), param (letter, "
				+ "op: present/absent/gt/lt/eq, value), comment, object (name), feature (name, from "
				+ "the slicer's ;TYPE: comment), expr (expression — a computed condition, e.g. "
				+ "\"layer < totalLayers / 2\", true when the result is non-zero). Actions: replace "
				+ "(pattern, replacement), replaceLine (text), setParam/scaleParam/offsetParam (letter, "
				+ "value/factor/delta, decimals), setParamExpr (letter, expression, decimals — the "
				+ "parameter's own current value is available as \"value\" in the expression, e.g. "
				+ "\"value * 0.8 + 100\"), removeParam (letter), insertBefore/insertAfter (text), "
				+ "appendComment (text), commentOut, drop. Expressions see the current line's own "
				+ "parameters (F, X, Y, Z, E, ...), layer, tool, z, feedrate, and totalLayers/"
				+ "layerHeight/filamentMm/printTimeSeconds when the slicer states them — a variable "
				+ "the current line does not have makes that condition false / leaves that action's "
				+ "line unchanged, rather than failing the whole run. See docs/usage.md for a worked "
				+ "example of each.",
		},
	],

	create(config): Transform {
		const rules = parseRules(config.rules);
		return {
			id: "rules",
			onLine(ctx: LineContext, line: string) {
				return applyRules(rules, ctx, line);
			},
		};
	},

	validate(config) {
		try {
			const rules = parseRules(config.rules);
			return rules.length === 0 ? ["No rules defined"] : [];
		} catch (e) {
			return [(e as Error).message];
		}
	},
};
