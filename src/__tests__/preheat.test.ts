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

/**
 * `tempSetupSeconds` defaults to empty: a tool with nothing explicit is floored at its own first
 * selection, per `planPreheats`' documented behaviour (see docs/tasks/07-audit-defects.md, defect C)
 * — pass one explicitly to give a test genuine room to pre-heat into.
 */
function events(
	changes: Array<{ tool: number; elapsedSeconds: number; layer: number }>,
	options: {
		existingPreheats?: Array<{ tool: number; elapsedSeconds: number }>;
		tempSetupSeconds?: Map<number, number>;
		/** Defaults to 1, 2, 3... in the order `tempSetupSeconds` iterates — the exact numbers rarely
		 *  matter for a test not specifically about line-sequence gating, only that each is a real,
		 *  distinct line position. */
		tempSetupLineSeq?: Map<number, number>;
	} = {},
) {
	const tempSetupSeconds = options.tempSetupSeconds ?? new Map<number, number>();
	const tempSetupLineSeq = options.tempSetupLineSeq
		?? new Map([...tempSetupSeconds.keys()].map((tool, i) => [tool, i + 1]));
	return {
		changes,
		existingPreheats: options.existingPreheats ?? [],
		tempSetupSeconds,
		tempSetupLineSeq,
	};
}

