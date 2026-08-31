/**
 * The read-modify-write path.
 *
 * The only module in `model/` that is not pure, and even here the machine is behind a
 * {@link FileGateway} interface so the whole flow — including the backup, the temp-then-move and
 * the size verification — can be tested against an in-memory fake.
 *
 * Memory is the design constraint. A 200 MB G-code file decoded into one JavaScript string is
 * 400 MB of UTF-16 before anything has been transformed, so the file is read as a Blob and walked
 * in slices through a streaming decoder, with the output flushed into Blob parts as it goes. Peak
 * heap stays at roughly input + output + one chunk.
 *
 * Processing yields to the event loop between chunks. That keeps the UI responsive and Cancel
 * live without a Web Worker — which the plugin cannot have until the build inlines one, since the
 * bundle is a single IIFE with no dynamic import. See PLAN.md §3.2.
 */

import {
	BACKUP_DIR, BACKUP_INDEX, MAX_BACKUPS, METADATA_SCAN_BYTES, OUTPUT_FLUSH_BYTES, READ_CHUNK_BYTES,
} from "../constants";
import { Analyser, type FileAnalysis } from "../analysis";
import { addEntry, parseIndex, pruneIndex, serialiseIndex, type BackupEntry } from "./backups";
import { advance, createState } from "../gcode/state";
import { TimeEstimator, type MachineLimits } from "../gcode/timeModel";
import { tokenise } from "../gcode/tokenise";
import { parseMetadata, type SlicerMetadata } from "../gcode/metadata";
import { Pipeline, type DiffEntry, type RunStats } from "../pipeline";
import { alreadyProcessed, buildTransforms, findStamps, makeStamp, usesRewriteTime, type Recipe, type Stamp } from "../recipe";
import { backupCandidatePath, baseName, type OutputPlan } from "./plan";

export interface FileGateway {
	download(path: string, onProgress?: (loaded: number, total: number) => void): Promise<Blob>;
	upload(path: string, content: Blob, onProgress?: (loaded: number, total: number) => void): Promise<void>;
	move(from: string, to: string, force: boolean): Promise<void>;
	remove(path: string): Promise<void>;
	makeDirectory(path: string): Promise<void>;
	/** Size in bytes of a file, or null when it does not exist. */
	sizeOf(path: string): Promise<number | null>;
}

/** How long the pipeline may run before handing the event loop back (roughly one frame). */
const YIELD_INTERVAL_MS = 16;

export type Phase = "downloading" | "scanning" | "processing" | "uploading" | "finalising" | "done";

export interface ProgressUpdate {
	phase: Phase;
	/** 0..1 within the current phase, or null when indeterminate. */
	fraction: number | null;
	detail?: string;
}

export interface AbortSignalLike {
	aborted: boolean;
}

export interface ProcessOptions {
	gateway: FileGateway;
	sourcePath: string;
	recipe: Recipe;
	plan: OutputPlan;
	pluginVersion: string;
	scriptsTrusted: boolean;
	/** Dry run: everything is computed, nothing is written. */
	dryRun: boolean;
	/** Also collect a full analysis of the *source* during the same pass. */
	analyse?: boolean;
	/** This machine's motion limits. Only consulted when the recipe enables `rewriteTime`, which
	 *  cannot recompute M73 markers without them. */
	limits?: MachineLimits;
	onProgress?: (update: ProgressUpdate) => void;
	signal?: AbortSignalLike;
	/** Injected for tests. */
	now?: Date;
	/** Read granularity; defaults to READ_CHUNK_BYTES. Small values are used by the tests to
	 *  exercise every chunk boundary, which is where a streaming decoder breaks if it is going to. */
	chunkBytes?: number;
}

export interface ProcessResult {
	stats: RunStats;
	diff: Array<DiffEntry>;
	analysis: FileAnalysis | null;
	meta: SlicerMetadata;
	existingStamp: Stamp | null;
	targetPath: string;
	backupPath: string | null;
	bytesIn: number;
	bytesOut: number;
	durationMs: number;
	dryRun: boolean;
	/** Set when the run stopped early because the caller cancelled. */
	cancelled: boolean;
}

export class CancelledError extends Error {
	constructor() {
		super("Cancelled");
		this.name = "CancelledError";
	}
}

/** Read just enough of a file to identify the slicer and spot an existing stamp. */
export async function prescan(blob: Blob): Promise<{ head: string; tail: string; meta: SlicerMetadata }> {
	const head = await blob.slice(0, Math.min(METADATA_SCAN_BYTES, blob.size)).text();
	const tail = blob.size > METADATA_SCAN_BYTES
		? await blob.slice(Math.max(0, blob.size - METADATA_SCAN_BYTES)).text()
		: head;
	return { head, tail, meta: parseMetadata(head, tail) };
}

