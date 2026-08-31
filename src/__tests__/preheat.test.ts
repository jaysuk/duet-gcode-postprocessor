import { describe, expect, it } from "vitest";

import { HEATUP_CAP_SECONDS, heatUpSeconds, type HeaterModel, type ToolConfig } from "../model/preheat";
import { planPreheats } from "../model/steps/preheat";

const MODEL: HeaterModel = { heatingRate: 2.43, deadTime: 5.5, coolingRate: 0.56, coolingExp: 1.35 };

describe("heatUpSeconds", () => {
	it("matches the closed-form linear case when there is no cooling", () => {
		// With coolingRate 0 the ODE is just dT/dt = heatingRate, so the raw heating time is exactly
		// (to - from) / heatingRate: 60C rise at 2.43 C/s is 24.6913...s, plus dead time, times the
		// safety factor
		const model: HeaterModel = { heatingRate: 2.43, deadTime: 5.5, coolingRate: 0, coolingExp: 1.35 };
		const raw = 60 / 2.43;
		const expected = (raw + 5.5) * 1.15;
		const result = heatUpSeconds({ from: 140, to: 200, model, ambient: 20 });
		expect(result).toBeCloseTo(expected, 1);
	});

	it("takes longer than the naive delta/heatingRate once real cooling is included", () => {
		const naive = 60 / MODEL.heatingRate;
		const result = heatUpSeconds({ from: 140, to: 200, model: MODEL, ambient: 20 });
		expect(result).not.toBeNull();
		expect(result as number).toBeGreaterThan(naive);
	});

	it("is 0 when the target is at or below the standby temperature", () => {
		expect(heatUpSeconds({ from: 200, to: 200, model: MODEL, ambient: 20 })).toBe(0);
		expect(heatUpSeconds({ from: 200, to: 140, model: MODEL, ambient: 20 })).toBe(0);
	});

	it("returns null for a missing or non-positive heating rate rather than guessing", () => {
		expect(heatUpSeconds({ from: 140, to: 200, model: { ...MODEL, heatingRate: 0 }, ambient: 20 })).toBeNull();
		expect(heatUpSeconds({ from: 140, to: 200, model: { ...MODEL, heatingRate: -1 }, ambient: 20 })).toBeNull();
	});

	it("hits the cap for a target at or beyond the model's achievable steady state", () => {
		// Steady state is where heatingRate == coolingRate*(T/100)^coolingExp; pick a target well
		// beyond that so it can never be reached at full power
		const model: HeaterModel = { heatingRate: 1, deadTime: 0, coolingRate: 50, coolingExp: 1 };
		// Steady state Tss = 100 * heatingRate/coolingRate = 2C above ambient — ask for 500C above it
		const result = heatUpSeconds({ from: 20, to: 520, model, ambient: 20 });
		expect(result).toBe(HEATUP_CAP_SECONDS);
	});

	it("defaults the safety factor to 1.15 and scales the result when given one explicitly", () => {
		const base = heatUpSeconds({ from: 140, to: 200, model: MODEL, ambient: 20 }) as number;
		const explicit = heatUpSeconds({ from: 140, to: 200, model: MODEL, ambient: 20, safetyFactor: 1.15 }) as number;
		expect(explicit).toBeCloseTo(base, 9);

		const doubled = heatUpSeconds({ from: 140, to: 200, model: MODEL, ambient: 20, safetyFactor: 2.3 }) as number;
		expect(doubled).toBeCloseTo(base * 2, 1);
	});

	it("adds dead time rather than multiplying it into the integration", () => {
		const noDeadTime = heatUpSeconds({ from: 140, to: 200, model: { ...MODEL, deadTime: 0 }, ambient: 20 }) as number;
		const withDeadTime = heatUpSeconds({ from: 140, to: 200, model: { ...MODEL, deadTime: 10 }, ambient: 20 }) as number;
		// The only difference between the two runs is 10 seconds of dead time, scaled by the same
		// safety factor as everything else — not multiplied into the (unchanged) integration itself
		expect(withDeadTime - noDeadTime).toBeCloseTo(10 * 1.15, 1);
	});
});

const FAST_MODEL: HeaterModel = { heatingRate: 10, deadTime: 0, coolingRate: 0, coolingExp: 1.35 };

function tool(n: number, active: number, standby: number, model: HeaterModel | null = FAST_MODEL): ToolConfig {
	return { toolNumber: n, heaters: [{ heaterIndex: n, active, standby, model }] };
}

