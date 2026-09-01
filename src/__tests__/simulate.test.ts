import { describe, expect, it, vi } from "vitest";

import {
	simulateFile, SimulationCancelledError, SimulationRefusedError, SimulationTimedOutError,
	type SimulationStatus,
} from "../model/io/simulate";
import { FakeGateway } from "./helpers";

/** A sequence of poll results, one per call; the last one repeats once the sequence is exhausted. */
function pollSequence(...results: Array<SimulationStatus>): () => SimulationStatus {
	let i = 0;
	return () => results[Math.min(i++, results.length - 1)];
}

const NO_WAIT = () => Promise.resolve();

describe("simulateFile", () => {
	it("sends M37 with the quoted source path", async () => {
		const gateway = new FakeGateway();
		await simulateFile({
			gateway, sourcePath: "0:/gcodes/test.gcode", sleep: NO_WAIT,
			pollStatus: pollSequence(
				{ status: "idle", lastDurationSeconds: null },
				{ status: "simulating", lastDurationSeconds: null },
				{ status: "idle", lastDurationSeconds: 42 },
			),
		});
		expect(gateway.sentCodes).toEqual(['M37 P"0:/gcodes/test.gcode"']);
	});

	it("returns the simulated seconds once the machine leaves \"simulating\"", async () => {
		const gateway = new FakeGateway();
		const seconds = await simulateFile({
			gateway, sourcePath: "0:/gcodes/test.gcode", sleep: NO_WAIT,
			pollStatus: pollSequence(
				{ status: "idle", lastDurationSeconds: null },
				{ status: "simulating", lastDurationSeconds: null },
				{ status: "simulating", lastDurationSeconds: null },
				{ status: "idle", lastDurationSeconds: 3723 },
			),
		});
		expect(seconds).toBe(3723);
	});

	it("refuses to start when the machine is already busy, without sending anything", async () => {
		const gateway = new FakeGateway();
		await expect(simulateFile({
			gateway, sourcePath: "0:/gcodes/test.gcode", sleep: NO_WAIT,
			pollStatus: () => ({ status: "processing", lastDurationSeconds: null }),
		})).rejects.toThrow(SimulationRefusedError);
		expect(gateway.sentCodes).toEqual([]);
	});

	it("refuses when the machine replies with an error", async () => {
		const gateway = new FakeGateway();
		gateway.codeReply = "Error: G-Code file not found";
		await expect(simulateFile({
			gateway, sourcePath: "0:/gcodes/missing.gcode", sleep: NO_WAIT,
			pollStatus: () => ({ status: "idle", lastDurationSeconds: null }),
		})).rejects.toThrow(SimulationRefusedError);
	});

	it("never returns a null duration — throws instead if the machine reports none", async () => {
		const gateway = new FakeGateway();
		await expect(simulateFile({
			gateway, sourcePath: "0:/gcodes/test.gcode", sleep: NO_WAIT,
			pollStatus: pollSequence(
				{ status: "idle", lastDurationSeconds: null },
				{ status: "simulating", lastDurationSeconds: null },
				{ status: "idle", lastDurationSeconds: null },
			),
		})).rejects.toThrow(/no duration/);
	});

	it("is cancellable via the signal, without waiting for completion", async () => {
		const gateway = new FakeGateway();
		const signal = { aborted: false };
		const sleep = async () => { signal.aborted = true; };
		await expect(simulateFile({
			gateway, sourcePath: "0:/gcodes/test.gcode", sleep, signal,
			pollStatus: pollSequence(
				{ status: "idle", lastDurationSeconds: null },
				{ status: "simulating", lastDurationSeconds: null },
			),
		})).rejects.toThrow(SimulationCancelledError);
	});

	it("times out if the machine never leaves \"simulating\"", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const gateway = new FakeGateway();
			let elapsed = 0;
			const sleep = async (ms: number) => {
				elapsed += ms;
				vi.setSystemTime(elapsed);
			};
			let calls = 0;
			await expect(simulateFile({
				gateway, sourcePath: "0:/gcodes/test.gcode", sleep,
				pollIntervalMs: 1000, timeoutMs: 5000,
				// The pre-check (call 0) must see "idle" or this would be refused instead of timing
				// out; every poll after M37 is sent reports "simulating" forever
				pollStatus: () => ({ status: calls++ === 0 ? "idle" : "simulating", lastDurationSeconds: null }),
			})).rejects.toThrow(SimulationTimedOutError);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not time out just because the machine never entered \"simulating\" quickly, as long as it eventually does", async () => {
		const gateway = new FakeGateway();
		const seconds = await simulateFile({
			gateway, sourcePath: "0:/gcodes/test.gcode", sleep: NO_WAIT,
			pollStatus: pollSequence(
				{ status: "idle", lastDurationSeconds: null },
				{ status: "idle", lastDurationSeconds: null }, // RRF hasn't processed the M37 yet
				{ status: "simulating", lastDurationSeconds: null },
				{ status: "idle", lastDurationSeconds: 10 },
			),
		});
		expect(seconds).toBe(10);
	});
});