/**
 * A dedicated forward walk over the already-downloaded blob to total the model's time estimate and
 * count the M73 markers, *before* the main transform pass reaches the first one — `rewriteTime`
 * cannot give its first marker a percentage without knowing the whole file's total first.
 *
 * This duplicates the chunked-read loop below rather than sharing it; task 05 generalises this exact
 * problem (a step needing a first look at the whole file) into a proper collector-based second pass
 * and this will be one of the things it folds in, not a pattern to extend for a second consumer.
 */
async function estimateRewriteTimeTotals(
	blob: Blob,
	limits: MachineLimits,
	chunkBytes: number,
	checkCancelled: () => void,
): Promise<{ totalSeconds: number; markerCount: number }> {
	const state = createState();
	const estimator = new TimeEstimator(limits);
	let markerCount = 0;

	const decoder = new TextDecoder("utf-8");
	let carry = "";
	let offset = 0;
	let lastYield = Date.now();

	const consume = (rawLine: string): void => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const token = tokenise(line);
		advance(state, token);
		estimator.line(token, state);
		if (token.letter === "M" && token.code === "M73") markerCount++;
	};

	while (offset < blob.size) {
		checkCancelled();
		const end = Math.min(offset + chunkBytes, blob.size);
		const lastChunk = end >= blob.size;
		const text = carry + decoder.decode(await blob.slice(offset, end).arrayBuffer(), { stream: !lastChunk });
		const lines = text.split("\n");
		carry = lastChunk ? "" : (lines.pop() ?? "");
		if (lastChunk && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		for (const rawLine of lines) consume(rawLine);
		offset = end;
		if (Date.now() - lastYield >= YIELD_INTERVAL_MS) {
			await yieldToUi();
			lastYield = Date.now();
		}
	}
	if (carry !== "") consume(carry);

	return { totalSeconds: estimator.elapsed, markerCount };
}

/**
 * Download, transform and (unless this is a dry run) write back.
 *
 * Order of operations when writing: backup first, then upload to a temp name, then move onto the
 * target, then verify the size. Every step before the move leaves the original file untouched, so
 * an interruption at any point is recoverable.
 */