describe("planPreheats", () => {
	it("schedules a preheat with genuine lead when the tool's temperatures are set well before its change", () => {
		// T1's temperatures are established at t=0, ten seconds before it is needed — plenty of room
		// for FAST_MODEL's ~6s lead
		const e = events(
			[{ tool: 1, elapsedSeconds: 10, layer: 1 }],
			{ tempSetupSeconds: new Map([[1, 0]]) },
		);
		const plan = planPreheats(e, [tool(1, 200, 140)], { ambient: 20, standbyPrevious: true });
		const preheats = plan.insertions.filter((i) => i.action === "preheat");
		expect(preheats).toHaveLength(1);
		expect(preheats[0].tool).toBe(1);
		expect(preheats[0].atSeconds).toBeGreaterThan(0);
		expect(preheats[0].atSeconds).toBeLessThan(10);
		expect(plan.clampedAt).toEqual([]);
	});

	it("gives a tool's own first selection no lead at all when nothing sets its temperatures earlier", () => {
		// Nothing in the file says what T0's active temperature even is before T0 itself is selected —
		// there is no legitimate point to activate it any earlier than that
		const e = events([{ tool: 0, elapsedSeconds: 5, layer: 0 }]);
		const plan = planPreheats(e, [tool(0, 200, 140)], { ambient: 20, standbyPrevious: true });
		expect(plan.insertions).toEqual([]);
		expect(plan.noLeadAt).toEqual([{ tool: 0, layer: 0 }]);
	});

	it("clamps to the tool's own temperature setup, not to line 0, and records it", () => {
		// An M568/G10 for T0 lands at t=2 — the earliest legitimate point — but the tool needs far
		// more than 3s of lead, so the pre-heat clamps to t=2 rather than reaching further back
		const e = events(
			[{ tool: 0, elapsedSeconds: 5, layer: 0 }],
			{ tempSetupSeconds: new Map([[0, 2]]) },
		);
		const plan = planPreheats(e, [tool(0, 200, 20)], { ambient: 20, standbyPrevious: true });
		expect(plan.insertions).toEqual([{ atSeconds: 2, tool: 0, action: "preheat", minLineSeqAfter: 1 }]);
		expect(plan.clampedAt).toEqual([{ tool: 0, layer: 0 }]);
	});

	it("never schedules a standby for the outgoing tool when its own next pre-heat has already fired", () => {
		// T0 -> T1 at t=10, then straight back to T0 at t=15. T0's return needs far more lead than the
		// 15s available from the start of the file, so its pre-heat clamps to t=0 — before the T0->T1
		// standby decision at t=10. That pre-heat, not a standby, is what determines T0's state at t=10.
		const e = events([
			{ tool: 0, elapsedSeconds: 0, layer: 0 },
			{ tool: 1, elapsedSeconds: 10, layer: 0 },
			{ tool: 0, elapsedSeconds: 15, layer: 0 },
		], { tempSetupSeconds: new Map([[0, 0], [1, 0]]) });
		const plan = planPreheats(e, [tool(0, 300, 20), tool(1, 200, 140)], { ambient: 20, standbyPrevious: true });

		expect(plan.insertions.some((i) => i.tool === 0 && i.action === "standby")).toBe(false);
		expect(plan.insertions).toContainEqual({ atSeconds: 0, tool: 0, action: "preheat" });
	});

	it("does schedule a standby when the outgoing tool has no pre-heat pending", () => {
		const e = events([
			{ tool: 0, elapsedSeconds: 0, layer: 0 },
			{ tool: 1, elapsedSeconds: 100, layer: 1 },
		], { tempSetupSeconds: new Map([[0, 0], [1, 0]]) });
		// A generous gap and a fast heater: T0's next reappearance (there isn't one) can't be pending,
		// so the T0 -> T1 transition should demote T0 to standby
		const plan = planPreheats(e, [tool(0, 200, 140), tool(1, 200, 140)], { ambient: 20, standbyPrevious: true });
		expect(plan.insertions).toContainEqual({ atSeconds: 100, tool: 0, action: "standby" });
	});

	it("skips a tool with no standby temperature below its active temperature, reporting it once", () => {
		const e = events([
			{ tool: 0, elapsedSeconds: 0, layer: 0 },
			{ tool: 1, elapsedSeconds: 50, layer: 1 },
		]);
		const tools = [tool(0, 200, 200), tool(1, 200, 140)]; // T0 standby == active
		const plan = planPreheats(e, tools, { ambient: 20, standbyPrevious: true });
		expect(plan.noStandby.has(0)).toBe(true);
		expect(plan.insertions.some((i) => i.tool === 0 && i.action === "preheat")).toBe(false);
	});

	it("skips a tool with no heater, without treating it as any other kind of failure", () => {
		const e = events([{ tool: 5, elapsedSeconds: 10, layer: 0 }]);
		const plan = planPreheats(e, [], { ambient: 20, standbyPrevious: true });
		expect(plan.noHeater.has(5)).toBe(true);
		expect(plan.insertions).toEqual([]);
	});

	it("skips a change the file already pre-heats for within the lead window", () => {
		const model = tool(1, 200, 140).heaters[0].model as HeaterModel;
		const lead = heatUpSeconds({ from: 140, to: 200, model, ambient: 20 }) as number;
		const e = events(
			[{ tool: 1, elapsedSeconds: 100, layer: 1 }],
			{
				// Comfortably inside (100 - lead, 100]
				existingPreheats: [{ tool: 1, elapsedSeconds: 100 - lead / 2 }],
				// An explicit earlier setup gives genuine room to pre-heat, so there is something for
				// the file's own pre-heat to actually suppress
				tempSetupSeconds: new Map([[1, 0]]),
			},
		);
		const plan = planPreheats(e, [tool(1, 200, 140)], { ambient: 20, standbyPrevious: true });
		expect(plan.insertions).toEqual([]);
	});

	it("records a tool whose heat-up estimate hit the cap, even when the change itself gets no lead", () => {
		const impossible: HeaterModel = { heatingRate: 1, deadTime: 0, coolingRate: 50, coolingExp: 1 };
		const e = events([{ tool: 0, elapsedSeconds: 1000, layer: 5 }]);
		const plan = planPreheats(e, [tool(0, 520, 20, impossible)], { ambient: 20, standbyPrevious: true });
		expect(plan.cappedTools.has(0)).toBe(true);
	});

	it("records a tool with no tuned model separately from one with no standby temperature", () => {
		const e = events([{ tool: 0, elapsedSeconds: 100, layer: 0 }]);
		const plan = planPreheats(e, [tool(0, 200, 140, null)], { ambient: 20, standbyPrevious: true });
		expect(plan.noModel.has(0)).toBe(true);
		expect(plan.noStandby.has(0)).toBe(false);
	});

	it("never stacks two pre-heats at the same instant — keeps the soonest-needed and drops the rest", () => {
		// Both tools' temperatures are set at t=0 and both need far more lead than is available, so
		// both clamp to the same instant (t=0). Only the one needed sooner (T1 at 20) should survive.
		const e = events([
			{ tool: 0, elapsedSeconds: 30, layer: 1 },
			{ tool: 1, elapsedSeconds: 20, layer: 0 },
		], { tempSetupSeconds: new Map([[0, 0], [1, 0]]) });
		const plan = planPreheats(e, [tool(0, 300, 20), tool(1, 300, 20)], { ambient: 20, standbyPrevious: false });
		const preheatsAtZero = plan.insertions.filter((i) => i.action === "preheat" && i.atSeconds === 0);
		expect(preheatsAtZero).toEqual([{ atSeconds: 0, tool: 1, action: "preheat", minLineSeqAfter: 2 }]);
		expect(plan.droppedStacked).toEqual([{ tool: 0, atSeconds: 0 }]);
	});

	it("does not schedule a standby for the previous tool when standbyPrevious is off", () => {
		const e = events([
			{ tool: 0, elapsedSeconds: 0, layer: 0 },
			{ tool: 1, elapsedSeconds: 50, layer: 1 },
		], { tempSetupSeconds: new Map([[0, 0], [1, 0]]) });
		const plan = planPreheats(e, [tool(0, 200, 140), tool(1, 200, 140)], { ambient: 20, standbyPrevious: false });
		expect(plan.insertions.some((i) => i.action === "standby")).toBe(false);
	});

	it("does nothing for a file that only ever uses one tool", () => {
		const e = events([{ tool: 0, elapsedSeconds: 0, layer: 0 }]);
		const plan = planPreheats(e, [tool(0, 200, 140)], { ambient: 20, standbyPrevious: true });
		expect(plan.insertions).toEqual([]);
	});
});
