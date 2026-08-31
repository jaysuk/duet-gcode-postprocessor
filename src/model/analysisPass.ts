/**
 * A first, read-only pass over the file for a step that needs to know something about the whole
 * file before the transform pass reaches the line that needs it — a total to compute a percentage
 * against (`rewriteTime`), or, later, a tool change that has not happened yet to pre-heat ahead of
 * (task 06). The single forward transform pass cannot see forward at all; this gives a step exactly
 * one look ahead, over the same already-downloaded Blob, before the real pass starts.
 *
 * Pure: no I/O here. `io/transfer.ts`'s `forEachLine` drives the chunked read; this module only
 * knows how to turn one line into machine state and hand it to whichever collectors are running.
 * Opt-in per run — `processFile` only builds an `AnalysisRunner` when some enabled step's
 * `analysis()` actually returned a collector, so the common recipe pays nothing extra.
 */

import { createLineContext, syncLineContext, type MutableLineContext } from "./pipeline";
import { emptyMetadata, type SlicerMetadata } from "./gcode/metadata";
import { advance, createState, type MachineState } from "./gcode/state";
import { tokenise } from "./gcode/tokenise";
import type { LineContext } from "./steps/types";

/** Accumulates something from a first read of the file. Pure: no I/O, no DWC. */
export interface AnalysisCollector<T = unknown> {
	readonly id: string;
	onLine(ctx: LineContext, line: string): void;
	result(): T;
}

export interface AnalysisPassOptions {
	collectors: Array<AnalysisCollector>;
	meta?: SlicerMetadata;
	/** Total source size in bytes; drives `LineContext.progress` the same way the transform pass
	 *  computes it, so a collector sees the same numbers a step's `onLine` would. */
	totalBytes?: number | null;
}

/**
 * Drives every collector over the file with exactly the `LineContext` shape the transform pass will
 * later show the same line — same `MachineState` tracking, same layer/feature detection — built from
 * its own independent state, not the transform pass's (the two passes run one after the other, never
 * interleaved, so there is nothing to share).
 */
export class AnalysisRunner {
	private readonly state: MachineState;
	private readonly meta: SlicerMetadata;
	private readonly totalBytes: number | null;
	private readonly lineContext: MutableLineContext;
	private readonly collectors: Array<AnalysisCollector>;

	constructor(options: AnalysisPassOptions) {
		this.collectors = options.collectors;
		this.meta = options.meta ?? emptyMetadata();
		this.totalBytes = options.totalBytes ?? null;
		this.state = createState({ geometricFallback: !this.meta.hasLayerMarkers });
		this.lineContext = createLineContext(this.state, this.meta);
	}

	/** Process one source line. `byteOffset` feeds `LineContext.progress`; pass 0 when not known. */
	line(raw: string, byteOffset = 0): void {
		const token = tokenise(raw);
		advance(this.state, token);
		syncLineContext(this.lineContext, this.state, token, this.totalBytes, byteOffset);
		for (const collector of this.collectors) collector.onLine(this.lineContext, raw);
	}

	/** Every collector's result, keyed by its id. */
	result(): ReadonlyMap<string, unknown> {
		return new Map(this.collectors.map((c) => [c.id, c.result()]));
	}
}
