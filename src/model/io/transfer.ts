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
	METADATA_SCAN_BYTES, OUTPUT_FLUSH_BYTES, READ_CHUNK_BYTES,
} from "../constants";
import { Analyser, type FileAnalysis } from "../analysis";
import { parseMetadata, type SlicerMetadata } from "../gcode/metadata";
import { Pipeline, type DiffEntry, type RunStats } from "../pipeline";
import { alreadyProcessed, buildTransforms, findStamps, makeStamp, type Recipe, type Stamp } from "../recipe";
import type { OutputPlan } from "./plan";

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

	const transforms = buildTransforms(recipe, { scriptsTrusted: options.scriptsTrusted });
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
	if (plan.backupPath !== null) {
		report({ phase: "finalising", fraction: null, detail: "Backing up the original" });
		await gateway.makeDirectory(dirOf(plan.backupPath));
		await gateway.upload(plan.backupPath, blob);
		result.backupPath = plan.backupPath;
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
	const analyser = new Analyser(meta);

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
