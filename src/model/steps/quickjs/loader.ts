/**
 * Loads the QuickJS WASM runtime as a lazily-fetched plugin asset, not bundled into the main IIFE.
 *
 * `@jitl/quickjs-singlefile-cjs-release-sync` inlines its WASM as base64 (confirmed by reading its
 * unpkg `dist` output directly) and is ~837KB — a real cost for a feature most recipes never touch,
 * so `scripts/build-quickjs-asset.mjs` bundles it (plus `quickjs-emscripten-core`) into one
 * global-exposing script at build time, shipped as `dwc/GCodePostProcessor/quickjs.bin` (a non-`.js`
 * extension so DWC's plugin loader does not auto-inject it as a `<script>` on every page load — same
 * reason `duet-tool-align` ships `opencv.bin` rather than `opencv.js`). This module fetches it and
 * runs it via indirect eval, exactly as `duet-tool-align`'s `detectorWorker.ts` does for OpenCV.
 *
 * **Why a loader with both an async entry point and a sync accessor.** `StepDefinition.create()` is
 * synchronous (so is `recipe.ts`'s `buildTransforms`), but fetching+evaling ~800KB is not. The one
 * real caller, `processFile` in `io/transfer.ts`, is already `async` and calls `buildTransforms`
 * synchronously partway through its own awaited sequence — so it awaits {@link ensureQuickJsLoaded}
 * once, right before that call, and by the time `create()` runs synchronously afterward the module is
 * already resolved and cached here. {@link getLoadedQuickJs} throws in the defensive
 * (should-be-unreachable outside a missing `ensureQuickJsLoaded` call) case it somehow is not.
 */

import { StepConfigError } from "../types";

/** The minimal surface this plugin actually uses — declared locally so this module never imports
 *  `quickjs-emscripten-core`'s own types (it is a devDependency, not shipped in `dependencies`; the
 *  loaded module comes from the fetched asset at runtime, not from `node_modules`). */
export interface QuickJsHandleLike {
	dispose(): void;
}
export interface QuickJsCallResultLike {
	error?: QuickJsHandleLike;
	value?: QuickJsHandleLike;
}
export interface QuickJsContextLike {
	evalCode(code: string, filename?: string): QuickJsCallResultLike;
	newString(value: string): QuickJsHandleLike;
	callFunction(func: QuickJsHandleLike, thisVal: QuickJsHandleLike, ...args: Array<QuickJsHandleLike>): QuickJsCallResultLike;
	getString(handle: QuickJsHandleLike): string;
	unwrapResult<T>(result: { error?: QuickJsHandleLike; value?: T }): T;
	undefined: QuickJsHandleLike;
	dispose(): void;
}
export interface QuickJsRuntimeLike {
	newContext(): QuickJsContextLike;
	setInterruptHandler(cb: () => boolean): void;
	setMemoryLimit(bytes: number): void;
	dispose(): void;
}
export interface QuickJsModuleLike {
	newRuntime(): QuickJsRuntimeLike;
}

/** Global name the built asset (`scripts/build-quickjs-asset.mjs`) exposes its init function under. */
const INIT_GLOBAL = "__DuetGCodePostProcessorQuickJsInit";

/** Relative asset path passed to `pluginAssetUrl` — mirrors `duet-tool-align`'s own
 *  `"DuetToolAlign/opencv.bin"` call, which already includes the plugin id as its first segment
 *  (verified by reading `resolveOpencvUrl` directly: `pluginAssetUrl` takes one joined path, not a
 *  separate plugin-id argument). */
const ASSET_PATH = "GCodePostProcessor/quickjs.bin";

let loadPromise: Promise<QuickJsModuleLike> | null = null;
let loaded: QuickJsModuleLike | null = null;

function resolveAssetUrl(): string {
	const dwc = (globalThis as { DWC?: { pluginAssetUrl?: (path: string) => string } }).DWC;
	if (dwc?.pluginAssetUrl === undefined) {
		throw new StepConfigError("Cannot resolve the sandboxed script engine's asset URL outside a running DWC plugin.");
	}
	const rel = dwc.pluginAssetUrl(ASSET_PATH);
	try {
		return new URL(rel, location.href).href;
	} catch {
		return rel;
	}
}

/** Fetch, evaluate and initialise the QuickJS asset once per page session, memoised regardless of how
 *  many times a recipe using the sandboxed engine runs. Safe to call more than once concurrently. */
export function ensureQuickJsLoaded(): Promise<QuickJsModuleLike> {
	if (loaded !== null) return Promise.resolve(loaded);
	if (loadPromise !== null) return loadPromise;

	loadPromise = (async () => {
		const url = resolveAssetUrl();
		const res = await fetch(url);
		if (!res.ok) {
			throw new StepConfigError(`Failed to download the sandboxed script engine (HTTP ${res.status}).`);
		}
		const src = await res.text();
		// Indirect eval (not a direct call, and not importScripts, which requires a ".js" URL) — same
		// technique duet-tool-align's OpenCV worker uses, and for the same reason: this asset is
		// deliberately served under a non-".js" name so DWC's plugin loader never auto-injects it.
		(0, eval)(src);
		const init = (globalThis as Record<string, unknown>)[INIT_GLOBAL];
		if (typeof init !== "function") {
			throw new StepConfigError("The sandboxed script engine asset did not initialise correctly.");
		}
		const module = (await (init as () => Promise<QuickJsModuleLike>)());
		loaded = module;
		return module;
	})();
	return loadPromise;
}

/** Synchronous accessor for a module already resolved by {@link ensureQuickJsLoaded}. Throws
 *  {@link StepConfigError} if called before that — a caller bug, not a user-facing scenario, since
 *  `processFile` always awaits the loader before building transforms. */
export function getLoadedQuickJs(): QuickJsModuleLike {
	if (loaded === null) {
		throw new StepConfigError("The sandboxed script engine has not finished loading yet.");
	}
	return loaded;
}

/** Test-only: reset the memoised module so tests can install a fake. */
export function __resetQuickJsLoaderForTests(): void {
	loadPromise = null;
	loaded = null;
}

/** Test-only: install an already-loaded module directly, bypassing `ensureQuickJsLoaded`'s own
 *  fetch+eval — for tests exercising `script.ts`'s integration with a real QuickJS module without
 *  also depending on the fetch/eval mechanism itself (that mechanism has its own dedicated tests). */
export function __setQuickJsLoadedForTests(module: QuickJsModuleLike): void {
	loaded = module;
}
