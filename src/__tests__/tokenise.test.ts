import { describe, expect, it } from "vitest";

import {
	findCommentIndex, formatNumber, parseParams, paramNumber, removeParam, setParam, tokenise, withBody,
} from "../model/gcode/tokenise";

describe("findCommentIndex", () => {
	it("finds a plain comment", () => {
		expect(findCommentIndex("G1 X10 ; move")).toBe(7);
	});

	it("ignores a semicolon inside a quoted string", () => {
		// The bug this guards against corrupts any RRF message containing a semicolon
		const line = "M291 P\"done; resuming\" S0";
		expect(findCommentIndex(line)).toBe(-1);
		expect(tokenise(line).comment).toBeNull();
	});

	it("handles a doubled quote escape", () => {
		const line = "M117 P\"say \"\"hi\"\"; now\" ; real comment";
		const index = findCommentIndex(line);
		expect(line.slice(index)).toBe("; real comment");
	});

	it("returns -1 when there is no comment", () => {
		expect(findCommentIndex("G1 X10 Y10")).toBe(-1);
	});
});

describe("tokenise", () => {
	it("reads a G command", () => {
		const t = tokenise("G1 X10 Y20 E1.5 F1200");
		expect(t.code).toBe("G1");
		expect(t.letter).toBe("G");
		expect(t.number).toBe(1);
		expect(t.isCommentOnly).toBe(false);
	});

	it("reads a fractional command", () => {
		expect(tokenise("G38.2 X10").code).toBe("G38.2");
		expect(tokenise("G38.2 X10").number).toBe(38.2);
	});

	it("skips a leading line number", () => {
		expect(tokenise("N42 G1 X10").code).toBe("G1");
	});

	it("treats a lower-case command as a command", () => {
		expect(tokenise("g1 x10").code).toBe("G1");
	});

	it("marks a comment-only line", () => {
		const t = tokenise(";LAYER_CHANGE");
		expect(t.code).toBeNull();
		expect(t.isCommentOnly).toBe(true);
		expect(t.comment).toBe("LAYER_CHANGE");
	});

	it("marks a blank line as comment-only", () => {
		expect(tokenise("").isCommentOnly).toBe(true);
		expect(tokenise("   ").isCommentOnly).toBe(true);
	});

	it("does not treat a bare letter as a command", () => {
		expect(tokenise("T").code).toBeNull();
	});

	it("reads a tool change", () => {
		expect(tokenise("T1").code).toBe("T1");
		expect(tokenise("T-1").code).toBeNull(); // the minus is not a digit — a bare unload
	});
});

describe("parseParams", () => {
	it("parses plain numeric parameters", () => {
		const params = parseParams("G1 X10 Y-20.5 E1e-3 F1200");
		expect(params.map((p) => p.letter)).toEqual(["X", "Y", "E", "F"]);
		expect(paramNumber(params, "Y")).toBe(-20.5);
		expect(paramNumber(params, "E")).toBe(0.001);
	});

	it("parses a quoted string parameter", () => {
		const params = parseParams("M98 P\"0:/macros/my macro.g\"");
		expect(params).toHaveLength(1);
		expect(params[0].value).toBe("\"0:/macros/my macro.g\"");
	});

	it("parses an expression parameter", () => {
		const params = parseParams("M291 S{move.axes[0].max} P\"x\"");
		expect(params[0].letter).toBe("S");
		expect(params[0].value).toBe("{move.axes[0].max}");
		expect(params[1].letter).toBe("P");
	});

	it("returns nothing for a bare command", () => {
		expect(parseParams("G28")).toHaveLength(0);
	});

	it("gives spans that address the original text", () => {
		const body = "G1 X10 Y20";
		const y = parseParams(body).find((p) => p.letter === "Y");
		expect(body.slice(y!.start, y!.end)).toBe("Y20");
	});
});

describe("setParam / removeParam", () => {
	it("replaces a value in place, leaving the rest byte-identical", () => {
		expect(setParam("G1 X10   Y20 E1", "Y", "99")).toBe("G1 X10   Y99 E1");
	});

	it("appends a parameter that is not present", () => {
		expect(setParam("G1 X10", "F", "1200")).toBe("G1 X10 F1200");
	});

	it("preserves trailing whitespace when appending", () => {
		expect(setParam("G1 X10 ", "F", "1200")).toBe("G1 X10 F1200 ");
	});

	it("removes a parameter and its leading space", () => {
		expect(removeParam("G1 X10 Y20 E1", "Y")).toBe("G1 X10 E1");
	});

	it("leaves the body alone when removing something absent", () => {
		expect(removeParam("G1 X10", "Z")).toBe("G1 X10");
	});
});

describe("withBody", () => {
	it("puts the original comment back", () => {
		const t = tokenise("G1 X10 ; travel");
		expect(withBody(t, "G1 X99 ")).toBe("G1 X99 ; travel");
	});

	it("adds nothing when there was no comment", () => {
		expect(withBody(tokenise("G1 X10"), "G1 X99")).toBe("G1 X99");
	});
});

describe("formatNumber", () => {
	it("trims trailing zeros", () => {
		expect(formatNumber(0.8, 3)).toBe("0.8");
		expect(formatNumber(5, 3)).toBe("5");
		expect(formatNumber(1200.004, 2)).toBe("1200");
	});

	it("respects the decimal limit", () => {
		expect(formatNumber(1 / 3, 4)).toBe("0.3333");
		expect(formatNumber(1 / 3, 0)).toBe("0");
	});

	it("survives a non-finite input", () => {
		expect(formatNumber(NaN, 3)).toBe("0");
	});
});
