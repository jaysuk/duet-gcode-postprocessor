/**
 * The pipeline: drives lines through the recipe's transforms, tracks machine state once, and
 * collects the statistics and diff that the preview is built from.
 *
 * It is deliberately synchronous and push-driven (`begin()` / `line()` per source line / `end()`)
 * rather than an async iterator, because the caller is a chunked Blob reader that already owns the
 * scheduling and the cancellation. That also makes the whole thing testable with a string in and a
 * string out, with no I/O anywhere near it.
 */

import { emptyMetadata, type SlicerMetadata } from "./gcode/metadata";
import { advance, createState, type MachineState } from "./gcode/state";
import { tokenise, type Tokenised } from "./gcode/tokenise";
import type { LineContext, RunContext, Transform } from "./steps/types";

export interface DiffEntry {
	/** 1-based source line number. */
	lineNo: number;
	/** The original line, or null for a pure insertion. */
	before: string | null;
	/** The replacement lines, or null when the line was deleted. */
	after: Array<string> | null;
}

export interface RunStats {
	linesIn: number;
	linesOut: number;
	/** Source lines whose text changed (not counting pure insertions or deletions). */
	linesChanged: number;
	linesAdded: number;
	linesRemoved: number;
	bytesIn: number;
	bytesOut: number;
	/** How many source lines each step touched, keyed by step index. */
	perStep: Array<number>;
	warnings: Array<string>;
	/** True when the diff was capped and is therefore incomplete. */
	diffTruncated: boolean;
}

export interface PipelineOptions {
	transforms: Array<Transform>;
	meta?: SlicerMetadata;
	sourcePath?: string;
	/** Total source size in bytes; enables the `percent` anchor and progress reporting. */
	totalBytes?: number | null;
	/** Emitted as the very first line of the output when set. */
	stampLine?: string | null;
	/** Stop recording individual changes past this many entries. Default 2000. */
	maxDiffEntries?: number;
	/** Results from a prior analysis pass (see `analysisPass.ts`), keyed by collector id. Empty when
	 *  no pass ran. */
	analysisResults?: ReadonlyMap<string, unknown>;
}

const DEFAULT_MAX_DIFF = 2000;
const EMPTY_ANALYSIS: ReadonlyMap<string, unknown> = new Map();

export class Pipeline {
	readonly stats: RunStats;
	readonly diff: Array<DiffEntry> = [];

	private readonly transforms: Array<Transform>;
	private readonly state: MachineState;
	private readonly meta: SlicerMetadata;
	private readonly totalBytes: number | null;
	private readonly stampLine: string | null;
	private readonly maxDiffEntries: number;
	private readonly runContext: RunContext;
	private readonly lineContext: MutableLineContext;

	constructor(options: PipelineOptions) {
		this.transforms = options.transforms;
		this.meta = options.meta ?? emptyMetadata();
		this.totalBytes = options.totalBytes ?? null;
		this.stampLine = options.stampLine ?? null;
		this.maxDiffEntries = options.maxDiffEntries ?? DEFAULT_MAX_DIFF;
		// The pre-scan already knows whether this file carries layer markers, so the state machine
		// never has to guess on a file that has real ones
		this.state = createState({ geometricFallback: !this.meta.hasLayerMarkers });

		this.stats = {
			linesIn: 0, linesOut: 0, linesChanged: 0, linesAdded: 0, linesRemoved: 0,
			bytesIn: 0, bytesOut: 0,
			perStep: this.transforms.map(() => 0),
			warnings: [],
			diffTruncated: false,
		};

		const stats = this.stats;
		this.runContext = {
			meta: this.meta,
			sourcePath: options.sourcePath ?? "",
			totalLayers: this.meta.totalLayers,
			analysis: options.analysisResults ?? EMPTY_ANALYSIS,
			warn(message: string) {
				if (!stats.warnings.includes(message)) stats.warnings.push(message);
			},
		};

		// One context object, mutated per line. Allocating a fresh one per line would add several
		// million short-lived objects to a large run for no benefit — steps must not retain it
		this.lineContext = createLineContext(this.state, this.meta);
	}

	/** Lines to write before the first source line. */
	begin(): Array<string> {
		const out: Array<string> = [];
		if (this.stampLine !== null) out.push(this.stampLine);
		for (const transform of this.transforms) {
			const emitted = transform.onStart?.(this.runContext);
			if (Array.isArray(emitted)) out.push(...emitted);
		}
		this.stats.linesAdded += out.length;
		this.stats.linesOut += out.length;
		return out;
	}

	/**
	 * Process one source line. `byteOffset` is the offset of this line in the source and is only
	 * used for progress-based anchors; pass 0 when it is not known.
	 */
	line(raw: string, byteOffset = 0): string | Array<string> | null {
		this.stats.linesIn++;
		this.stats.bytesIn += raw.length + 1;

		const token = tokenise(raw);
		advance(this.state, token);
		this.syncContext(token, byteOffset);

		let current: string | Array<string> | null = raw;
		for (let i = 0; i < this.transforms.length; i++) {
			if (current === null) break;
			const result = applyToAll(this.transforms[i], this.lineContext, current);
			if (result !== undefined) {
				this.stats.perStep[i]++;
				current = result;
			}
		}

		this.record(raw, current);
		return current;
	}

