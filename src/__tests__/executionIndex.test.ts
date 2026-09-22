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

import { UnresolvedMessageBoxError, type MessageBoxAnswer, type MessageBoxPrompt } from "dwc-gcode-core";
import { buildExecutionIndex, resolveKnownPath } from "../model/gcode/executionIndex";
import {
	createMessageBoxResolver, loadMessageBoxAnswers, messageBoxKey, saveMessageBoxAnswers,
	type MessageBoxAnswerOverrides,
} from "../model/gcode/messageBoxAnswers";
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

function noMessageBoxes(): (prompt: MessageBoxPrompt) => MessageBoxAnswer {
	return () => { throw new UnresolvedMessageBoxError(); };
}

describe("buildExecutionIndex", () => {
	it("derives state for a linear file, one step per line", () => {
		const doc = docOf(["G28", "G1 X10 Y20", "G1 Z5"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes());
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2]);
		expect(r.steps[1]!.state.x).toBe(10);
		expect(r.steps[2]!.state.z).toBe(5);
	});

	it("only applies the chosen if/else arm's body to the derived state", () => {
		const doc = docOf(["if true", "    G1 X1", "else", "    G1 X99", "G1 Y1"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes());
		expect(r.status).toBe("complete");
		const last = r.steps[r.steps.length - 1]!;
		expect(last.state.x).toBe(1); // never sees X99 - that arm's body was never executed
		expect(last.state.y).toBe(1);
	});

	it("reports 'paused' with the path and everything derived up to that point", () => {
		const doc = docOf(["G28", "if sensors.gpIn[0].value > 0", "    G1 X1", "G1 Y1"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes());
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ line: 1, path: "sensors.gpIn[0].value" });
		expect(r.steps).toHaveLength(1); // just the G28
	});

	it("a supplied simulated value lets the walk get past the pause", () => {
		const doc = docOf(["G28", "if sensors.gpIn[0].value > 0", "    G1 X1", "G1 Y1"]);
		const overrides: SimulatedValueOverrides = new Map([["sensors.gpIn[0].value", 1]]);
		const r = buildExecutionIndex(doc, createSimulatedResolvePath(overrides), noMessageBoxes());
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2, 3]);
	});

	it("a loop's repeated lines each produce their own step with progressing state", () => {
		// A relative-extrusion move (M83), not an expression parameter (state.ts's own MachineState
		// derivation doesn't evaluate {...} expressions - see execute.ts's own documented scope
		// boundary) - isolates the thing this test actually checks: the same physical line (3)
		// contributing one step per loop iteration, each with state progressed from the last.
		const doc = docOf(["M83", "var i = 0", "while var.i < 3", "    G1 E1", "    set var.i = var.i + 1"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes());
		expect(r.status).toBe("complete");
		const es = r.steps.filter((s) => s.line === 3).map((s) => s.state.e);
		expect(es).toEqual([1, 2, 3]);
	});

	it("surfaces a structural problem as 'error', not a crash", () => {
		const doc = docOf(["else", "    G1 X1"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes());
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

	it("answers move.axes[0..2].userPosition from the last commanded X/Y/Z", () => {
		const state = createState();
		state.x = 12.5;
		state.y = 0;
		expect(resolveKnownPath("move.axes[0].userPosition", state)).toBe(12.5);
		expect(resolveKnownPath("move.axes[1].userPosition", state)).toBe(0); // teeth: 0 is a real known value
		expect(resolveKnownPath("move.axes[2].userPosition", state)).toBeUndefined(); // never moved yet
	});

	it("does NOT answer machinePosition - workplace/tool offsets aren't tracked, so claiming to know it would be dishonest", () => {
		const state = createState();
		state.x = 12.5;
		expect(resolveKnownPath("move.axes[0].machinePosition", state)).toBeUndefined();
	});

	it("answers state.currentTool from the last T command, including 'none selected' (-1)", () => {
		const state = createState();
		expect(resolveKnownPath("state.currentTool", state)).toBe(-1);
		state.tool = 2;
		expect(resolveKnownPath("state.currentTool", state)).toBe(2);
	});
});

describe("buildExecutionIndex answers homed status from a G28 already walked past", () => {
	it("resolves move.axes[0].homed from an earlier bare G28 without ever consulting the caller's resolvePath", () => {
		const doc = docOf(["G28", "if move.axes[0].homed", "    G1 X1", "G1 Y1"]);
		const resolvePath = () => { throw new Error("should not be called - homed status is already known"); };
		const r = buildExecutionIndex(doc, resolvePath, noMessageBoxes());
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2, 3]);
	});

	it("confidently answers false (not a pause) when a DIFFERENT axis was homed", () => {
		// G28 Y genuinely tells us X was NOT homed - false is a real, known answer here, not
		// "unresolved". The body never runs and the caller's resolvePath is never consulted.
		const doc = docOf(["G28 Y", "if move.axes[0].homed", "    G1 X1", "G1 Y1"]);
		const resolvePath = () => { throw new Error("should not be called - homed status is already known"); };
		const r = buildExecutionIndex(doc, resolvePath, noMessageBoxes());
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 3]); // line 2 ("G1 X1") never runs
	});

	it("before any G28 at all, also confidently answers false - 'not yet homed' is the honest starting state", () => {
		// No prior evidence of homing IS "not homed" for an isolated single-file walk (there's no
		// wider context to be uncertain about) - the same reasoning that makes this useful for
		// stepping through a homing macro itself, which typically starts with exactly this check.
		const doc = docOf(["if move.axes[0].homed", "    G1 X1", "G1 Y1"]);
		const resolvePath = () => { throw new Error("should not be called - homed status is already known"); };
		const r = buildExecutionIndex(doc, resolvePath, noMessageBoxes());
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 2]); // line 1 ("G1 X1") never runs
	});

	it("still asks the caller for anything it doesn't track itself, even after homing", () => {
		const doc = docOf(["G28", "if sensors.gpIn[0].value > 0", "    G1 X1"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes());
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ path: "sensors.gpIn[0].value" });
	});
});

