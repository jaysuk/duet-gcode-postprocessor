/**
 * Per-run orchestration for the sandboxed script engine: one real QuickJS VM for the life of a run,
 * the ported standard library (`vmStdlib.ts`) plus the user's own script evaluated into it once, and
 * a `runLine` entry point called once per line — matching the fast engine's own per-line shape
 * exactly, so the sandboxed engine is a drop-in replacement for it in `script.ts`.
 *
 * **This used to be chunked** (500 lines batched into one VM call) and that design was wrong in three
 * ways at once (task 14, Findings A and B): `Pipeline.end()` never feeds a transform's buffered
 * output through *later* transforms in the recipe, so the tail of every file silently skipped every
 * downstream step; every line in a flushed batch was evaluated against whichever line's `LineContext`
 * happened to close the batch, so layer-anchored downstream steps saw the wrong layer; and every
 * withheld line reported as a deletion (and every flushed line as an addition) in the dry-run diff and
 * statistics. None of that showed up in this module's own unit tests, because none of them drove a
 * sandboxed script through a real `Pipeline` with a downstream step — only in isolation.
 *
 * Chunking's original justification was a benchmark showing ~7.8µs/line for one call per line
 * against ~1.6µs/line batching 500 — but that benchmark used a `LineContext` with no slicer metadata
 * in it. A real file with 300 metadata keys (normal for PrusaSlicer/OrcaSlicer) re-serialised that
 * whole block on every line inside every chunk, at 17.5 KB/line, making the sandboxed engine 239×
 * slower than the fast one — badly enough that the default time budget aborted a do-nothing identity
 * script on an ordinary file. Hoisting the metadata into the VM once (`setMeta`, called from
 * `script.ts`'s `onStart`) removes that: the per-line payload is now a dozen scalars.
 *
 * **Measured cost after the fix: ~17× the fast engine**, not the ~2× an earlier draft of this comment
 * claimed by carrying over that same no-metadata benchmark. On a 20,000-line file with 300 metadata
 * keys: ~38µs/line end-to-end against the fast engine's ~2µs/line. Isolating the VM round trip:
 * ~6µs for a bare `newString`/`callFunction`/`getString`, ~26µs once the `{line, ctx}` payload is
 * JSON-marshalled in and the result JSON-marshalled back out. So **the four JSON operations per line
 * dominate, not the VM boundary itself** — roughly 20µs of the 26µs, about half of that the 12-field
 * ctx object. The armed interrupt handler costs nothing measurable. If this ever needs to be faster,
 * that JSON round trip is the thing to attack (marshal the ctx as individual VM values, or keep a
 * mutable ctx object inside the VM and push only changed fields) — but measure first, on a fixture
 * that has real metadata, because getting that wrong is the entire history of this file.
 */

import type { SlicerMetadata } from "../../gcode/metadata";
import type { LineContext } from "../types";
import { ScriptAbortError, StepConfigError } from "../types";
import { VM_STDLIB_SOURCE } from "./vmStdlib";
import type { QuickJsContextLike, QuickJsHandleLike, QuickJsModuleLike, QuickJsRuntimeLike } from "./loader";

/** The slicer metadata block, flattened once per run — never per line. The one honest API difference
 *  from the fast engine: `values` is a plain object here, not a `Map` — only marshallable values can
 *  cross the VM boundary at all. */
export interface SerialisedMeta {
	slicer: string;
	slicerVersion: string | null;
	totalLayers: number | null;
	layerHeight: number | null;
	filamentMm: number | null;
	printTimeSeconds: number | null;
	filamentDiameterMm: number | null;
	maxVolumetricSpeedMm3PerSec: number | null;
	values: Record<string, string>;
}

export function serialiseMeta(meta: SlicerMetadata): SerialisedMeta {
	return {
		slicer: meta.slicer,
		slicerVersion: meta.slicerVersion,
		totalLayers: meta.totalLayers,
		layerHeight: meta.layerHeight,
		filamentMm: meta.filamentMm,
		printTimeSeconds: meta.printTimeSeconds,
		filamentDiameterMm: meta.filamentDiameterMm,
		maxVolumetricSpeedMm3PerSec: meta.maxVolumetricSpeedMm3PerSec,
		values: Object.fromEntries(meta.values),
	};
}

/** A flat, JSON-marshallable snapshot of one line's own `LineContext` fields — everything except
 *  `meta`, which `setMeta` hoists into the VM once per run instead. */
export interface SerialisedLineState {
	lineNo: number;
	layer: number;
	z: number | null;
	tool: number;
	feedrate: number | null;
	relativeMoves: boolean;
	relativeE: boolean;
	object: string | null;
	featureType: string | null;
	layerChanged: boolean;
	totalLayers: number | null;
	progress: number | null;
}

export function serialiseLineState(ctx: LineContext): SerialisedLineState {
	return {
		lineNo: ctx.lineNo,
		layer: ctx.layer,
		z: ctx.z,
		tool: ctx.tool,
		feedrate: ctx.feedrate,
		relativeMoves: ctx.relativeMoves,
		relativeE: ctx.relativeE,
		object: ctx.object,
		featureType: ctx.featureType,
		layerChanged: ctx.layerChanged,
		totalLayers: ctx.totalLayers,
		progress: ctx.progress,
	};
}

export interface LineOutcome {
	/** The script's own replacement for the line, or `null` if it dropped it. Whether this counts as
	 *  "unchanged" (and so should collapse to `undefined` at the `Transform` level) is for the caller
	 *  to decide by comparing it against the line it sent in — this module has no opinion. */
	line: string | null;
	before: Array<string>;
	after: Array<string>;
	logs: Array<string>;
}