	/** Lines to write after the last source line. */
	end(): Array<string> {
		const out: Array<string> = [];
		for (const transform of this.transforms) {
			const emitted = transform.onEnd?.(this.runContext);
			if (Array.isArray(emitted)) out.push(...emitted);
		}
		this.stats.linesAdded += out.length;
		this.stats.linesOut += out.length;
		for (const line of out) this.stats.bytesOut += line.length + 1;
		return out;
	}

	private syncContext(token: Tokenised, byteOffset: number): void {
		syncLineContext(this.lineContext, this.state, token, this.totalBytes, byteOffset);
	}

	private record(raw: string, current: string | Array<string> | null): void {
		const stats = this.stats;
		if (current === null) {
			stats.linesRemoved++;
			this.pushDiff({ lineNo: stats.linesIn, before: raw, after: null });
			return;
		}
		if (typeof current === "string") {
			stats.linesOut++;
			stats.bytesOut += current.length + 1;
			if (current !== raw) {
				stats.linesChanged++;
				this.pushDiff({ lineNo: stats.linesIn, before: raw, after: [current] });
			}
			return;
		}
		stats.linesOut += current.length;
		for (const line of current) stats.bytesOut += line.length + 1;
		// The original may or may not still be in the emitted set; count the difference as added
		const kept = current.includes(raw);
		stats.linesAdded += current.length - (kept ? 1 : 0);
		if (!kept) stats.linesChanged++;
		this.pushDiff({ lineNo: stats.linesIn, before: raw, after: current });
	}

	private pushDiff(entry: DiffEntry): void {
		if (this.diff.length >= this.maxDiffEntries) {
			this.stats.diffTruncated = true;
			return;
		}
		this.diff.push(entry);
	}
}

/** Mutable shape behind the read-only LineContext the steps see. */
export type MutableLineContext = {
	-readonly [K in keyof LineContext]: LineContext[K];
};

/**
 * A fresh, mutated-in-place `LineContext`. Shared by `Pipeline` and `AnalysisRunner` (in
 * `analysisPass.ts`) so both passes build the exact same shape from the same `MachineState` and
 * metadata — a step's `onLine` and a collector's `onLine` must agree about what "this line" means.
 */
export function createLineContext(state: MachineState, meta: SlicerMetadata): MutableLineContext {
	return Object.assign(Object.create(null) as MutableLineContext, state, {
		token: tokenise(""),
		meta,
		totalLayers: meta.totalLayers,
		progress: null as number | null,
	});
}

/** Update a `LineContext` (built by {@link createLineContext}) for one newly-advanced line. */
export function syncLineContext(
	ctx: MutableLineContext,
	state: MachineState,
	token: Tokenised,
	totalBytes: number | null,
	byteOffset: number,
): void {
	ctx.lineNo = state.lineNo;
	ctx.layer = state.layer;
	ctx.z = state.z;
	ctx.tool = state.tool;
	ctx.feedrate = state.feedrate;
	ctx.relativeMoves = state.relativeMoves;
	ctx.relativeE = state.relativeE;
	ctx.object = state.object;
	ctx.featureType = state.featureType;
	ctx.layerChanged = state.layerChanged;
	ctx.sawLayerMarker = state.sawLayerMarker;
	ctx.token = token;
	ctx.progress = totalBytes !== null && totalBytes > 0 ? Math.min(1, byteOffset / totalBytes) : null;
}

/**
 * Run one transform over the current value, which may already be several lines because an earlier
 * step expanded it. Returns `undefined` when nothing changed, so the caller can keep the fast path.
 */
function applyToAll(
	transform: Transform,
	ctx: LineContext,
	current: string | Array<string>,
): string | Array<string> | null | undefined {
	if (typeof current === "string") {
		return transform.onLine(ctx, current);
	}

	let out: Array<string> | null = null;
	for (let i = 0; i < current.length; i++) {
		const result = transform.onLine(ctx, current[i]);
		if (result === undefined) {
			out?.push(current[i]);
			continue;
		}
		// First change: copy what came before it, then diverge
		out ??= current.slice(0, i);
		if (result === null) continue;
		if (typeof result === "string") out.push(result);
		else out.push(...result);
	}
	if (out === null) return undefined;
	return out.length === 0 ? null : out;
}

/**
 * Convenience wrapper: run a whole string through a pipeline and return the result. Used by the
 * unit tests and the golden-file suite; the real transfer path streams instead.
 */
export function runToString(options: PipelineOptions, input: string): { output: string; pipeline: Pipeline } {
	const pipeline = new Pipeline({ ...options, totalBytes: options.totalBytes ?? input.length });
	const out: Array<string> = [...pipeline.begin()];

	let offset = 0;
	const lines = input.split("\n");
	// A trailing newline produces a final empty element; processing it would append a spurious line
	const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	if (hasTrailingNewline) lines.pop();

	for (const rawLine of lines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const result = pipeline.line(line, offset);
		offset += rawLine.length + 1;
		if (result === null) continue;
		if (typeof result === "string") out.push(result);
		else out.push(...result);
	}
	out.push(...pipeline.end());

	return { output: out.join("\n") + (hasTrailingNewline ? "\n" : ""), pipeline };
}
