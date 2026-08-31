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
import { AnalysisRunner } from "../analysisPass";
import { Analyser, type FileAnalysis } from "../analysis";
import { addEntry, parseIndex, pruneIndex, serialiseIndex, type BackupEntry } from "./backups";
import type { MachineLimits } from "../gcode/timeModel";
import { parseMetadata, type SlicerMetadata } from "../gcode/metadata";
import { Pipeline, type DiffEntry, type RunStats } from "../pipeline";
import type { ToolConfig } from "../preheat";
import { alreadyProcessed, buildTransforms, collectorsFor, findStamps, makeStamp, type Recipe, type Stamp } from "../recipe";
import type { StepFactoryContext } from "../steps/types";
import { backupCandidatePath, baseName, type OutputPlan } from "./plan";

export interface AbortSignalLike {
	aborted: boolean;
}

export class CancelledError extends Error {
	constructor() {
		super("Cancelled");
		this.name = "CancelledError";
	}
}

/** How long the pipeline may run before handing the event loop back (roughly one frame). */
const YIELD_INTERVAL_MS = 16;

/**
 * Walk a Blob in decoded-line chunks: the one chunked-read loop every pass over a downloaded file
 * shares — `processFile`'s transform pass, the analysis pass, `inspectFile`, and the `rewriteTime`
 * pre-pass all drive this instead of copying it. It existed three times before this extraction and a
 * bug (the trailing-newline handling, the `stream: !lastChunk` decode flag) had already been fixed in
 * two of them and not the third — the reason this exists at all.
 *
 * `byteOffset` handed to `onLine` is the byte position of the *chunk* a line came from, not the
 * line's own exact position (a line that started inside the previous chunk's carried-over partial
 * text is still attributed to the current chunk's start) — good enough for the `percent` insertion
 * anchor's progress fraction, which is all that has ever consumed it; do not rely on it for anything
 * needing byte-exact positions.
 */
export async function forEachLine(
	blob: Blob,
	onLine: (line: string, byteOffset: number) => void,
	options: { chunkBytes?: number; signal?: AbortSignalLike; onProgress?: (fraction: number | null) => void } = {},
): Promise<void> {
	const checkCancelled = () => {
		if (options.signal?.aborted === true) throw new CancelledError();
	};
	const reportProgress = options.onProgress ?? (() => { });

	const decoder = new TextDecoder("utf-8");
	const chunkBytes = Math.max(1, options.chunkBytes ?? READ_CHUNK_BYTES);
	let carry = "";
	let offset = 0;
	let lastYield = Date.now();

	while (offset < blob.size) {
		checkCancelled();
		const end = Math.min(offset + chunkBytes, blob.size);
		const lastChunk = end >= blob.size;
		// stream:true keeps a multi-byte character that straddles the slice boundary intact
		const text = carry + decoder.decode(await blob.slice(offset, end).arrayBuffer(), { stream: !lastChunk });
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
			onLine(line, lineOffset);
			lineOffset += rawLine.length + 1;
		}

		offset = end;
		reportProgress(blob.size > 0 ? offset / blob.size : null);
		// Yield on a time budget rather than once per chunk: with production-sized chunks that is
		// every chunk anyway, but it stops a small-chunk run (or a tiny file) spending all its time
		// bouncing off the event loop
		if (Date.now() - lastYield >= YIELD_INTERVAL_MS) {
			await yieldToUi();
			lastYield = Date.now();
		}
	}

	if (carry !== "") {
		onLine(carry.endsWith("\r") ? carry.slice(0, -1) : carry, offset);
	}
}

export interface FileGateway {
	download(path: string, onProgress?: (loaded: number, total: number) => void): Promise<Blob>;
	upload(path: string, content: Blob, onProgress?: (loaded: number, total: number) => void): Promise<void>;
	move(from: string, to: string, force: boolean): Promise<void>;
	remove(path: string): Promise<void>;
	makeDirectory(path: string): Promise<void>;
	/** Size in bytes of a file, or null when it does not exist. */
	sizeOf(path: string): Promise<number | null>;
}

export type Phase = "downloading" | "scanning" | "analysing" | "processing" | "uploading" | "finalising" | "done";

export interface ProgressUpdate {
	phase: Phase;
	/** 0..1 within the current phase, or null when indeterminate. */
	fraction: number | null;
	detail?: string;
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
	/** Per-tool heater configuration. Only consulted by `preheat`, which cannot estimate a heat-up
	 *  time without each tool's active/standby temperatures and tuned `M307` model. */
	toolHeaters?: Array<ToolConfig>;
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
	/** Milliseconds spent in the analysis pass, or null when no enabled step needed one — a two-pass
	 *  recipe's extra cost should be visible, not folded silently into `durationMs`. */
	analysisMs: number | null;
	/** Milliseconds spent walking the file for the transform pass (download, backup and upload are
	 *  not included). */
	transformMs: number;
	dryRun: boolean;
	/** Set when the run stopped early because the caller cancelled. */
	cancelled: boolean;
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

	const factoryCtx: StepFactoryContext = {
		scriptsTrusted: options.scriptsTrusted,
		machineLimits: options.limits,
		toolHeaters: options.toolHeaters,
	};

	// A second pass over the same already-downloaded blob, for any step that needs to see a fact
	// about the whole file before the transform pass reaches the line that needs it — skipped
	// entirely when no enabled step asked for one, so the common recipe pays nothing extra
	const collectors = collectorsFor(recipe, factoryCtx);
	let analysisResults: ReadonlyMap<string, unknown> = new Map();
	let analysisMs: number | null = null;
	if (collectors.length > 0) {
		const analysisStarted = Date.now();
		report({ phase: "analysing", fraction: 0 });
		const runner = new AnalysisRunner({ collectors, meta, totalBytes: blob.size });
		await forEachLine(blob, (line, byteOffset) => { runner.line(line, byteOffset); }, {
			chunkBytes: options.chunkBytes,
			signal,
			onProgress: (fraction) => { report({ phase: "analysing", fraction }); },
		});
		checkCancelled();
		analysisResults = runner.result();
		analysisMs = Date.now() - analysisStarted;
	}

	const transforms = buildTransforms(recipe, factoryCtx);
	const pipeline = new Pipeline({
		transforms,
		meta,
		sourcePath,
		totalBytes: blob.size,
		stampLine: options.dryRun ? null : makeStamp(recipe, options.pluginVersion, options.now),
		analysisResults,
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

	const transformStarted = Date.now();
	report({ phase: "processing", fraction: 0 });
	await forEachLine(blob, (line, lineOffset) => {
		analyser?.line(line);
		const result = pipeline.line(line, lineOffset);
		if (result === null) return;
		if (typeof result === "string") emit(result);
		else for (const l of result) emit(l);
	}, {
		chunkBytes: options.chunkBytes,
		signal,
		onProgress: (fraction) => { report({ phase: "processing", fraction }); },
	});
	const transformMs = Date.now() - transformStarted;

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
		analysisMs,
		transformMs,
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

	await forEachLine(blob, (line) => { analyser.line(line); }, {
		chunkBytes: options.chunkBytes,
		signal: options.signal,
		onProgress: (fraction) => { report({ phase: "processing", fraction }); },
	});

	report({ phase: "done", fraction: 1 });
	return { analysis: analyser.result(), meta, stamps: findStamps(head), head, bytes: blob.size };
}
