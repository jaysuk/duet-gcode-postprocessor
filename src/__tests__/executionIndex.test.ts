import { Text } from "@codemirror/state";
import { UnresolvedPathError, type EvalValue } from "dwc-gcode-core";
import { describe, expect, it } from "vitest";

import { buildExecutionIndex } from "../model/gcode/executionIndex";
import { createSimulatedResolvePath, parseSimulatedValueInput, type SimulatedValueOverrides } from "../model/gcode/simulatedValues";

function docOf(lines: Array<string>): Text {
	return Text.of(lines);
}

function noOverrides(): (path: string) => EvalValue {
	return (path) => { throw new UnresolvedPathError(path); };
}

describe("buildExecutionIndex", () => {
	it("derives state for a linear file, one step per line", () => {
		const doc = docOf(["G28", "G1 X10 Y20", "G1 Z5"]);
		const r = buildExecutionIndex(doc, noOverrides());
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2]);
		expect(r.steps[1]!.state.x).toBe(10);
		expect(r.steps[2]!.state.z).toBe(5);
	});

	it("only applies the chosen if/else arm's body to the derived state", () => {
		const doc = docOf(["if true", "    G1 X1", "else", "    G1 X99", "G1 Y1"]);
		const r = buildExecutionIndex(doc, noOverrides());
		expect(r.status).toBe("complete");
		const last = r.steps[r.steps.length - 1]!;
		expect(last.state.x).toBe(1); // never sees X99 - that arm's body was never executed
		expect(last.state.y).toBe(1);
	});

	it("reports 'paused' with the path and everything derived up to that point", () => {
		const doc = docOf(["G28", "if sensors.gpIn[0].value > 0", "    G1 X1", "G1 Y1"]);
		const r = buildExecutionIndex(doc, noOverrides());
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ line: 1, path: "sensors.gpIn[0].value" });
		expect(r.steps).toHaveLength(1); // just the G28
	});

	it("a supplied simulated value lets the walk get past the pause", () => {
		const doc = docOf(["G28", "if sensors.gpIn[0].value > 0", "    G1 X1", "G1 Y1"]);
		const overrides: SimulatedValueOverrides = new Map([["sensors.gpIn[0].value", 1]]);
		const r = buildExecutionIndex(doc, createSimulatedResolvePath(overrides));
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2, 3]);
	});

	it("a loop's repeated lines each produce their own step with progressing state", () => {
		// A relative-extrusion move (M83), not an expression parameter (state.ts's own MachineState
		// derivation doesn't evaluate {...} expressions - see execute.ts's own documented scope
		// boundary) - isolates the thing this test actually checks: the same physical line (3)
		// contributing one step per loop iteration, each with state progressed from the last.
		const doc = docOf(["M83", "var i = 0", "while var.i < 3", "    G1 E1", "    set var.i = var.i + 1"]);
		const r = buildExecutionIndex(doc, noOverrides());
		expect(r.status).toBe("complete");
		const es = r.steps.filter((s) => s.line === 3).map((s) => s.state.e);
		expect(es).toEqual([1, 2, 3]);
	});

	it("surfaces a structural problem as 'error', not a crash", () => {
		const doc = docOf(["else", "    G1 X1"]);
		const r = buildExecutionIndex(doc, noOverrides());
		expect(r.status).toBe("error");
	});
});

describe("createSimulatedResolvePath", () => {
	it("answers from the override map", () => {
		const resolve = createSimulatedResolvePath(new Map([["heat.heaters[0].current", 205.5]]));
		expect(resolve("heat.heaters[0].current")).toBe(205.5);
	});

	it("throws UnresolvedPathError for anything not in the map", () => {
		const resolve = createSimulatedResolvePath(new Map());
		expect(() => resolve("state.status")).toThrow(UnresolvedPathError);
	});

	it("teeth: an overridden value of exactly 0/false/'' is still honoured, not treated as missing", () => {
		const resolve = createSimulatedResolvePath(new Map<string, EvalValue>([
			["a", 0], ["b", false], ["c", ""],
		]));
		expect(resolve("a")).toBe(0);
		expect(resolve("b")).toBe(false);
		expect(resolve("c")).toBe("");
	});
});

describe("parseSimulatedValueInput", () => {
	it("parses booleans case-insensitively", () => {
		expect(parseSimulatedValueInput("true")).toBe(true);
		expect(parseSimulatedValueInput("FALSE")).toBe(false);
	});

	it("parses numbers", () => {
		expect(parseSimulatedValueInput("42")).toBe(42);
		expect(parseSimulatedValueInput("-3.5")).toBe(-3.5);
	});

	it("falls back to the literal string for anything else", () => {
		expect(parseSimulatedValueInput("triggered")).toBe("triggered");
	});

	it("teeth: '0' parses as the number 0, not the string \"0\"", () => {
		const v = parseSimulatedValueInput("0");
		expect(v).toBe(0);
		expect(typeof v).toBe("number");
	});
});