/** Default WASM heap ceiling for a sandboxed run — generous for real G-code processing, still a
 *  genuine backstop against a script that tries to allocate its way into trouble. */
export const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Hard per-line wall-clock backstop, enforced by QuickJS's own interrupt hook *during* execution —
 * the one thing the fast engine's averaged, periodically-sampled watchdog genuinely cannot do (a
 * single pathological line can hang it before the next sample). Not user-configurable: the
 * user-facing time budget is `ScriptConfig.maxMsPerLine`, checked as a running average by `script.ts`
 * exactly as the fast engine already does; this is only the last-resort ceiling under it.
 */
export const INTERRUPT_BACKSTOP_MS = 1000;

/**
 * One VM for the life of a run. `state` (the script's own persistent scratch object) lives as a plain
 * object *inside* the VM's evaluated scope and needs no marshalling at all — simpler than the fast
 * engine's own `state`, which at least has to be a real JS object the host constructs.
 */
export class SandboxEngine {
	private readonly runtime: QuickJsRuntimeLike;
	private readonly vm: QuickJsContextLike;
	private readonly runLineFn: QuickJsHandleLike;
	private readonly setMetaFn: QuickJsHandleLike;
	/** `runLineFn`/`setMetaFn` handles, disposed by `dispose()` before the context itself — freeing a
	 *  QuickJS runtime while a handle obtained from it is still live trips a hard `list_empty(...)`
	 *  assertion inside the WASM build, aborting the whole process rather than throwing a catchable
	 *  JS error. Tracked in an array (rather than disposing each field by name) so the constructor's
	 *  failure path — thrown before either field is assigned — has nothing named to dispose yet. */
	private readonly ownedHandles: Array<QuickJsHandleLike> = [];
	/** Set by `runLine` immediately before each VM call and cleared immediately after, so idle time
	 *  between lines (host-side work, another transform in the recipe) never counts against the
	 *  backstop — the interrupt handler itself is installed once, in the constructor, and just reads
	 *  whatever this currently holds. */
	private deadline = Infinity;
	private disposed = false;

	constructor(
		module: QuickJsModuleLike,
		source: string,
		options: { memoryLimitBytes?: number } = {},
	) {
		this.runtime = module.newRuntime();
		this.runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
		this.runtime.setInterruptHandler(() => performance.now() > this.deadline);
		this.vm = this.runtime.newContext();

		const contextSource = `${VM_STDLIB_SOURCE}
function __userTransform(line, ctx, api) {
	"use strict";
	var emit = api.emit, emitBefore = api.emitBefore, drop = api.drop, state = api.state, log = api.log, gcode = api.gcode;
	${source}
}
`;
		try {
			// The context source's own completion value (a function declaration's, so effectively
			// undefined) is discarded — only its handle needs disposing. What matters is that a syntax
			// error anywhere in it, including inside the not-yet-called __userTransform body, surfaces
			// here: QuickJS parses the whole program before executing any of it.
			this.vm.unwrapResult(this.vm.evalCode(contextSource, "sandboxed-script.js")).dispose();
			this.runLineFn = this.vm.unwrapResult(this.vm.evalCode("runLine"));
			this.ownedHandles.push(this.runLineFn);
			this.setMetaFn = this.vm.unwrapResult(this.vm.evalCode("setMeta"));
			this.ownedHandles.push(this.setMetaFn);
		} catch (e) {
			this.dispose();
			throw new StepConfigError(`Sandboxed script does not compile: ${(e as Error).message}`);
		}
	}

	/** Hoist the file's slicer metadata into the VM once per run — never re-sent per line. Call from
	 *  `onStart`, before the first `runLine`. Safe to skip: `vmStdlib.ts` initialises `__meta` to a
	 *  well-formed empty shape, so a script reads `ctx.meta.values` as `{}`, never `undefined`. */
	setMeta(meta: SlicerMetadata): void {
		const inputHandle = this.vm.newString(JSON.stringify(serialiseMeta(meta)));
		let resultHandle: QuickJsHandleLike;
		try {
			resultHandle = this.vm.unwrapResult(this.vm.callFunction(this.setMetaFn, this.vm.undefined, inputHandle));
		} finally {
			inputHandle.dispose();
		}
		resultHandle.dispose();
	}

	runLine(line: string, state: SerialisedLineState): LineOutcome {
		this.deadline = performance.now() + INTERRUPT_BACKSTOP_MS;

		const inputHandle = this.vm.newString(JSON.stringify({ line, ctx: state }));
		let resultHandle: QuickJsHandleLike;
		try {
			const callResult = this.vm.callFunction(this.runLineFn, this.vm.undefined, inputHandle);
			resultHandle = this.vm.unwrapResult(callResult);
		} catch (e) {
			const message = (e as Error).message;
			if (/interrupted/i.test(message)) {
				throw new ScriptAbortError(
					`Sandboxed script's line ${state.lineNo} ran for over ${INTERRUPT_BACKSTOP_MS} ms — aborted before it could hang the browser.`,
				);
			}
			throw new ScriptAbortError(message);
		} finally {
			inputHandle.dispose();
			this.deadline = Infinity;
		}

		try {
			return JSON.parse(this.vm.getString(resultHandle)) as LineOutcome;
		} finally {
			resultHandle.dispose();
		}
	}

	/** Idempotent — safe to call more than once (a compile failure in the constructor already calls
	 *  this once before throwing; `script.ts`'s `dispose()` calls it again at the end of a run). */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const handle of this.ownedHandles) {
			try { handle.dispose(); } catch { /* best-effort — still dispose the context/runtime below */ }
		}
		this.vm.dispose();
		this.runtime.dispose();
	}
}
