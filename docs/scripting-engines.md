# Scripting engines and third-party modules

An evaluation of what could be added to make the scripting side genuinely capable — including
running real Python, the way a desktop slicer does — and what each option actually costs.

## What ships today

| Tier | What it is | Isolation | Dependency |
| --- | --- | --- | --- |
| **Rules** | Declarative when/then JSON, interpreted by `model/steps/rules.ts` | Total — no code runs | none |
| **Rules: `expr`/`setParamExpr`** | A safe expression evaluator for computed conditions/values (`F * 0.8 + 100`) | Total — no loops, no function calls, no member access into anything but a flat scope | `expr-eval-fork` (~15 KB) |
| **JavaScript: Fast engine** | User JS compiled with `new Function`, one call per line | A guardrail, not a sandbox | none |
| **JavaScript: Sandboxed engine** | User JS run inside a real QuickJS VM, one call per line | Real — no network/DOM globals exist in the VM at all, plus a memory limit and a wall-clock interrupt | `quickjs-emscripten-core` + `@jitl/quickjs-singlefile-cjs-release-sync`, lazily fetched as a ~0.87 MB plugin asset, never bundled into the main IIFE |
| **Standard library** | `gcode.parse/num/has/set/scale/offset/remove/isMove/isExtrusion/setComment/format`, backed by the same tested tokeniser the rest of the plugin uses; ported into a second, plain-JS copy (`quickjs/vmStdlib.ts`) for the sandboxed engine, kept honest by `quickjsStdlibParity.test.ts` | n/a | none |

The standard library matters more than it looks. Left to themselves, post-processing scripts parse
G-code with a regular expression, and that is precisely how they corrupt files — a `;` inside a
quoted `M291` string, a parameter written `X 10`, a line carrying a checksum. Handing scripts the
real tokeniser removes the whole class.

The Fast engine's honest weakness is isolation: `new Function` with the network globals shadowed
stops accidents and copy-paste, but `[].constructor.constructor("return this")()` still reaches the
real global object. The Sandboxed engine (below) closes that — not by shadowing anything, but by
running inside a VM that never had those globals to begin with. Both engines ship side by side
(`engine: "fast" | "sandboxed"` on the script step, defaulting to `"fast"`) rather than one replacing
the other, since Fast has no download cost and is enough for most recipes.

## The constraints that decide this

1. **The bundle is a single IIFE with no dynamic `import()`.** Anything large has to be loaded at
   runtime from a URL, not bundled.
2. **DWC 3.7 ships plugin assets** (`dwc/<id>/` in the ZIP, resolved through
   `window.DWC.pluginAssetUrl`). `duet-tool-align` already loads a ~10 MB OpenCV.js build this way,
   so the pattern is proven on real hardware — including inside a Web Worker via `importScripts`.
3. **DWC ships no Content-Security-Policy**, so `new Function`, injected `<script>` tags and
   cross-origin CDN loads all work today. None of that should be *relied* on: keep every engine
   behind the `ScriptEngine` seam so a future CSP degrades one tier rather than breaking the plugin.
4. **`dwc-plugin-typecheck` resolves `node_modules` from the DWC checkout, not this repo.** A
   type-only dependency must be an ambient `.d.ts`, never `@types/<pkg>`.
5. Bundle size is paid on every plugin install and every DWC load, over the Duet's own HTTP server.
   A megabyte of always-loaded dependency is a real cost; a lazily-fetched asset is not.

## Shipped

### quickjs-emscripten — a real JavaScript sandbox *(shipped)*

[justjake/quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) compiles the QuickJS
engine to WebAssembly. Each runtime is a completely isolated VM: no DOM, no network, no globals it
is not given, plus a **memory limit** and an **interrupt handler** that can stop a script
deterministically. Implemented as the script step's `engine: "sandboxed"` option
(`model/steps/quickjs/`), alongside the original engine rather than replacing it.

- **Package split.** `quickjs-emscripten-core` (the API) + `@jitl/quickjs-singlefile-cjs-release-sync`
  (the actual runtime — WASM inlined as base64, zero `import()` calls of any kind, verified by reading
  its unpkg `dist` output directly). The "singlefile" variant was chosen over the smaller
  `wasmfile` split specifically because it is one self-contained blob to fetch+eval, matching how it
  ships as a plugin asset outside the main IIFE's own no-dynamic-import constraint.
- **Loading.** Bundled by `scripts/build-quickjs-asset.mjs` (esbuild, `external: ["fs", "path", ...]`
  to leave the emscripten glue's dead Node-detection branch unresolved rather than failing the bundle
  over code that only runs — deliberately never — under real Node) into
  `dwc/GCodePostProcessor/quickjs.bin`, a non-`.js` name so DWC's plugin loader does not auto-inject it
  as a `<script>` on every page load, same reasoning as `duet-tool-align`'s `opencv.bin`.
  `model/steps/quickjs/loader.ts` fetches and indirect-evals it on first use, exactly as
  `duet-tool-align`'s OpenCV worker does, and memoises the result for the page session.
