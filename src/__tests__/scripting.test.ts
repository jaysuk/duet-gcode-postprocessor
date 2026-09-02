import { describe, expect, it } from "vitest";

import { parseMetadata } from "../model/gcode/metadata";
import { parseRules, applyRules } from "../model/steps/rules";
import { compileScript, ScriptAbortError, SHADOWED_GLOBALS } from "../model/steps/script";
import { createGcodeApi } from "../model/steps/scriptApi";
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

	describe("expr condition and setParamExpr action", () => {
		it("gates on a computed condition", () => {
			const rules = JSON.stringify([{
				when: [{ type: "command", codes: ["G1"] }, { type: "expr", expression: "F > 1500" }],
				then: [{ type: "appendComment", text: "fast" }],
			}]);
			const out = runStep("rules", { rules }, SAMPLE);
			expect(out).toContain("G1 X10 Y10 E1 F1200"); // untouched, F not > 1500
			expect(out).toContain("G1 X20 Y10 E2 F1800 ; fast");
		});

		it("sets a parameter to a computed value, with the parameter's own current value available as \"value\"", () => {
			const rules = JSON.stringify([{
				when: [{ type: "command", codes: ["G1"] }],
				then: [{ type: "setParamExpr", letter: "F", expression: "value * 0.5", decimals: 0 }],
			}]);
			const out = runStep("rules", { rules }, "G1 X1 F1200\nG1 X2 F1800");
			expect(out).toBe("G1 X1 F600\nG1 X2 F900");
		});

		it("rejects a malformed expression at parse time, in both the condition and the action", () => {
			expect(() => parseRules('[{"when":[{"type":"expr","expression":"F *"}],"then":[{"type":"drop"}]}]'))
				.toThrow(/not a valid expression/);
			expect(() => parseRules('[{"when":[],"then":[{"type":"setParamExpr","letter":"F","expression":"F *"}]}]'))
				.toThrow(/not a valid expression/);
		});

		it("treats a line missing a variable the expression needs as a non-match, not an error", () => {
			// G28 has no F parameter at all — the condition must fail gracefully for that line
			// without throwing, while a line that does carry F still matches normally
			const rules = JSON.stringify([{
				when: [{ type: "expr", expression: "F > 0" }],
				then: [{ type: "appendComment", text: "has feedrate" }],
			}]);
			const out = runStep("rules", { rules }, "G28\nG1 X1 F1200");
			expect(out).toBe("G28\nG1 X1 F1200 ; has feedrate");
		});

		it("leaves the line unchanged when setParamExpr's expression cannot be evaluated", () => {
			const rules = JSON.stringify([{
				when: [{ type: "command", codes: ["G1"] }],
				then: [{ type: "setParamExpr", letter: "F", expression: "nonsense_var * 2" }],
			}]);
			const out = runStep("rules", { rules }, "G1 X1 F1200");
			expect(out).toBe("G1 X1 F1200");
		});

		it("exposes known slicer metadata fields (e.g. totalLayers) flatly in expr scope", () => {
			const meta = parseMetadata(SAMPLE);
			expect(meta.totalLayers).toBe(3);
			const rules = JSON.stringify([{
				when: [{ type: "expr", expression: "layer < totalLayers - 1" }],
				then: [{ type: "appendComment", text: "not last layer" }],
			}]);
			const out = runStep("rules", { rules }, "G1 X1 F1200", meta);
			expect(out).toContain("not last layer");
		});

		it("expands a {meta.*} placeholder in appendComment too, not just insertAt", () => {
			const meta = parseMetadata(SAMPLE);
			const rules = JSON.stringify([{
				when: [{ type: "matches", pattern: "G28" }],
				then: [{ type: "appendComment", text: "of {meta.totalLayers}" }],
			}]);
			const out = runStep("rules", { rules }, "G28", meta);
			expect(out).toBe("G28 ; of 3");
		});
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

	it("hands scripts the G-code helpers rather than making them write regexes", () => {
		const out = runStep("script", {
			source: "return gcode.isExtrusion(line) ? gcode.scale(line, 'F', 0.5, 0) : line;",
		}, ["G1 X10 E1 F1200", "G1 X20 F9000"].join("\n"));
		expect(out).toBe(["G1 X10 E1 F600", "G1 X20 F9000"].join("\n"));
	});

	it("compiles a script that returns nothing without changing the line", () => {
		const fn = compileScript("");
		const api = { emit() {}, emitBefore() {}, drop() {}, state: {}, log() {}, gcode: createGcodeApi() };
		expect(fn("G28", {} as never, api)).toBeUndefined();
		expect(runStep("script", { source: "" }, "G28")).toBe("G28");
	});
});

describe("the script standard library", () => {
	const g = createGcodeApi();

	it("parses a line into code, parameters and comment", () => {
		expect(g.parse("G1 X10 Y20 E1.5 ; travel")).toEqual({
			code: "G1",
			params: { X: "10", Y: "20", E: "1.5" },
			comment: " travel",
			isComment: false,
		});
	});

	it("does not mistake a semicolon inside a string for a comment", () => {
		expect(g.parse('M291 P"done; go" S0').comment).toBeNull();
	});

	it("reads numeric and raw parameter values", () => {
		expect(g.num("G1 F1200", "F")).toBe(1200);
		expect(g.num("G1 F{var.speed}", "F")).toBeNull();
		expect(g.str("M98 P\"0:/macros/a.g\"", "P")).toBe('"0:/macros/a.g"');
		expect(g.has("G1 X1", "Y")).toBe(false);
	});

	it("sets, scales, offsets and removes parameters in place", () => {
		expect(g.set("G1 X10  Y20", "Y", 99, 0)).toBe("G1 X10  Y99");
		expect(g.set("G1 X10", "F", 1200, 0)).toBe("G1 X10 F1200");
		expect(g.scale("G1 F1200 ; go", "F", 0.5, 0)).toBe("G1 F600 ; go");
		expect(g.offset("G1 Z0.2", "Z", 0.02, 3)).toBe("G1 Z0.22");
		expect(g.remove("G1 X10 Y20", "Y")).toBe("G1 X10");
	});

	it("leaves a line alone when the parameter is absent or not a number", () => {
		expect(g.scale("G1 X10", "F", 0.5)).toBe("G1 X10");
		expect(g.scale("G1 F{speed}", "F", 0.5)).toBe("G1 F{speed}");
	});

	it("identifies moves and extrusion", () => {
		expect(g.isMove("G1 X1")).toBe(true);
		expect(g.isMove("M104 S200")).toBe(false);
		expect(g.isExtrusion("G1 X1 E1")).toBe(true);
		expect(g.isExtrusion("G1 X1 F9000")).toBe(false);
		expect(g.isExtrusion("G1 X1 E0", true)).toBe(false);
	});

	it("rewrites and strips comments", () => {
		expect(g.setComment("G1 X1 ; old", "new")).toBe("G1 X1 ;new");
		expect(g.setComment("G1 X1 ; old", null)).toBe("G1 X1");
		expect(g.setComment("G1 X1", "added")).toBe("G1 X1 ;added");
	});

	it("formats numbers without trailing zeros", () => {
		expect(g.format(0.5, 3)).toBe("0.5");
		expect(g.format(600, 0)).toBe("600");
	});
});