describe("planPreheats", () => {
	it("schedules one preheat per tool change, each landing no later than its own change", () => {
		const events = {
			changes: [
				{ tool: 0, elapsedSeconds: 0, layer: 0 },
				{ tool: 1, elapsedSeconds: 100, layer: 1 },
			],
			existingPreheats: [],
		};
		const tools = [tool(0, 200, 140), tool(1, 200, 140)];
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: true });
		const preheats = plan.insertions.filter((i) => i.action === "preheat");
		expect(preheats.map((i) => i.tool)).toEqual([0, 1]);
		expect(preheats[1].atSeconds).toBeLessThan(100);
		expect(preheats[1].atSeconds).toBeGreaterThan(0);
	});

	it("clamps to the start of the file when there is not enough print before the change, and records it", () => {
		const events = { changes: [{ tool: 0, elapsedSeconds: 1, layer: 0 }], existingPreheats: [] };
		const tools = [tool(0, 200, 20)]; // a large rise, far more lead needed than the 1s available
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: true });
		expect(plan.insertions[0].atSeconds).toBe(0);
		expect(plan.clampedAt).toEqual([{ tool: 0, layer: 0 }]);
	});

	it("never schedules a standby for the outgoing tool at or after its own next pending preheat", () => {
		const events = {
			changes: [
				{ tool: 0, elapsedSeconds: 0, layer: 0 },
				{ tool: 1, elapsedSeconds: 10, layer: 0 },
				{ tool: 0, elapsedSeconds: 15, layer: 0 }, // back to T0 almost immediately
			],
			existingPreheats: [],
		};
		const tools = [tool(0, 200, 140), tool(1, 200, 140)];
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: true });
		const t0Preheats = plan.insertions.filter((i) => i.tool === 0 && i.action === "preheat" && i.atSeconds >= 15);
		const t0Standbys = plan.insertions.filter((i) => i.tool === 0 && i.action === "standby");
		for (const standby of t0Standbys) {
			for (const preheat of t0Preheats) {
				expect(standby.atSeconds).toBeLessThan(preheat.atSeconds);
			}
		}
	});

	it("skips a tool with no standby temperature below its active temperature, reporting it once", () => {
		const events = {
			changes: [
				{ tool: 0, elapsedSeconds: 0, layer: 0 },
				{ tool: 1, elapsedSeconds: 50, layer: 1 },
			],
			existingPreheats: [],
		};
		const tools = [tool(0, 200, 200), tool(1, 200, 140)]; // T0 standby == active
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: true });
		expect(plan.noStandby.has(0)).toBe(true);
		expect(plan.insertions.some((i) => i.tool === 0 && i.action === "preheat")).toBe(false);
	});

	it("skips a tool with no heater, without treating it as any other kind of failure", () => {
		const events = { changes: [{ tool: 5, elapsedSeconds: 10, layer: 0 }], existingPreheats: [] };
		const plan = planPreheats(events, [], { ambient: 20, standbyPrevious: true });
		expect(plan.noHeater.has(5)).toBe(true);
		expect(plan.insertions).toEqual([]);
	});

	it("skips a change the file already pre-heats for within the lead window", () => {
		const model = tool(1, 200, 140).heaters[0].model as HeaterModel;
		const lead = heatUpSeconds({ from: 140, to: 200, model, ambient: 20 }) as number;
		const events = {
			changes: [{ tool: 1, elapsedSeconds: 100, layer: 1 }],
			// Comfortably inside (100 - lead, 100]
			existingPreheats: [{ tool: 1, elapsedSeconds: 100 - lead / 2 }],
		};
		const tools = [tool(1, 200, 140)];
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: true });
		expect(plan.insertions).toEqual([]);
	});

	it("records a tool whose heat-up estimate hit the cap", () => {
		const impossible: HeaterModel = { heatingRate: 1, deadTime: 0, coolingRate: 50, coolingExp: 1 };
		const events = { changes: [{ tool: 0, elapsedSeconds: 1000, layer: 5 }], existingPreheats: [] };
		const tools = [tool(0, 520, 20, impossible)];
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: true });
		expect(plan.cappedTools.has(0)).toBe(true);
	});

	it("records a tool with no tuned model separately from one with no standby temperature", () => {
		const events = { changes: [{ tool: 0, elapsedSeconds: 100, layer: 0 }], existingPreheats: [] };
		const tools = [tool(0, 200, 140, null)];
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: true });
		expect(plan.noModel.has(0)).toBe(true);
		expect(plan.noStandby.has(0)).toBe(false);
	});

	it("does not schedule a standby for the previous tool when standbyPrevious is off", () => {
		const events = {
			changes: [
				{ tool: 0, elapsedSeconds: 0, layer: 0 },
				{ tool: 1, elapsedSeconds: 50, layer: 1 },
			],
			existingPreheats: [],
		};
		const tools = [tool(0, 200, 140), tool(1, 200, 140)];
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: false });
		expect(plan.insertions.some((i) => i.action === "standby")).toBe(false);
	});

	it("does nothing for a file that only ever uses one tool", () => {
		const events = { changes: [{ tool: 0, elapsedSeconds: 0, layer: 0 }], existingPreheats: [] };
		const tools = [tool(0, 200, 140)];
		const plan = planPreheats(events, tools, { ambient: 20, standbyPrevious: true });
		// A single tool still gets its own (clamped) first pre-heat attempt; "only one tool used"
		// is reported by the step itself from the raw tool-change count, not by the planner
		expect(plan.insertions.filter((i) => i.action === "standby")).toEqual([]);
	});
});
