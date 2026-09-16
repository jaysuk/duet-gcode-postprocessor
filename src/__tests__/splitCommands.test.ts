import { describe, expect, it } from "vitest";
import { splitCommands } from "../model/gcode/splitCommands";

describe("splitCommands", () => {
	it("returns the line unchanged when it holds zero commands", () => {
		expect(splitCommands("")).toEqual([""]);
		expect(splitCommands("; a comment")).toEqual(["; a comment"]);
		expect(splitCommands("   ")).toEqual(["   "]);
	});

	it("returns the line unchanged when it holds exactly one command", () => {
		expect(splitCommands("G1 X10 Y20 F3000")).toEqual(["G1 X10 Y20 F3000"]);
		expect(splitCommands("G1 X10 ; a comment")).toEqual(["G1 X10 ; a comment"]);
	});

	it("splits a mode change combined with a move", () => {
		expect(splitCommands("G90 G1 Z5")).toEqual(["G90 ", "G1 Z5"]);
	});

	it("splits three commands on one line", () => {
		expect(splitCommands("M83 G92 E0 G1 F3000")).toEqual(["M83 ", "G92 E0 ", "G1 F3000"]);
	});

	it("keeps a trailing comment attached only to the last command", () => {
		expect(splitCommands("G90 G1 Z5 ; lift")).toEqual(["G90 ", "G1 Z5 ; lift"]);
	});

	it("keeps a leading line number/checksum attached to the first command", () => {
		expect(splitCommands("N10 G90 G1 Z5*42")).toEqual(["N10 G90 ", "G1 Z5*42"]);
	});

	it("concatenating the result always reconstructs the original line", () => {
		for (const raw of ["G90 G1 Z5", "M83 G92 E0 G1 F3000", "N10 G90 G1 Z5*42 ; lift", "G1 X1"]) {
			expect(splitCommands(raw).join("")).toBe(raw);
		}
	});
});