export async function processFile(options: ProcessOptions): Promise<ProcessResult> {
	const started = Date.now();
	const { gateway, sourcePath, recipe, plan, signal } = options;
	const report = options.onProgress ?? (() => { });
	const checkCancelled = () => {
		if (signal?.aborted === true) throw new CancelledError();
	};

	report({ phase: "downloading", fraction: 0 });
	const blob = await gateway.download(sourcePath, (loaded, total) => {
		report({ phase: "downloading", fraction: total > 0 ? loaded / total : null });
	});
	checkCancelled();

	report({ phase: "scanning", fraction: null });
	const { head, meta } = await prescan(blob);
	const existingStamp = alreadyProcessed(head, recipe);

	// rewriteTime needs the whole file's total time before its first marker — see
	// estimateRewriteTimeTotals for why this cannot be folded into the main pass below
	let rewriteTimeTotals: { totalSeconds: number; markerCount: number } | null = null;
	if (usesRewriteTime(recipe) && options.limits !== undefined) {
		report({ phase: "scanning", fraction: 0 });
		rewriteTimeTotals = await estimateRewriteTimeTotals(
			blob, options.limits, Math.max(1, options.chunkBytes ?? READ_CHUNK_BYTES), checkCancelled,
		);
		checkCancelled();
	}

	const transforms = buildTransforms(recipe, {
		scriptsTrusted: options.scriptsTrusted,
		machineLimits: options.limits,
		totalEstimatedSeconds: rewriteTimeTotals?.totalSeconds ?? null,
		totalMarkerCount: rewriteTimeTotals?.markerCount ?? 0,
	});
	const pipeline = new Pipeline({
		transforms,
		meta,
		sourcePath,
		totalBytes: blob.size,
		stampLine: options.dryRun ? null : makeStamp(recipe, options.pluginVersion, options.now),
	});
	const analyser = options.analyse === true ? new Analyser(meta) : null;

	const parts: Array<BlobPart> = [];
	let buffer: Array<string> = [];
	let bufferBytes = 0;
	const collect = !options.dryRun;

	const emit = (line: string): void => {
		if (!collect) return;
		buffer.push(line);
		bufferBytes += line.length + 1;
		if (bufferBytes >= OUTPUT_FLUSH_BYTES) {
			parts.push(buffer.join("\n") + "\n");
			buffer = [];
			bufferBytes = 0;
		}
	};

	for (const line of pipeline.begin()) emit(line);

	report({ phase: "processing", fraction: 0 });
	const decoder = new TextDecoder("utf-8");
	const chunkBytes = Math.max(1, options.chunkBytes ?? READ_CHUNK_BYTES);
	let carry = "";
	let offset = 0;
	let lastYield = Date.now();

	while (offset < blob.size) {
		checkCancelled();
		const end = Math.min(offset + chunkBytes, blob.size);
		const buf = await blob.slice(offset, end).arrayBuffer();
		const lastChunk = end >= blob.size;
		// stream:true keeps a multi-byte character that straddles the slice boundary intact
		const text = carry + decoder.decode(buf, { stream: !lastChunk });
		const lines = text.split("\n");
		// The last element is a partial line unless this was the final chunk
		carry = lastChunk ? "" : (lines.pop() ?? "");
		// On the final chunk a trailing newline leaves an empty last element that is an artefact of
		// the separator rather than a line of the file. Emitting it would add a blank line on every
		// run — exactly the kind of silent drift that makes repeated processing untrustworthy
		if (lastChunk && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

		let lineOffset = offset;
		for (const rawLine of lines) {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			analyser?.line(line);
			const result = pipeline.line(line, lineOffset);
			lineOffset += rawLine.length + 1;
			if (result === null) continue;
			if (typeof result === "string") emit(result);
			else for (const l of result) emit(l);
		}

		offset = end;
		report({ phase: "processing", fraction: blob.size > 0 ? offset / blob.size : null });
		// Yield on a time budget rather than once per chunk: with production-sized chunks that is
		// every chunk anyway, but it stops a small-chunk run (or a tiny file) spending all its time
		// bouncing off the event loop
		if (Date.now() - lastYield >= YIELD_INTERVAL_MS) {
			await yieldToUi();
			lastYield = Date.now();
		}
	}

	if (carry !== "") {
		const line = carry.endsWith("\r") ? carry.slice(0, -1) : carry;
		analyser?.line(line);
		const result = pipeline.line(line, offset);
		if (result !== null) {
			if (typeof result === "string") emit(result);
			else for (const l of result) emit(l);
		}
	}
	for (const line of pipeline.end()) emit(line);
	if (buffer.length > 0) parts.push(buffer.join("\n") + "\n");

	const result: ProcessResult = {
		stats: pipeline.stats,
		diff: pipeline.diff,
		analysis: analyser?.result() ?? null,
		meta,
		existingStamp,
		targetPath: plan.targetPath,
		backupPath: null,
		bytesIn: blob.size,
		bytesOut: 0,
		durationMs: Date.now() - started,
		dryRun: options.dryRun,
		cancelled: false,
	};

	if (options.dryRun) {
		report({ phase: "done", fraction: 1 });
		result.durationMs = Date.now() - started;
		return result;
	}

	const output = new Blob(parts, { type: "text/plain" });
	result.bytesOut = output.size;
	checkCancelled();

	// Backup before anything can overwrite the original
	if (plan.backupNaming !== null) {
		report({ phase: "finalising", fraction: null, detail: "Backing up the original" });
		const backupPath = await resolveUniqueBackupPath(gateway, plan.backupNaming);
		await gateway.makeDirectory(dirOf(backupPath));
		await gateway.upload(backupPath, blob);
		result.backupPath = backupPath;

		// The backup itself is already safely on the card at this point, so a failure updating the
		// index (a corrupt read, an upload that drops) must not fail the run — it is recorded as a
		// warning instead, since the backup still exists even if this run cannot find it later
		try {
			await updateBackupIndex(gateway, {
				file: baseName(backupPath),
				originalPath: sourcePath,
				at: (options.now ?? new Date()).toISOString(),
				bytes: blob.size,
				recipe: recipe.name,
			});
		} catch (e) {
			result.stats.warnings.push(`Could not update the backup index: ${(e as Error).message}`);
		}
	}

	report({ phase: "uploading", fraction: 0 });
	await gateway.upload(plan.tempPath, output, (loaded, total) => {
		report({ phase: "uploading", fraction: total > 0 ? loaded / total : null });
	});

	report({ phase: "finalising", fraction: null, detail: "Putting the file into place" });
	await gateway.move(plan.tempPath, plan.targetPath, true);

	const written = await gateway.sizeOf(plan.targetPath);
	if (written !== null && Math.abs(written - output.size) > 0) {
		throw new Error(
			`Verification failed: ${plan.targetPath} is ${written} bytes but ${output.size} were written.` +
			(result.backupPath === null ? "" : ` The original is still at ${result.backupPath}.`),
		);
	}

	report({ phase: "done", fraction: 1 });
	result.durationMs = Date.now() - started;
	return result;
}

function dirOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(0, index);
}

