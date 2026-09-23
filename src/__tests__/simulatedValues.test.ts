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

import type { EvalValue } from "dwc-gcode-core";
import {
	loadSimulatedOverrides, saveSimulatedOverrides, type SimulatedValueOverrides,
} from "../model/gcode/simulatedValues";

// The pure resolver logic this module re-exports (createSimulatedResolvePath,
// parseSimulatedValueInput) is tested at its real source, dwc-gcode-core/test/executionIndex.test.ts
// - only this module's own addition, localStorage persistence, is tested here.
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