- **Shape: one VM call per line, not a chunk.** An earlier design batched 500 lines into one VM call
  to amortise the per-line marshalling cost — a real cost, but the batching hid it behind three
  worse defects (task 14): `Pipeline.end()` never feeds a transform's own buffered output through
  *later* transforms in the recipe, so the tail of every file silently skipped every downstream step;
  every line in a flushed batch was evaluated against whichever line's `LineContext` happened to close
  the batch, so a layer-anchored downstream step saw the wrong layer; and every withheld line reported
  as a deletion (and every flushed line as an addition) in the dry-run diff and statistics — the
  primary safety mechanism this plugin has. None of that showed up in the sandboxed engine's own unit
  tests, because none of them drove it through a real `Pipeline` with a downstream step. The fix calls
  the VM once per line — the same shape as the fast engine, a genuine drop-in for it — and hoists the
  file's slicer metadata into the VM exactly once per run (`SandboxEngine.setMeta`, called from
  `script.ts`'s `onStart`) rather than re-marshalling the whole metadata block on every line, which
  had independently made the sandboxed engine 239× slower than the fast one on a file with 300
  metadata keys (normal for PrusaSlicer/OrcaSlicer) — badly enough that the default time budget
  aborted a do-nothing identity script on an ordinary file.
- **What it actually costs: ~17× the fast engine.** Measured on a 20,000-line file with 300 metadata
  keys: ~38µs/line against ~2µs/line. Two earlier drafts of this document claimed "roughly 2×", both
  times by quoting a benchmark of a bare VM round trip against a context object with *no metadata in
  it* — the same mistake twice, and the reason this bullet now names the fixture it was measured on.
  Breaking the ~38µs down: a bare `newString`/`callFunction`/`getString` is ~6µs; the `{line, ctx}`
  payload's four JSON operations (stringify host, parse VM, stringify VM, parse host) take it to
  ~26µs, about half of that the 12-field ctx object; the rest is pipeline overhead. **The JSON
  marshalling dominates, not the VM boundary** — so that is the thing to attack if this ever needs to
  be faster (marshal the ctx as individual VM values, or keep a mutable ctx inside the VM and push
  only changed fields), measuring on a fixture with real metadata. The armed interrupt handler costs
  nothing measurable. In practice ~38µs/line is roughly 40s for a million-line file against ~2s on
  the fast engine — a real cost, worth choosing deliberately, and why "Fast" stays the default.
- **The one real architectural wrinkle:** loading the asset is async, but `StepDefinition.create()`
  is not. Resolved without changing that contract: `processFile` (`io/transfer.ts`) is already async
  and calls `buildTransforms` synchronously partway through its own sequence, so it awaits
  `ensureQuickJsLoaded()` once beforehand (gated behind `recipe.ts`'s `usesSandboxedScript`, costing
  nothing for the common recipe that never uses it); the loader module owns both the async load and a
  synchronous cache accessor `create()` reads from.
- **Verified, not assumed:** a dedicated test (`quickjsEngine.test.ts`) runs a real infinite loop
  (`while (true) {}`) through a real VM and asserts the interrupt actually fires — the specific claim
  ("the watchdog stops a runaway script") this codebase's own standard requires checking rather than
  trusting from the API existing. A separate cross-engine parity test in the same file runs identical
  scripts through both engines and asserts identical output *and* identical `Pipeline` statistics —
  the test that would have caught the chunking defects above, and does now guard against their
  reintroduction. A third test (`quickjsAssetSmoke.test.ts`) loads the real built asset inside a
  `node:vm` sandbox specifically built to look like a browser page (no `process` global) rather than
  the Node process running the test suite — the first attempt at that test, run without that
  isolation, gave a false failure by tripping the emscripten glue's own Node-vs-browser detection
  logic.

### expr-eval — computed values in the rules tier *(shipped)*

A safe expression parser, letting a rule say `F * 0.8 + 100` or `layer < totalLayers / 2` (a flat
scope, not `meta.totalLayers` — no member access at all, deliberately, even though the library
supports it) without dropping to JavaScript. Implemented as `expr` (a condition) and `setParamExpr`
(an action) in `model/steps/rules.ts`, backed by `model/gcode/exprEval.ts`.