/**
 * Try successive suffixed backup names until one is free, so two files with the same stem backed up
 * from different folders in the same second do not silently overwrite one another — the plain name
 * alone collides in exactly that case, and losing a backup is the failure this feature exists to
 * prevent. Capped rather than unbounded, so a gateway that always reports a name as taken cannot
 * hang a run; falling back to the last candidate tried is still far better than failing the write.
 */
async function resolveUniqueBackupPath(
	gateway: FileGateway,
	naming: { stem: string; ts: string; ext: string },
): Promise<string> {
	const MAX_ATTEMPTS = 1000;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const candidate = backupCandidatePath(naming.stem, naming.ts, naming.ext, attempt);
		const size = await gateway.sizeOf(candidate);
		if (size === null) return candidate;
	}
	return backupCandidatePath(naming.stem, naming.ts, naming.ext, MAX_ATTEMPTS - 1);
}

/**
 * Record a new backup in the index, pruning the oldest once there are more than {@link MAX_BACKUPS}.
 * The new index is uploaded BEFORE any pruned file is deleted — losing the index and the files it
 * described together is much worse than leaving an orphaned backup file behind.
 */
async function updateBackupIndex(gateway: FileGateway, entry: BackupEntry): Promise<void> {
	let existingText = "";
	try {
		existingText = await (await gateway.download(BACKUP_INDEX)).text();
	} catch {
		// No index yet — the common case on first use; treat it as empty rather than a failure
	}

	const index = addEntry(parseIndex(existingText), entry);
	const { keep, drop } = pruneIndex(index, MAX_BACKUPS);
	await gateway.upload(BACKUP_INDEX, new Blob([serialiseIndex(keep)], { type: "application/json" }));

	for (const dropped of drop) {
		try {
			await gateway.remove(`${BACKUP_DIR}/${dropped.file}`);
		} catch {
			// Already gone is not an error
		}
	}
}

/**
 * Hand the event loop back so the UI can paint and the Cancel button can be clicked. setTimeout(0)
 * rather than a microtask: a microtask would run before rendering and defeat the point.
 */
export function yieldToUi(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Read a file and analyse it without transforming anything — what the inspector runs.
 *
 * Shares the same chunked reader and yield cadence as {@link processFile}, so a 200 MB file is
 * inspected without ever holding its text.
 */
export async function inspectFile(options: {
	gateway: FileGateway;
	sourcePath: string;
	onProgress?: (update: ProgressUpdate) => void;
	signal?: AbortSignalLike;
	chunkBytes?: number;
	limits?: MachineLimits;
}): Promise<{ analysis: FileAnalysis; meta: SlicerMetadata; stamps: Array<Stamp>; head: string; bytes: number }> {
	const report = options.onProgress ?? (() => { });
	const checkCancelled = () => {
		if (options.signal?.aborted === true) throw new CancelledError();
	};

	report({ phase: "downloading", fraction: 0 });
	const blob = await options.gateway.download(options.sourcePath, (loaded, total) => {
		report({ phase: "downloading", fraction: total > 0 ? loaded / total : null });
	});
	checkCancelled();

	report({ phase: "scanning", fraction: null });
	const { head, meta } = await prescan(blob);
	const analyser = new Analyser(meta, options.limits);

	const decoder = new TextDecoder("utf-8");
	const chunkBytes = Math.max(1, options.chunkBytes ?? READ_CHUNK_BYTES);
	let carry = "";
	let offset = 0;
	let lastYield = Date.now();

	while (offset < blob.size) {
		checkCancelled();
		const end = Math.min(offset + chunkBytes, blob.size);
		const lastChunk = end >= blob.size;
		const text = carry + decoder.decode(await blob.slice(offset, end).arrayBuffer(), { stream: !lastChunk });
		const lines = text.split("\n");
		carry = lastChunk ? "" : (lines.pop() ?? "");
		if (lastChunk && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		for (const rawLine of lines) {
			analyser.line(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
		}
		offset = end;
		report({ phase: "processing", fraction: blob.size > 0 ? offset / blob.size : null });
		if (Date.now() - lastYield >= YIELD_INTERVAL_MS) {
			await yieldToUi();
			lastYield = Date.now();
		}
	}
	if (carry !== "") analyser.line(carry.endsWith("\r") ? carry.slice(0, -1) : carry);

	report({ phase: "done", fraction: 1 });
	return { analysis: analyser.result(), meta, stamps: findStamps(head), head, bytes: blob.size };
}
