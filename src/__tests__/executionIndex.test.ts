import { Text } from "@codemirror/state";
import { UnresolvedPathError, type EvalValue } from "dwc-gcode-core";
import { describe, expect, it, vi } from "vitest";

// This harness's happy-dom `localStorage` is a non-functional stub (`localStorage.setItem` is not a
// function — same environment gap `autoRun.test.ts` documents and works around for `recipeStore`). A
// tiny in-memory stand-in is the only way to exercise the persistence tests below; real DWC runs in an
// actual browser, where the real localStorage works.
const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => memoryStorage.get(key) ?? null,
	setItem: (key: string, value: string) => { memoryStorage.set(key, value); },
	removeItem: (key: string) => { memoryStorage.delete(key); },
});

import { buildExecutionIndex, resolveKnownPath } from "../model/gcode/executionIndex";
import {
	createSimulatedResolvePath, loadSimulatedOverrides, parseSimulatedValueInput, saveSimulatedOverrides,
	type SimulatedValueOverrides,
} from "../model/gcode/simulatedValues";
import { createState } from "../model/gcode/state";

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

describe("resolveKnownPath", () => {
	it("answers move.axes[0..2].homed from tracked state", () => {
		const state = createState();
		state.homedX = true;
		expect(resolveKnownPath("move.axes[0].homed", state)).toBe(true);
		expect(resolveKnownPath("move.axes[1].homed", state)).toBe(false);
		expect(resolveKnownPath("move.axes[2].homed", state)).toBe(false);
	});

	it("returns undefined (not a value) for anything it doesn't track, so the caller falls through", () => {
		expect(resolveKnownPath("sensors.gpIn[0].value", createState())).toBeUndefined();
		expect(resolveKnownPath("move.axes[3].homed", createState())).toBeUndefined();
	});
});

describe("buildExecutionIndex answers homed status from a G28 already walked past", () => {
	it("resolves move.axes[0].homed from an earlier bare G28 without ever consulting the caller's resolvePath", () => {
		const doc = docOf(["G28", "if move.axes[0].homed", "    G1 X1", "G1 Y1"]);
		const resolvePath = () => { throw new Error("should not be called - homed status is already known"); };
		const r = buildExecutionIndex(doc, resolvePath);
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2, 3]);
	});

	it("confidently answers false (not a pause) when a DIFFERENT axis was homed", () => {
		// G28 Y genuinely tells us X was NOT homed - false is a real, known answer here, not
		// "unresolved". The body never runs and the caller's resolvePath is never consulted.
		const doc = docOf(["G28 Y", "if move.axes[0].homed", "    G1 X1", "G1 Y1"]);
		const resolvePath = () => { throw new Error("should not be called - homed status is already known"); };
		const r = buildExecutionIndex(doc, resolvePath);
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 3]); // line 2 ("G1 X1") never runs
	});

	it("before any G28 at all, also confidently answers false - 'not yet homed' is the honest starting state", () => {
		// No prior evidence of homing IS "not homed" for an isolated single-file walk (there's no
		// wider context to be uncertain about) - the same reasoning that makes this useful for
		// stepping through a homing macro itself, which typically starts with exactly this check.
		const doc = docOf(["if move.axes[0].homed", "    G1 X1", "G1 Y1"]);
		const resolvePath = () => { throw new Error("should not be called - homed status is already known"); };
		const r = buildExecutionIndex(doc, resolvePath);
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 2]); // line 1 ("G1 X1") never runs
	});

	it("still asks the caller for anything it doesn't track itself, even after homing", () => {
		const doc = docOf(["G28", "if sensors.gpIn[0].value > 0", "    G1 X1"]);
		const r = buildExecutionIndex(doc, noOverrides());
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ path: "sensors.gpIn[0].value" });
	});
});

describe("simulated-value persistence", () => {
	it("round-trips through localStorage, keyed by file path", () => {
		const path = "0:/gcodes/persistence-test-1.gcode";
		const overrides: SimulatedValueOverrides = new Map<string, EvalValue>([["sensors.gpIn[0].value", 1], ["state.status", "idle"]]);
		saveSimulatedOverrides(path, overrides);
		expect(loadSimulatedOverrides(path)).toEqual(overrides);
	});

	it("a different file path gets its own, independent entry", () => {
		const pathA = "0:/gcodes/persistence-test-a.gcode";
		const pathB = "0:/gcodes/persistence-test-b.gcode";
		saveSimulatedOverrides(pathA, new Map([["x", 1]]));
		saveSimulatedOverrides(pathB, new Map([["x", 2]]));
		expect(loadSimulatedOverrides(pathA).get("x")).toBe(1);
		expect(loadSimulatedOverrides(pathB).get("x")).toBe(2);
	});

	it("loading a path with nothing saved returns an empty map, not an error", () => {
		expect(loadSimulatedOverrides("0:/gcodes/never-saved.gcode").size).toBe(0);
	});

	it("saving an empty map clears any previously-saved entry rather than leaving a stale one", () => {
		const path = "0:/gcodes/persistence-test-clear.gcode";
		saveSimulatedOverrides(path, new Map([["x", 1]]));
		expect(loadSimulatedOverrides(path).size).toBe(1);
		saveSimulatedOverrides(path, new Map());
		expect(loadSimulatedOverrides(path).size).toBe(0);
	});
});
