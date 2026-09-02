#!/usr/bin/env node
/**
 * Bundle the QuickJS WASM runtime into `dwc/GCodePostProcessor/quickjs.bin` so it ships as a plugin
 * asset, fetched and evaluated at runtime by `src/model/steps/quickjs/loader.ts` — never bundled into
 * the main plugin IIFE (constraint 3 in `docs/scripting-engines.md`; the precedent is
 * `duet-tool-align`'s `opencv.bin`, fetched pre-built there since OpenCV.js already ships as a single
 * global-exposing script — QuickJS's own npm packages are CommonJS modules meant for `require()`, so
 * this repo bundles them itself instead of just downloading a file).
 *
 * `@jitl/quickjs-singlefile-cjs-release-sync` inlines its WASM as base64 and makes zero `import()`
 * calls of any kind (confirmed by reading its unpkg `dist` output directly), so esbuild can bundle it
 * into one flat IIFE with no further asset files to manage.
 *
 *   node scripts/build-quickjs-asset.mjs
 *
 * Output is gitignored, not committed — built fresh before `verify-build`/release, same as
 * `duet-tool-align`'s `fetch-opencv.mjs` describes for its own asset.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(pluginRoot, "dwc", "GCodePostProcessor");
// Non-".js" extension on purpose: DWC's plugin loader auto-injects every dwcFiles ".js" as a
// <script> at plugin load, which would eagerly load ~1 MB most recipes never touch. As ".bin" it
// just lands on the filesystem and quickjs/loader.ts fetch+evals it on demand.
const outFile = join(outDir, "quickjs.bin");

/** Global name loader.ts looks for after eval'ing this asset. Namespaced so it can never collide
 *  with anything already on `window` in a real DWC page. */
const INIT_GLOBAL = "__DuetGCodePostProcessorQuickJsInit";

const entrySource = `
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
globalThis.${INIT_GLOBAL} = function () {
	return newQuickJSWASMModuleFromVariant(variant);
};
`;

mkdirSync(outDir, { recursive: true });

const result = await build({
	stdin: {
		contents: entrySource,
		resolveDir: pluginRoot,
		loader: "js",
	},
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2020",
	minify: true,
	write: false,
	logLevel: "info",
	// The emscripten-generated glue code has a dead (browser-side) Node.js detection branch that
	// calls require("fs")/require("path") to read the .wasm file from disk — dead because this is the
	// "singlefile" variant, which inlines the wasm as base64 instead. It's never reached in a browser
	// (guarded behind an ENVIRONMENT_IS_NODE check), but esbuild still needs to resolve every
	// require() call at bundle time unless told not to — marking these external leaves the calls as
	// plain `require(...)` in the output rather than failing the build over code that never runs here.
	external: ["fs", "path", "crypto", "module", "url"],
});

const [out] = result.outputFiles;
if (out === undefined || out.contents.length < 100_000) {
	console.error(`Bundled output is suspiciously small (${out?.contents.length ?? 0} bytes) — aborting`);
	process.exit(1);
}
writeFileSync(outFile, out.contents);

console.log(`quickjs runtime (${(statSync(outFile).size / 1e6).toFixed(2)} MB) -> dwc/GCodePostProcessor/quickjs.bin`);
