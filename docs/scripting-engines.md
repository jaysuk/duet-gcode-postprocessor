# Scripting engines and third-party modules

An evaluation of what could be added to make the scripting side genuinely capable — including
running real Python, the way a desktop slicer does — and what each option actually costs.

## What ships today (no dependencies)

| Tier | What it is | Isolation |
| --- | --- | --- |
| **Rules** | Declarative when/then JSON, interpreted by `model/steps/rules.ts` | Total — no code runs |
| **JavaScript** | User JS compiled with `new Function`, one call per line | A guardrail, not a sandbox |
| **Standard library** | `gcode.parse/num/has/set/scale/offset/remove/isMove/isExtrusion/setComment/format`, backed by the same tested tokeniser the rest of the plugin uses | n/a |

The standard library matters more than it looks. Left to themselves, post-processing scripts parse
G-code with a regular expression, and that is precisely how they corrupt files — a `;` inside a
quoted `M291` string, a parameter written `X 10`, a line carrying a checksum. Handing scripts the
real tokeniser removes the whole class.

The honest weakness is isolation. `new Function` with the network globals shadowed stops accidents
and copy-paste, but `[].constructor.constructor("return this")()` still reaches the real global
object. Everything below is judged first on whether it fixes that.

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

## Candidates

### quickjs-emscripten — a real JavaScript sandbox *(recommended next)*

[justjake/quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) compiles the QuickJS
engine to WebAssembly. Each runtime is a completely isolated VM: no DOM, no network, no globals it
is not given, plus a **memory limit** and an **interrupt handler** that can stop a script
deterministically.

- **Fixes:** the isolation weakness *and* the watchdog. Today an infinite loop is caught by an
  averaged time budget after the fact; an interrupt handler stops it properly.
- **Cost:** roughly 1 MB of WASM (the asyncify variant is about twice that and 40% slower — not
  needed here). Marshalling values across the VM boundary is the performance risk: a call per line
  over five million lines would be far too slow, so the step has to hand the VM a **whole chunk of
  lines at a time** and take an array back. That is a change to the step's shape, not to the engine.
- **Verdict:** the highest-value addition. It turns the documented caveat in `script.ts` into a
  genuine security boundary and makes untrusted, shared scripts a reasonable thing to support.

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
   comes with it. This belongs in the DWC-native proposal list alongside the existing asks.
2. Bundle CodeMirror if that is declined.

### diff (jsdiff) — a better preview

~30 KB, and would upgrade the change list from "these lines differ" to a proper unified diff with
context and intra-line word highlighting. The current hand-rolled per-line diff is adequate but
noticeably cruder. Cheap, low risk, purely cosmetic — worth it once the UI settles.

### expr-eval / jsep — computed values in the rules tier

~10–20 KB for a safe expression parser, letting a rule say `F * 0.8 + 100` or
`layer < meta.totalLayers / 2` without dropping to JavaScript. This is a real gap: the rules tier
currently only does fixed factors and offsets. It also keeps more people out of the script tier
entirely, which is the security win. Recommended as a small, early addition.

### Not recommended

- **picomatch / minimatch** for the filename filter — the glob support needed is ten lines, already
  written and tested.
- **fflate / pako** — nothing here is compressed. The exception is `.bgcode` (PrusaSlicer binary
  G-code), which needs heatshrink plus MeatPack decoding and has no maintained JavaScript
  implementation. That is its own project, not a dependency.
- **A G-code parsing library from npm** — every one evaluated is either regex-based (the bug class
  above) or oriented at CNC dialects. The tokeniser here is 200 lines and quote-aware.

## Recommended order

1. **`ScriptEngine` seam** — formalise the interface the JS step already implies, and move the step
   to a chunk-at-a-time shape. No new dependency, and it is the prerequisite for everything else.
2. **expr-eval in the rules tier** — small, and moves people off scripting entirely.
3. **quickjs-emscripten** — the JS tier becomes a real sandbox with a real timeout.
4. **Monaco exposure (ask upstream) or CodeMirror** — the editing experience.
5. **Pyodide, opt-in** — real Python, real slicer-script compatibility.
6. **jsdiff** — nicer preview, whenever convenient.

Nothing above is on the critical path for v1: the rules tier plus the JavaScript tier plus the
standard library already cover what a post-processing script needs to do. These are what turn it
from *capable* into *the reason to use this instead of re-slicing*.
