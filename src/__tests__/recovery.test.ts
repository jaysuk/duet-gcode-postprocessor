import { describe, expect, it } from "vitest";

import { emptyRecoveryState, recoveryPlan, type RecoveryEvent } from "../model/recovery";

describe("recoveryPlan", () => {
	it("returns the empty state for no events at all", () => {
		expect(recoveryPlan([])).toEqual(emptyRecoveryState());
	});

	it("tool: the last selection wins", () => {
		const events: Array<RecoveryEvent> = [{ kind: "tool", tool: 0 }, { kind: "tool", tool: 1 }];
		expect(recoveryPlan(events).tool).toBe(1);
	});

	it("bedTemp: the last commanded temperature wins", () => {
		const events: Array<RecoveryEvent> = [{ kind: "bedTemp", temp: 60 }, { kind: "bedTemp", temp: 80 }];
		expect(recoveryPlan(events).bedTemp).toBe(80);
	});

	it("bedTemp: null when never commanded", () => {
		expect(recoveryPlan([{ kind: "tool", tool: 0 }]).bedTemp).toBeNull();
	});

	it("toolTemps: each tool tracked independently, last value per tool wins", () => {
		const events: Array<RecoveryEvent> = [
			{ kind: "toolTemp", tool: 0, temp: 200 },
			{ kind: "toolTemp", tool: 1, temp: 210 },
			{ kind: "toolTemp", tool: 0, temp: 205 },
		];
		const state = recoveryPlan(events);
		expect(state.toolTemps.get(0)).toBe(205);
		expect(state.toolTemps.get(1)).toBe(210);
	});

	it("a tool never heated before the cut has no entry at all — not defaulted to 0 or omitted-as-zero", () => {
		const state = recoveryPlan([{ kind: "toolTemp", tool: 0, temp: 200 }]);
		expect(state.toolTemps.has(1)).toBe(false);
	});

	it("fan: the last commanded index/speed pair wins, as one unit", () => {
		const events: Array<RecoveryEvent> = [
			{ kind: "fan", index: 0, speed: 255 },
			{ kind: "fan", index: 0, speed: 128 },
		];
		expect(recoveryPlan(events).fan).toEqual({ index: 0, speed: 128 });
	});

	it("fan: null when never commanded", () => {
		expect(recoveryPlan([]).fan).toBeNull();
	});

	it("extrusionMode and moveMode: the last toggle wins, independently of each other", () => {
		const events: Array<RecoveryEvent> = [
			{ kind: "extrusionMode", relative: false },
			{ kind: "moveMode", relative: true },
			{ kind: "extrusionMode", relative: true },
		];
		const state = recoveryPlan(events);
		expect(state.relativeE).toBe(true);
		expect(state.relativeMoves).toBe(true);
	});

	it("object: the last one wins, including a later S-1 clearing it", () => {
		const events: Array<RecoveryEvent> = [
			{ kind: "object", index: 0, name: "part-a" },
			{ kind: "object", index: 1, name: "part-b" },
		];
		expect(recoveryPlan(events).object).toEqual({ index: 1, name: "part-b" });
		const cleared: Array<RecoveryEvent> = [...events, { kind: "object", index: null, name: null }];
		expect(recoveryPlan(cleared).object).toBeNull();
	});

	it("object: an index with no name (M486 S<n> with no A) still restores the index, name null", () => {
		const state = recoveryPlan([{ kind: "object", index: 2, name: null }]);
		expect(state.object).toEqual({ index: 2, name: null });
	});

	it("position: each axis updates independently, and a null axis on one event leaves the others alone", () => {
		const events: Array<RecoveryEvent> = [
			{ kind: "position", x: 10, y: 10, z: 0.2 },
			{ kind: "position", x: 20, y: null, z: null },
		];
		const state = recoveryPlan(events);
		expect(state.x).toBe(20);
		expect(state.y).toBe(10);
		expect(state.z).toBe(0.2);
	});

	it("position: null before any event at all", () => {
		const state = recoveryPlan([]);
		expect(state.x).toBeNull();
		expect(state.y).toBeNull();
		expect(state.z).toBeNull();
	});

	it("absoluteE: the last resolved value wins, regardless of what extrusion mode produced it", () => {
		const events: Array<RecoveryEvent> = [
			{ kind: "extrusionMode", relative: false },
			{ kind: "absoluteE", value: 5 },
			{ kind: "extrusionMode", relative: true },
			{ kind: "absoluteE", value: 7 }, // already resolved to absolute by the collector
		];
		expect(recoveryPlan(events).absoluteE).toBe(7);
	});

	it("absoluteE: null when E was never used before the cut — not defaulted to 0", () => {
		expect(recoveryPlan([{ kind: "tool", tool: 0 }]).absoluteE).toBeNull();
	});

	it("every field's precedence is independent of every other field's own event order", () => {
		const events: Array<RecoveryEvent> = [
			{ kind: "bedTemp", temp: 60 },
			{ kind: "tool", tool: 0 },
			{ kind: "toolTemp", tool: 0, temp: 200 },
			{ kind: "fan", index: 0, speed: 255 },
			{ kind: "tool", tool: 1 },
			{ kind: "bedTemp", temp: 65 },
		];
		const state = recoveryPlan(events);
		expect(state.tool).toBe(1);
		expect(state.bedTemp).toBe(65);
		expect(state.toolTemps.get(0)).toBe(200);
		expect(state.fan).toEqual({ index: 0, speed: 255 });
	});
});
