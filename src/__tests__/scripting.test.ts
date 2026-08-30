import { describe, expect, it } from "vitest";

import { parseRules, applyRules } from "../model/steps/rules";
import { compileScript, ScriptAbortError, SHADOWED_GLOBALS } from "../model/steps/script";
import { StepConfigError } from "../model/steps/types";
import { runStep, SAMPLE } from "./helpers";

describe("the rules tier", () => {
	it("parses a rule list", () => {
		const rules = parseRules('[{"when":[],"then":[{"type":"drop"}]}]');
		expect(rules).toHaveLength(1);
	});

	it("rejects malformed rules with a message that says what is wrong", () => {
		expect(() => parseRules("nope")).toThrow(/not valid JSON/i);
		expect(() => parseRules('{"when":[]}')).toThrow(/array/);
		expect(() => parseRules('[{"then":[]}]')).toThrow(/"when"/);
		expect(() => parseRules('[{"when":[],"then":[]}]')).toThrow(/"then"/);
		expect(() => parseRules('[{"when":[{}],"then":[{"type":"drop"}]}]')).toThrow(/"type"/);
	});

	it("scales a parameter under a layer condition", () => {
		const rules = JSON.stringify([{
			when: [{ type: "command", codes: ["G1"] }, { type: "layer", to: 0 }],
			then: [{ type: "scaleParam", letter: "F", factor: 0.5, decimals: 0 }],
		}]);
		const out = runStep("rules", { rules }, SAMPLE);
		expect(out).toContain("G1 X10 Y10 E1 F600"); // layer 0, halved
		expect(out).toContain("G1 X10 Y20 E3 F1800"); // layer 1, untouched
	});

	it("supports insert, comment-out and drop actions", () => {
		const rules = JSON.stringify([
			{ when: [{ type: "matches", pattern: "^M140" }], then: [{ type: "insertBefore", text: "; bed next" }] },
			{ when: [{ type: "matches", pattern: "^M104 S0" }], then: [{ type: "commentOut" }] },
			{ when: [{ type: "matches", pattern: "^M73" }], then: [{ type: "drop" }] },
		]);
		const out = runStep("rules", { rules }, SAMPLE);
		expect(out).toContain("; bed next\nM140 S60");
		expect(out).toContain(";M104 S0");
		expect(out).not.toContain("M73 P0 R10");
	});

	it("stops at a rule marked stop", () => {
		const rules = JSON.stringify([
			{ when: [{ type: "matches", pattern: "G28" }], then: [{ type: "appendComment", text: "first" }], stop: true },
			{ when: [{ type: "matches", pattern: "G28" }], then: [{ type: "appendComment", text: "second" }] },
		]);
		const out = runStep("rules", { rules }, "G28");
		expect(out).toBe("G28 ; home all ; first".replace(" ; home all", ""));
	});

	it("matches on a parameter comparison", () => {
		const rules = JSON.stringify([{
			when: [{ type: "command", codes: ["M104"] }, { type: "param", letter: "S", op: "gt", value: 200 }],
			then: [{ type: "appendComment", text: "hot" }],
		}]);
		const out = runStep("rules", { rules }, "M104 S210\nM104 S180");
		expect(out).toBe("M104 S210 ; hot\nM104 S180");
	});

	it("negates a match", () => {
		const rules = JSON.stringify([{
			when: [{ type: "matches", pattern: "^G", negate: true }],
			then: [{ type: "drop" }],
		}]);
		expect(runStep("rules", { rules }, "G28\nM104 S1")).toBe("G28");
	});

	it("leaves a line untouched when no rule fires", () => {
		const rules = JSON.stringify([{ when: [{ type: "matches", pattern: "ZZZ" }], then: [{ type: "drop" }] }]);
		expect(runStep("rules", { rules }, SAMPLE)).toBe(SAMPLE);
	});
});

describe("the script tier", () => {
	it("compiles and transforms", () => {
		const out = runStep("script", { source: "return line.replace('M104', 'M568');" }, "M104 S210");
		expect(out).toBe("M568 S210");
	});

	it("drops a line by returning null", () => {
		expect(runStep("script", { source: "return line.startsWith('M') ? null : line;" }, "M104\nG28")).toBe("G28");
	});

	it("emits extra lines around the current one", () => {
		const out = runStep("script", { source: "if (line === 'G28') { emitBefore('; before'); emit('; after'); } return line;" }, "G28");
		expect(out).toBe("; before\nG28\n; after");
	});

	it("keeps state across lines", () => {
		const out = runStep("script", {
			source: "state.n = (state.n || 0) + 1; return line + ' ; ' + state.n;",
		}, "A\nB");
		expect(out).toBe("A ; 1\nB ; 2");
	});

	it("reads the machine context", () => {
		const out = runStep("script", {
			source: "return ctx.layerChanged ? line + ' ; layer ' + ctx.layer : line;",
		}, SAMPLE);
		expect(out).toContain(";LAYER_CHANGE ; layer 0");
		expect(out).toContain(";LAYER_CHANGE ; layer 2");
	});

	it("shadows the network globals so a script cannot call out", () => {
		expect(SHADOWED_GLOBALS).toContain("fetch");
		expect(SHADOWED_GLOBALS).toContain("XMLHttpRequest");
		expect(() => runStep("script", { source: "fetch('https://example.com'); return line;" }, "G28"))
			.toThrow(ScriptAbortError);
	});

	it("reports a compile error as a config error, not a crash", () => {
		expect(() => runStep("script", { source: "this is not javascript" }, "G28")).toThrow(StepConfigError);
	});

	it("wraps a runtime error with the line number", () => {
		expect(() => runStep("script", { source: "throw new Error('boom');" }, "G28"))
			.toThrow(/line 1: boom/);
	});

	it("compiles a script that returns nothing without changing the line", () => {
		const fn = compileScript("");
		expect(fn("G28", {} as never, { emit() {}, emitBefore() {}, drop() {}, state: {}, log() {} })).toBeUndefined();
		expect(runStep("script", { source: "" }, "G28")).toBe("G28");
	});
});
