/**
 * The `M37` simulation round-trip: apply the file, let RepRapFirmware simulate it, read back its own
 * estimate — a number no slicer can offer, because it comes from the exact firmware that will run
 * the print. The first thing in this plugin that talks to the printer rather than only its file
 * system; `FileGateway.sendCode` exists for exactly this.
 *
 * **Verified, not assumed, before writing this** (`C:\Users\live\Documents\Github\RRFBuild\RepRapFirmware`
 * and `C:\Users\live\Documents\Github\ObjectModel`):
 *
 * - `SimulationMode::normal` (`GCodes/SimulationMode.h`) is "not generating steps, just timing" — RRF
 *   runs through the file at whatever speed its own G-code parsing loop can go, not in real time
 *   matching the eventual print. A multi-hour print simulates in a small fraction of that, not the
 *   print's own duration — the "blocks the machine for the print's length" risk the task that
 *   specified this worried about does not hold.
 * - Completion is directly observable: `state.status` (`ObjectModel/src/state/MachineStatus.ts`) has
 *   a dedicated `"simulating"` value, set for the duration and cleared once RRF's own
 *   `EndSimulation`/`StoppedPrint` runs (`GCodes.cpp`). `job.lastDuration` then holds the simulated
 *   seconds, and RRF also writes them into the file itself as `simulatedTime`
 *   (`GCodes.cpp`'s `RecordSimulationTime`, read back as `job.file.simulatedTime` once the file's
 *   info is rescanned) — belt and braces; this module uses `job.lastDuration` since it updates the
 *   moment simulation ends, without waiting for a rescan.
 * - The file must already be on the SD card, which it always is here — this plugin only ever offers
 *   `M37` for a file it just found by browsing the card in the first place.
 *
 * **Never on a busy machine.** Starting a simulation while the machine is already printing,
 * simulating, resuming or pausing (`io/plan.ts`'s own `BUSY_STATES`, shared rather than duplicated)
 * is refused before anything is sent — RRF's own print-job machinery cannot run two "prints"
 * (a real one and a simulated one) at once, and refusing client-side gives a clearer error than
 * whatever `M37` would come back with.
 */

import { BUSY_STATES } from "./plan";
import type { FileGateway } from "./transfer";

export class SimulationRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SimulationRefusedError";
	}
}

export class SimulationTimedOutError extends Error {
	constructor() {
		super("Timed out waiting for the simulation to finish.");
		this.name = "SimulationTimedOutError";
	}
}

export class SimulationCancelledError extends Error {
	constructor() {
		super("Simulation cancelled.");
		this.name = "SimulationCancelledError";
	}
}

export interface SimulationStatus {
	/** `state.status`, lower-cased, or null when not known. */
	status: string | null;
	/** `job.lastDuration` — seconds, once RepRapFirmware has finished the most recent job (real or
	 *  simulated). Null before that. */
	lastDurationSeconds: number | null;
}

export interface SimulateOptions {
	gateway: FileGateway;
	/** Absolute SD-card path, exactly as passed to `M37 P"..."`. */
	sourcePath: string;
	/** Reads whatever the caller's live object model currently says. `model/` never talks to a store
	 *  itself, so this is the seam — `dwc/` supplies the real implementation. */
	pollStatus: () => SimulationStatus;
	/** Sleeps between polls; injected so this is testable without real timers. Default: a real
	 *  `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/** Default 500. */
	pollIntervalMs?: number;
	/** Default 300_000 (5 minutes) — generous given simulation is not real-time, but still bounded:
	 *  a machine that never leaves "simulating" (disconnected, or RRF hung) must not wait forever. */
	timeoutMs?: number;
	signal?: { aborted: boolean };
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends `M37 P"<sourcePath>"`, waits for the machine to enter and then leave `"simulating"`, and
 * returns the simulated seconds from `job.lastDuration`. Throws {@link SimulationRefusedError} if the
 * machine is already busy, {@link SimulationCancelledError} if `signal.aborted` becomes true, and
 * {@link SimulationTimedOutError} if it never sees completion within `timeoutMs`.
 */
export async function simulateFile(options: SimulateOptions): Promise<number> {
	const {
		gateway, sourcePath, pollStatus, sleep = defaultSleep,
		pollIntervalMs = 500, timeoutMs = 300_000, signal,
	} = options;

	const before = pollStatus();
	if (before.status !== null && BUSY_STATES.includes(before.status)) {
		throw new SimulationRefusedError(`The machine is ${before.status} — cannot start a simulation now.`);
	}

	const reply = await gateway.sendCode(`M37 P"${sourcePath}"`);
	if (/^Error:/i.test(reply.trim())) {
		throw new SimulationRefusedError(`The machine refused to simulate: ${reply.trim()}`);
	}

	const deadline = Date.now() + timeoutMs;
	let sawSimulating = false;
	for (;;) {
		if (signal?.aborted) throw new SimulationCancelledError();

		const info = pollStatus();
		if (info.status === "simulating") sawSimulating = true;
		if (sawSimulating && info.status !== "simulating") {
			if (info.lastDurationSeconds === null) {
				throw new Error("Simulation finished but the machine reported no duration.");
			}
			return info.lastDurationSeconds;
		}

		if (Date.now() >= deadline) throw new SimulationTimedOutError();
		await sleep(pollIntervalMs);
	}
}
