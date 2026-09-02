import { afterEach, describe, expect, it, vi } from "vitest";

import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";

import {
	__resetQuickJsLoaderForTests, __setQuickJsLoadedForTests, ensureQuickJsLoaded, getLoadedQuickJs,
} from "../model/steps/quickjs/loader";
import { scriptStep } from "../model/steps/script";
import { createState } from "../model/gcode/state";
import { emptyMetadata } from "../model/gcode/metadata";
import { tokenise } from "../model/gcode/tokenise";
import type { LineContext, RunContext, StepFactoryContext } from "../model/steps/types";
import type { QuickJsModuleLike } from "../model/steps/quickjs/loader";

function ctxFor(line: string): LineContext {
	const state = createState();
	return { ...state, token: tokenise(line), meta: emptyMetadata(), totalLayers: null, progress: null };
}

function runCtx(): RunContext {
	return { meta: emptyMetadata(), sourcePath: "", totalLayers: null, analysis: new Map(), warn: () => {} };
}

describe("ensureQuickJsLoaded()'s own plumbing", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		delete (globalThis as { DWC?: unknown }).DWC;
		delete (globalThis as Record<string, unknown>).__DuetGCodePostProcessorQuickJsInit;
		__resetQuickJsLoaderForTests();
	});

	/**
	 * Exercises `loader.ts`'s own logic — URL resolution via `window.DWC.pluginAssetUrl`, the fetch
	 * call, indirect-evaling the response, and memoization — against a tiny fake asset rather than the
	 * real ~0.87 MB QuickJS bundle. The real bundle's own environment-detection correctness (the thing
	 * that actually needs a browser-like sandbox to test honestly) is `quickjsAssetSmoke.test.ts`'s
	 * job; mixing that concern in here would just make this test fail for an unrelated reason, exactly
	 * as a first attempt at this test did (vitest's own real `process` global fooled the real bundle's
	 * Node-detection into a code path this test has no interest in).
	 */
	it("resolves the asset URL through window.DWC.pluginAssetUrl, fetches, and evaluates it", async () => {
		const fakeModule = { newRuntime: () => ({}) };
		const fakeAssetSource = "globalThis.__DuetGCodePostProcessorQuickJsInit = () => Promise.resolve(globalThis.__fakeQuickJsModule);";
		(globalThis as Record<string, unknown>).__fakeQuickJsModule = fakeModule;

		const fetchMock = vi.fn(async () => ({ ok: true, text: async () => fakeAssetSource }));
		vi.stubGlobal("fetch", fetchMock);
		(globalThis as { DWC?: { pluginAssetUrl: (p: string) => string } }).DWC = {
			pluginAssetUrl: (p: string) => `https://example.invalid/plugins/${p}`,
		};

		const loaded = await ensureQuickJsLoaded();

		expect(fetchMock).toHaveBeenCalledWith("https://example.invalid/plugins/GCodePostProcessor/quickjs.bin");
		expect(loaded).toBe(fakeModule);
		expect(getLoadedQuickJs()).toBe(fakeModule);

		delete (globalThis as Record<string, unknown>).__fakeQuickJsModule;
	});

	it("memoises the load — a second call does not fetch again", async () => {
		const fakeAssetSource = "globalThis.__DuetGCodePostProcessorQuickJsInit = () => Promise.resolve({ newRuntime: () => ({}) });";
		const fetchMock = vi.fn(async () => ({ ok: true, text: async () => fakeAssetSource }));
		vi.stubGlobal("fetch", fetchMock);
		(globalThis as { DWC?: { pluginAssetUrl: (p: string) => string } }).DWC = {
			pluginAssetUrl: (p: string) => `https://example.invalid/plugins/${p}`,
		};

		await ensureQuickJsLoaded();
		await ensureQuickJsLoaded();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects with a StepConfigError-shaped message when the fetch fails", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, text: async () => "" })));
		(globalThis as { DWC?: { pluginAssetUrl: (p: string) => string } }).DWC = {
			pluginAssetUrl: (p: string) => `https://example.invalid/plugins/${p}`,
		};

		await expect(ensureQuickJsLoaded()).rejects.toThrow(/Failed to download/);
	});

	it("throws when called outside a running DWC plugin (no window.DWC)", async () => {
		await expect(ensureQuickJsLoaded()).rejects.toThrow(/Cannot resolve/);
	});
});

describe("script.ts's integration with a real, already-loaded QuickJS module", () => {
	afterEach(() => {
		__resetQuickJsLoaderForTests();
	});

	it("runs a real sandboxed script step end-to-end", async () => {
		const QuickJS = (await newQuickJSWASMModuleFromVariant(variant)) as unknown as QuickJsModuleLike;
		__setQuickJsLoadedForTests(QuickJS);

		const factoryCtx: StepFactoryContext = { scriptsTrusted: true };
		const transform = scriptStep.create({
			source: "return gcode.isExtrusion(line) ? gcode.scale(line, 'F', 0.5, 0) : line;",
			maxMsPerLine: 0.5,
			engine: "sandboxed",
		}, factoryCtx);

		transform.onStart?.(runCtx());
		const result = transform.onLine(ctxFor("G1 X10 E1 F1200"), "G1 X10 E1 F1200");
		expect(result).toBe("G1 X10 E1 F600");
		transform.onEnd?.(runCtx());
		transform.dispose?.();
	});

	it("throws a StepConfigError from create() if used before the module has loaded", () => {
		const factoryCtx: StepFactoryContext = { scriptsTrusted: true };
		expect(() => scriptStep.create({
			source: "return line;", maxMsPerLine: 0.5, engine: "sandboxed",
		}, factoryCtx)).toThrow(/has not finished loading/);
	});
});
