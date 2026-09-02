import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const REPO_ROOT = join(__dirname, "..", "..");
const ASSET_PATH = join(REPO_ROOT, "dwc", "GCodePostProcessor", "quickjs.bin");

/**
 * Loads the REAL built `dwc/GCodePostProcessor/quickjs.bin` asset (built here, fresh, by actually
 * running `scripts/build-quickjs-asset.mjs` — this file's own `beforeAll`, not a manual step someone
 * has to remember, since this asset is gitignored and CI never has a stale copy of it lying around
 * either) and confirms it actually initialises and evaluates code — in a sandbox deliberately built to
 * look like a real browser page, not like the Node process running this test.
 *
 * That distinction matters: the emscripten glue this asset bundles decides whether it is running
 * under Node by checking `globalThis.process?.versions?.node`. Vitest's own global scope has a real
 * `process` (vitest runs on Node even though it emulates a DOM via happy-dom), which fools that check
 * into taking a Node-only code path that calls `require("fs")` — a call this bundle deliberately
 * leaves unresolved (see the build script's `external` comment) because it must never execute in the
 * real target environment, a browser page with no `process` global at all. Running the asset inside a
 * `node:vm` context that omits `process` (while still providing real `WebAssembly`, `URL`, etc.)
 * reproduces that real condition, rather than the misleading one vitest's own globals would give.
 */
describe("the built quickjs.bin asset", () => {
	beforeAll(() => {
		execFileSync("node", ["scripts/build-quickjs-asset.mjs"], { cwd: REPO_ROOT, stdio: "inherit" });
	}, 60_000);

	it("initialises and evaluates real code in a browser-like global scope (no process global)", async () => {
		const src = readFileSync(ASSET_PATH, "utf8");

		interface FakeQuickJsHandle { dispose(): void }
		interface FakeQuickJsContext {
			evalCode(code: string): { value?: FakeQuickJsHandle; error?: FakeQuickJsHandle };
			dump(h: FakeQuickJsHandle): unknown;
			unwrapResult<T>(r: { error?: FakeQuickJsHandle; value?: T }): T;
			dispose(): void;
		}
		interface FakeQuickJsRuntime { newContext(): FakeQuickJsContext; dispose(): void }
		interface FakeSandbox {
			window: Record<string, never>;
			console: Console;
			URL: typeof URL;
			TextDecoder: typeof TextDecoder;
			TextEncoder: typeof TextEncoder;
			Uint8Array: typeof Uint8Array;
			WebAssembly: typeof WebAssembly;
			Promise: typeof Promise;
			setTimeout: typeof setTimeout;
			globalThis?: FakeSandbox;
			__DuetGCodePostProcessorQuickJsInit?: () => Promise<{ newRuntime(): FakeQuickJsRuntime }>;
		}

		const sandbox: FakeSandbox = {
			window: {},
			console,
			URL,
			TextDecoder,
			TextEncoder,
			Uint8Array,
			WebAssembly,
			Promise,
			setTimeout,
		};
		sandbox.globalThis = sandbox;
		createContext(sandbox);

		runInContext(src, sandbox);
		expect(typeof sandbox.__DuetGCodePostProcessorQuickJsInit).toBe("function");

		const QuickJS = await sandbox.__DuetGCodePostProcessorQuickJsInit!();
		const runtime = QuickJS.newRuntime();
		const vm = runtime.newContext();
		try {
			const result = vm.evalCode("21 * 2");
			expect(vm.dump(vm.unwrapResult(result))).toBe(42);
		} finally {
			vm.dispose();
			runtime.dispose();
		}
	});
});
