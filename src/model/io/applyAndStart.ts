/**
 * Applies a recipe and, once the result is safely on the SD card, starts it printing — `M32`,
 * RepRapFirmware's own "select and start" command. Verified before writing this
 * (`C:\Users\live\Documents\Github\RRFBuild\RepRapFirmware\src\GCodes\GCodes2.cpp`, the M-code `case
 * 32` block, "Select file and start SD print"): it refuses outright if a file is already printing,
 * `FileGCode()->IsDoingFile()` — the same thing `BUSY_STATES` exists to catch client-side, for a
 * clearer message than whatever `M32`'s own refusal reply would read.
 *
 * **Never on a dry run.** A dry run's diff is a preview of what *would* be written; starting a print
 * of a file that was only previewed, not actually applied, would run something the user never
 * confirmed. `processFile`'s own `dryRun` flag already governs whether anything is written — this
 * refuses even earlier, before spending any time on it, when it is set.
 *
 * `checkSafety` (`io/plan.ts`) is not called again here — applying a recipe already goes through it
 * at the UI layer, exactly as a plain "Apply" does. This only adds the one check specific to
 * *starting*: the machine must still not be busy at the moment `M32` is about to be sent, which can
 * have changed since the safety check that gated the apply itself.
 */

import { BUSY_STATES } from "./plan";
import { processFile, type ProcessOptions, type ProcessResult } from "./transfer";

export class ApplyAndStartRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplyAndStartRefusedError";
	}
}

export interface ApplyAndStartOptions extends ProcessOptions {
	/** Reads the machine's current status — the same shape `io/simulate.ts` polls with. */
	machineStatus: () => string | null;
}

/**
 * Runs `processFile`, then sends `M32 "<the file's final path>"` if it completed (not cancelled).
 * Throws {@link ApplyAndStartRefusedError} before touching anything if this is a dry run or the
 * machine is already busy, and after applying if the machine refuses the `M32` itself.
 */
export async function applyAndStart(options: ApplyAndStartOptions): Promise<ProcessResult> {
	if (options.dryRun) {
		throw new ApplyAndStartRefusedError("Cannot start a dry run — apply for real first.");
	}
	const status = options.machineStatus();
	if (status !== null && BUSY_STATES.includes(status)) {
		throw new ApplyAndStartRefusedError(`The machine is ${status} — cannot start a new print now.`);
	}

	// A cancelled run throws CancelledError rather than resolving — propagates unmodified, so M32 is
	// never reached; the caller already knows how to treat that error from the plain "Apply" flow.
	const result = await processFile(options);

	const reply = await options.gateway.sendCode(`M32 "${result.targetPath}"`);
	if (/^Error:/i.test(reply.trim())) {
		throw new ApplyAndStartRefusedError(`The machine refused to start the print: ${reply.trim()}`);
	}
	return result;
}