describe("buildExecutionIndex's objectModelVersion passthrough", () => {
	it("with no version given, an unknown/typo'd path just pauses like any other", () => {
		const doc = docOf(["if bogus.path.here > 0", "    G1 X1"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes());
		expect(r.status).toBe("paused");
	});

	it("with a tracked version given, an unknown/typo'd path is a hard error instead", () => {
		const doc = docOf(["if bogus.path.here > 0", "    G1 X1"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes(), "3.7.0-rc.1");
		expect(r.status).toBe("error");
	});

	it("a real, known path still resolves normally through the caller's resolvePath", () => {
		const doc = docOf(["if move.speedFactor > 0", "    G1 X1"]);
		const r = buildExecutionIndex(doc, () => 1, noMessageBoxes(), "3.7.0-rc.1");
		expect(r.status).toBe("complete");
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

describe("buildExecutionIndex pauses on and resumes past a blocking M291", () => {
	it("reports 'message-box' with the parsed prompt when no answer is available", () => {
		const doc = docOf(['G28', 'M291 P"Ready?" R"Confirm" S2', "G1 X1"]);
		const r = buildExecutionIndex(doc, noOverrides(), noMessageBoxes());
		expect(r.status).toBe("message-box");
		expect(r).toMatchObject({ line: 1, prompt: { mode: "ok", message: "Ready?", title: "Confirm" } });
	});

	it("a supplied answer lets the walk continue, and a later condition reads it via 'input'", () => {
		const doc = docOf(['M291 P"How many?" S5 L0 H10', "if input > 3", "    G1 X1", "G1 Y1"]);
		const resolveMessageBox = () => ({ input: 7, cancelled: false });
		const r = buildExecutionIndex(doc, noOverrides(), resolveMessageBox);
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2, 3]);
	});

	it("a non-blocking M291 (S1) never reaches resolveMessageBox at all", () => {
		const doc = docOf(['M291 P"just a note" S1', "G1 X1"]);
		const resolveMessageBox = () => { throw new Error("should not be called - not a blocking box"); };
		const r = buildExecutionIndex(doc, noOverrides(), resolveMessageBox);
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1]);
	});
});

describe("createMessageBoxResolver / messageBoxKey", () => {
	it("answers from the override map, keyed by the prompt's own content", () => {
		const prompt = { mode: "ok" as const, message: "Ready?", title: null };
		const overrides: MessageBoxAnswerOverrides = new Map([[messageBoxKey(prompt), { input: null, cancelled: false }]]);
		expect(createMessageBoxResolver(overrides)(prompt)).toEqual({ input: null, cancelled: false });
	});

	it("throws UnresolvedMessageBoxError for a prompt with no remembered answer", () => {
		const resolve = createMessageBoxResolver(new Map());
		expect(() => resolve({ mode: "ok", message: "Ready?", title: null })).toThrow(UnresolvedMessageBoxError);
	});

	it("two prompts with identical content share the same key/answer", () => {
		const a = { mode: "okCancel" as const, message: "Continue?", title: null };
		const b = { mode: "okCancel" as const, message: "Continue?", title: null };
		expect(messageBoxKey(a)).toBe(messageBoxKey(b));
	});

	it("prompts that differ in any field get different keys", () => {
		const a = { mode: "ok" as const, message: "Ready?", title: null };
		const b = { mode: "ok" as const, message: "Ready?", title: "Confirm" };
		expect(messageBoxKey(a)).not.toBe(messageBoxKey(b));
	});
});

describe("message-box answer persistence", () => {
	it("round-trips through localStorage, keyed by file path", () => {
		const path = "0:/gcodes/mbox-persistence-1.gcode";
		const overrides: MessageBoxAnswerOverrides = new Map([["k1", { input: 5, cancelled: false }]]);
		saveMessageBoxAnswers(path, overrides);
		expect(loadMessageBoxAnswers(path)).toEqual(overrides);
	});

	it("loading a path with nothing saved returns an empty map", () => {
		expect(loadMessageBoxAnswers("0:/gcodes/mbox-never-saved.gcode").size).toBe(0);
	});

	it("saving an empty map clears any previously-saved entry", () => {
		const path = "0:/gcodes/mbox-persistence-clear.gcode";
		saveMessageBoxAnswers(path, new Map([["k", { input: null, cancelled: false }]]));
		expect(loadMessageBoxAnswers(path).size).toBe(1);
		saveMessageBoxAnswers(path, new Map());
		expect(loadMessageBoxAnswers(path).size).toBe(0);
	});
});