**Ships as `expr-eval-fork`, not the `expr-eval` this section originally named.** The original has two
unpatched high-severity advisories —
[GHSA-8gw3-rxh4-v6jx](https://github.com/advisories/GHSA-8gw3-rxh4-v6jx) (prototype pollution) and
[GHSA-jc85-fpwf-qm7x](https://github.com/advisories/GHSA-jc85-fpwf-qm7x) (unrestricted function
values) — both exploitable through the *scope* object handed to `evaluate()`, which matters here
specifically because part of that scope comes from a G-code file's own metadata, and this plugin
explicitly processes files that may not be the user's own. The fork
([jorenbroekema/expr-eval](https://github.com/jorenbroekema/expr-eval)) patches both, is API-compatible
(same `Parser`/`Expression` classes), and `npm audit` shows zero vulnerabilities with it installed.

## Candidates

### Pyodide — real CPython, and the actual slicer contract

[Pyodide](https://pyodide.org/en/stable/usage/downloading-and-deploying.html) is CPython compiled to
WebAssembly. This is the option that makes "run the same post-processing script your slicer runs"
literally true, since PrusaSlicer and OrcaSlicer post-processing scripts are overwhelmingly Python.

- **Size:** the full distribution is 200+ MB, but only `pyodide-core` is needed to start — several
  megabytes. Loaded from a CDN with `loadPyodide({ indexURL })`, or shipped as a plugin asset for
  printers with no internet access.
- **Loading without dynamic import:** inject a `<script src=…pyodide.js>` tag, or `importScripts` it
  inside a worker — the same pattern `duet-tool-align` uses for OpenCV.js.
- **Shape:** per-line calls are hopeless across the JS/Python boundary. Give the script a
  `process(lines, ctx) -> lines` entry point per chunk. For compatibility with existing slicer
  scripts (which take a file path in `sys.argv[1]`, read it, rewrite it in place) a shim can write
  the chunk into Pyodide's in-memory filesystem, run the script unmodified, and read the file back —
  worth doing, because "paste the script you already use" is the whole appeal.
- **Verdict:** a genuinely distinctive feature, and the single most persuasive answer to "why not
  just use the slicer". Opt-in, downloaded on first use, never bundled. Do it *after* the engine
  seam and the chunk-at-a-time step shape exist, because it needs both.

### MicroPython (WASM) — the small-Python alternative

Around 300 KB rather than several megabytes. Ships `re` (as `ure`) which covers most line-rewriting
scripts, but not `os`, `argparse` or anything from PyPI — so existing slicer scripts mostly will not
run unmodified, which is the entire reason to want Python here. Keep as a fallback if Pyodide's
weight proves unacceptable in the field; not the first choice.

### RustPython, Brython, Skulpt

Skulpt and Brython are Python *reimplemented in JavaScript*: smaller, but slow and with partial
semantics. RustPython's WASM build has an incomplete stdlib. None of them run a real slicer script
unchanged, which is the bar. Not recommended.

### CodeMirror 6 — a real editor for the script and rules fields

The script step currently gets a monospace `v-textarea`. CodeMirror 6 is modular (roughly
200–400 KB for JS + JSON modes) and would bring syntax highlighting, bracket matching and inline
error markers.

**Before adding it, note that DWC already bundles Monaco** (`src/components/editor/MonacoEditor.vue`,
`src/utils/monaco.ts`, with a G-code language definition). It is not usable here as-is: only the
component is exposed to plugins, and it is file-bound — its props are `filename` and
`initialContent`, and it saves back to the SD card itself. `@/utils/monaco` is **not** in the
externalised `PLUGIN_GLOBALS` list, so a plugin cannot construct its own editor.

Two ways forward, and the first is better for everyone:

1. **Ask for `@/utils/monaco` to be externalised** (a one-line addition to `PLUGIN_GLOBALS` in
   `scripts/build-plugin.js`, plus the virtual-module entry). Every plugin that wants a code field
   then gets a first-class editor at zero bundle cost, and DWC's existing G-code language support
   comes with it. This belongs in the shared
   [DWC-native proposal list](https://github.com/jaysuk/dwc-plugin-runtime/blob/main/docs/dwc-native-proposal.md)
   alongside the existing asks.
2. Bundle CodeMirror if that is declined.

### diff (jsdiff) — a better preview

~30 KB, and would upgrade the change list from "these lines differ" to a proper unified diff with
context and intra-line word highlighting. The current hand-rolled per-line diff is adequate but
noticeably cruder. Cheap, low risk, purely cosmetic — worth it once the UI settles.

### Not recommended

- **picomatch / minimatch** for the filename filter — the glob support needed is ten lines, already
  written and tested.
- **fflate / pako** — nothing here is compressed. The exception is `.bgcode` (PrusaSlicer binary
  G-code), which needs heatshrink plus MeatPack decoding and has no maintained JavaScript
  implementation. That is its own project, not a dependency.
- **A G-code parsing library from npm** — every one evaluated is either regex-based (the bug class
  above) or oriented at CNC dialects. The tokeniser here is 200 lines and quote-aware.

## Recommended order

1. ~~**expr-eval in the rules tier**~~ — shipped.
2. ~~**quickjs-emscripten**~~ — shipped. The JS tier now has a real sandbox with a real timeout,
   alongside (not replacing) the original fast engine.
3. **Monaco exposure (ask upstream) or CodeMirror** — the editing experience.
4. **Pyodide, opt-in** — real Python, real slicer-script compatibility.
5. **jsdiff** — nicer preview, whenever convenient.

Nothing above is on the critical path for v1: the rules tier plus the JavaScript tier plus the
standard library already cover what a post-processing script needs to do. These are what turn it
from *capable* into *the reason to use this instead of re-slicing*.
