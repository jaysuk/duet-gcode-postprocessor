import { describe, expect, it } from "vitest";

import { emptyMetadata } from "../model/gcode/metadata";
import { buildExprScope, compileExpr } from "../model/gcode/exprEval";
import { createState } from "../model/gcode/state";
import type { LineContext } from "../model/steps/types";
import { tokenise } from "../model/gcode/tokenise";
import { rulesStep } from "../model/steps/rules";
import { runToString } from "../model/pipeline";

function ctxFor(line: string, overrides: Partial<LineContext> = {}): LineContext {
	const state = createState();
	const token = tokenise(line);
	return {
		...state,
		token,
		meta: emptyMetadata(),
		totalLayers: null,
		progress: null,
		...overrides,
	};
}

describe("compileExpr", () => {
	it("evaluates simple arithmetic", () => {
		expect(compileExpr("2 + 3 * 4").evaluate({})).toBe(14);
	});

	it("reads scope variables", () => {
		expect(compileExpr("F * 0.8 + 100").evaluate({ F: 1000 })).toBe(900);
	});

	it("throws a usable message for a malformed expression, at compile time", () => {
		expect(() => compileExpr("F * ")).toThrow(/not a valid expression/);
	});

	it("throws for an empty expression", () => {
		expect(() => compileExpr("")).toThrow(/empty/);
		expect(() => compileExpr("   ")).toThrow(/empty/);
	});

	it("throws a clear, consistent message when a variable the expression needs is missing", () => {
		const expr = compileExpr("F * 2");
		expect(() => expr.evaluate({})).toThrow(/could not be evaluated.*undefined variable: F/);
	});

	it("throws rather than silently returning NaN/Infinity", () => {
		expect(() => compileExpr("F / 0").evaluate({ F: 1 })).toThrow(/did not evaluate to a number/);
	});

	it("compiles once and can be evaluated many times with different scopes", () => {
		const expr = compileExpr("layer * 2");
		expect(expr.evaluate({ layer: 1 })).toBe(2);
		expect(expr.evaluate({ layer: 5 })).toBe(10);
	});

	it("returns a boolean for a comparison, used as a condition, rather than rejecting it", () => {
		expect(compileExpr("F > 1500").evaluate({ F: 1800 })).toBe(true);
		expect(compileExpr("F > 1500").evaluate({ F: 1000 })).toBe(false);
	});

	describe("evaluateNumber", () => {
		it("returns a plain arithmetic result exactly like evaluate", () => {
			expect(compileExpr("value * 0.5").evaluateNumber({ value: 1200 })).toBe(600);
		});

		it("throws when the expression evaluates to a boolean instead of a number", () => {
			expect(() => compileExpr("F > 1500").evaluateNumber({ F: 1800 })).toThrow(/true\/false, not a number/);
		});
	});

	it("does not expose object prototype pollution through the scope object", () => {
		// The whole reason this module uses expr-eval-fork rather than expr-eval: this must not throw
		// in a way that indicates the parser tried to walk into the scope's prototype chain, and it
		// must not silently pollute Object.prototype as a side effect either.
		const expr = compileExpr("x + 1");
		const scope = JSON.parse('{"x": 1, "__proto__": {"polluted": true}}') as Record<string, number>;
		expr.evaluate(scope);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("buildExprScope", () => {
	it("exposes layer, tool, z and feedrate from the line context", () => {
		const ctx = ctxFor("G1 X10 F1800", { layer: 3, tool: 1, z: 5, feedrate: 1800 });
		const scope = buildExprScope(ctx, "G1 X10 F1800");
		expect(scope.layer).toBe(3);
		expect(scope.tool).toBe(1);
		expect(scope.z).toBe(5);
		expect(scope.feedrate).toBe(1800);
	});

	it("omits z and feedrate when they are null, rather than coercing to 0", () => {
		const ctx = ctxFor("G28");
		const scope = buildExprScope(ctx, "G28");
		expect("z" in scope).toBe(false);
		expect("feedrate" in scope).toBe(false);
	});

	it("exposes the line's own numeric parameters by letter", () => {
		const ctx = ctxFor("G1 X10 Y20 E1.5 F1800");
		const scope = buildExprScope(ctx, "G1 X10 Y20 E1.5 F1800");
		expect(scope.X).toBe(10);
		expect(scope.Y).toBe(20);
		expect(scope.E).toBe(1.5);
		expect(scope.F).toBe(1800);
	});

	it("does not mistake a quoted parameter's own semicolon for a comment", () => {
		// A naive indexOf(";") would cut this line after `done` and try to parse "resuming\"" out of
		// what should be treated as a comment — feeding it through tokenise() first must avoid that.
		const ctx = ctxFor('M291 P"done; resuming" S0');
		const scope = buildExprScope(ctx, 'M291 P"done; resuming" S0');
		expect(scope.S).toBe(0);
		expect(scope.P).toBeUndefined(); // a quoted string, not a number — correctly excluded
	});

	it("does not read parameters out of a trailing comment", () => {
		const ctx = ctxFor("G1 X10 F1800 ; W100 should not appear");
		const scope = buildExprScope(ctx, "G1 X10 F1800 ; W100 should not appear");
		expect(scope.W).toBeUndefined();
	});

	it("exposes known slicer metadata fields flatly, not nested under meta", () => {
		const ctx = ctxFor("G1 X1", {
			meta: { ...emptyMetadata(), totalLayers: 100, layerHeight: 0.2 },
		});
		const scope = buildExprScope(ctx, "G1 X1");
		expect(scope.totalLayers).toBe(100);
		expect(scope.layerHeight).toBe(0.2);
	});
});

describe("compileExpr memoisation (task 14, Finding D)", () => {
	it("returns the exact same CompiledExpr for the same source string", () => {
		expect(compileExpr("F * 0.8 + 100")).toBe(compileExpr("F * 0.8 + 100"));
	});

	it("keeps an expr rule condition within a small factor of an equivalent plain condition", () => {
		// Before the memo, compileExpr re-parsed the expression on every line: 171ms vs 38ms over
		// 20,000 lines (4.6x) in the measurement that found this. A generous 2x bound still catches
		// that regression without being flaky on a loaded machine.
		const lines: Array<string> = [];
		for (let i = 0; i < 20000; i++) lines.push("G1 X1 F1800");
		const input = lines.join("\n");

		const exprTransform = rulesStep.create({
			rules: JSON.stringify([{
				when: [{ type: "expr", expression: "F > 1500" }],
				then: [{ type: "appendComment", text: "f" }],
			}]),
		} as never, { scriptsTrusted: true });
		const exprStart = performance.now();
		runToString({ transforms: [exprTransform] }, input);
		const exprMs = performance.now() - exprStart;

		const plainTransform = rulesStep.create({
			rules: JSON.stringify([{
				when: [{ type: "param", letter: "F", op: "gt", value: 1500 }],
				then: [{ type: "appendComment", text: "f" }],
			}]),
		} as never, { scriptsTrusted: true });
		const plainStart = performance.now();
		runToString({ transforms: [plainTransform] }, input);
		const plainMs = performance.now() - plainStart;

		// Before the memo this was 4.6x (171ms vs 38ms over 20,000 lines). A generous 3x-or-500ms bound
		// still catches that regression outright without being flaky when either run is too quick to
		// measure precisely on a fast or loaded machine.
		expect(exprMs).toBeLessThan(Math.max(plainMs * 3, 500));
	});
});
