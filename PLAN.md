# Build plan — duet-gcode-postprocessor

A DuetWebControl 3.7 plugin that post-processes G-code files already sitting on the Duet's SD
card. Planning document: architecture, phased delivery, decisions and risks. Feature list lives in
[FEATURES.md](FEATURES.md).

---

## 1. What it is

One DWC page (plus a Flexible-Layouts widget) that does:

```
  browse SD  →  pick file  →  inspect  →  apply a recipe  →  preview diff  →  write back
                                              ▲
                                     recipe = ordered steps
                                     (find/replace, command map,
                                      insert-at-anchor, delete,
                                      param rewrite, script, checks)
```

Everything runs **in the browser**. The Duet is a dumb file store for this purpose: the plugin
downloads the file over the existing DWC connector, transforms it in a Web Worker, and uploads the
result back. No firmware change, no SBC requirement, works on standalone Duets and Duet+SBC alike.

---

## 2. Platform findings (verified against the local DWC 3.7-dev checkout)

These shape the design, so they were checked in source rather than assumed:

| Finding | Where | Consequence |
| --- | --- | --- |
| `machineStore.download(file, type)` accepts `XMLHttpRequestResponseType` — `"blob"`, `"text"`, `"arraybuffer"` — with an `onProgress(loaded,total)` callback and a cancellation token | `src/stores/machine.ts:827` | Streaming-ish read with a real progress bar and a working Cancel |
| `upload`, `move`, `delete`, `makeDirectory`, `getFileList`, `getFileInfo` all exposed on the same store | `src/stores/machine.ts:656,778,794,808,944,957` | Full read-modify-write, atomic temp-then-move, backup folders |
| DWC 3.7 exposes **every** `@/stores/*` and `@/composables/*` export, and **every DWC component by name**, to external plugins (`virtual:dwc-plugin-api`, `virtual:dwc-components`, surfaced on `window.DWC.*` / `window.DWC.Components`) | `vite/dwc-plugin-api.ts`, `vite/dwc-components.ts` | The G-code browser is close to free — reuse `FileList` + `useFileBrowser` + `useGcodeThumbnails` instead of rebuilding one |
| `FileList.vue` takes `options: FileBrowserOptions`, `rootDirectory`, `rootLabel`, `no*` flags to hide toolbar actions, a `directory` v-model, and emits `fileClick(item, directory)` | `src/components/lists/FileList.vue:507,607,649` | Drops straight in as a picker with delete/rename/upload suppressed |
| `Events` has `fileUploaded`, `fileUploading`, `filesOrDirectoriesChanged` | `src/utils/events.ts:115,120,131` | "Post-process automatically on upload" is implementable — while a DWC tab is open |
| **DWC ships no Content-Security-Policy** | `PLUGINS.md:596` | `new Function(...)` scripting works today. Must still be isolated behind one interface in case that changes |
| Plugin bundles are a single IIFE — no dynamic `import()` | template `CLAUDE.md` | Workers must be inline-Blob workers (the pattern already proven in duet-tool-align) |

**Version risk:** the component/composable exposure is new in 3.7-dev. The browser is therefore
built as a thin `GcodeBrowser.vue` wrapper that renders DWC's `FileList` when
`window.DWC.Components?.FileList` exists and falls back to a ~100-line `v-list` browser driven by
`machineStore.getFileList()` when it doesn't. One seam, two implementations, no feature loss for
the core job.

---

## 3. Architecture

```
src/
├── index.ts                     route + embeddable registration, error capture, update check
├── components/
│   ├── PostProcessorPage.vue    the page: browser | inspector | recipe | preview
│   ├── GcodeBrowser.vue         FileList wrapper + fallback list
│   ├── FileInspector.vue        metadata, stats, dialect, thumbnail
│   ├── RecipeEditor.vue         ordered step list, drag to reorder, per-step form
│   ├── StepForms/*.vue          one small form per step type (schema-driven)
│   ├── DiffPreview.vue          unified diff, per-rule hit counts, jump-to-change
│   └── RunReport.vue            what changed, timings, warnings, download log
├── model/                       ← ALL logic here, pure, unit-tested, no Vue, no DWC imports
│   ├── constants.ts
│   ├── gcode/
│   │   ├── tokenise.ts          line → { command, params:Map, comment, raw }
│   │   ├── state.ts             running machine state: layer, Z, tool, feed, abs/rel E, M486 object
│   │   ├── metadata.ts          slicer header/footer parser (Prusa, Super, Orca, Cura, S3D, ideaMaker)
│   │   └── dialect.ts           detect Marlin / Klipper / RRF flavour from command usage
│   ├── steps/                   one module per step type, all implementing Transform
│   │   ├── types.ts             the Transform interface + StepSchema
│   │   ├── findReplace.ts  commandMap.ts  insertAt.ts  deleteLines.ts
│   │   ├── paramRewrite.ts  rangeVary.ts  script.ts  checks.ts
│   │   └── registry.ts          id → { schema, factory } — drives the UI and a self-maintaining test
│   ├── pipeline.ts              compose steps, drive lines through, collect stats + diff
│   ├── recipe.ts                recipe type, (de)serialise, validate, migrate
│   └── io/
│       ├── plan.ts              output naming, backup path, collision + safety rules (pure)
│       └── transfer.ts          the only impure module: download → worker → upload
├── worker/processor.ts          inline-Blob worker: owns the pipeline + the script sandbox
└── i18n/en.json
```

The hard rule from the template guide applies with force here: **`model/` is pure and
exhaustively unit-tested**; `.vue` files only render and call into it. A post-processor that
silently corrupts a 40-hour print file is unacceptable, and the only defence that scales is a
golden-file test suite over real slicer output.

### 3.1 The pipeline

A recipe is an ordered list of enabled steps. Each step implements:

```ts
interface Transform {
	onStart?(ctx: RunContext): void;
	onLine(ctx: LineContext, line: string): string | string[] | null;   // null = drop the line
	onEnd?(ctx: RunContext): string[] | void;                            // trailing emissions
}
```

`LineContext` carries the running machine state — line number, current layer index, current Z,
active tool, feedrate, absolute/relative extrusion mode, current `M486` object, and the parsed
slicer metadata — computed **once** by `state.ts` and shared by every step, so a ten-step recipe
still reads the file once and tokenises each line once.

Steps run **line-by-line in order** (step 1's output is step 2's input, per line). PrusaSlicer's
per-layer-block semantics for multi-line regex matching is supported by a step opting into
`blockMode`, where the pipeline buffers a layer at a time and hands the step the whole block —
this is the only place buffering happens, and it is bounded by one layer.

### 3.2 Memory and large files — the main engineering constraint

G-code files are routinely 50–200 MB, and a naive download-to-string, replace, upload peaks at
three or four times the file size in JS heap and locks the UI thread for minutes.

The design:

1. Download as **`blob`** (not `text`) — one copy, off-heap, with progress and cancel.
2. Transfer the Blob to the worker (structured-clone of a Blob is cheap — no copy of the bytes).
3. In the worker, iterate `blob.slice(offset, offset + 4MB)` through a streaming `TextDecoder`,
   split on newlines, carrying the partial trailing line between chunks.
4. Push transformed lines into an output buffer; every ~8 MB, flush the buffer into an array of
   `Blob` parts and release the string.
5. Assemble one `Blob` from the parts at the end, transfer back, upload.

Peak heap is roughly input Blob + output Blob + ~12 MB of working strings, and the UI thread never
blocks. Progress is reported by byte offset. A hard "this file is over 250 MB, this will be slow"
warning sits in front of it.

### 3.3 Writing back — safety

The failure mode that matters is a half-written or wrong file replacing a good one. So:

- **Dry run is the default.** Apply is a second, explicit action, off the back of a diff you have seen.
- **Never touch the file currently printing** — checked against `model.job.file.fileName`, and
  against the machine state being `processing` or `simulating`.
- **Backup before in-place overwrite** into `0:/gcodes/.postproc/backups/`, with a retention
  setting and a restore button.
- **Atomic-ish write**: upload to `<target>.pp.tmp`, then `machineStore.move(tmp, target, true)`.
  An interrupted upload leaves the original intact and a `.tmp` to clean up.
- **Verify after write**: re-list the target directory and compare the byte size against what was
  uploaded; a mismatch is a loud error and the backup is retained.
- **Idempotency stamp**: a `; postprocessed-by: GCodePostProcessor v… recipe=<name> hash=<sha>`
  header line. Re-running a recipe on a file that already carries that exact stamp warns before
  proceeding, which is what stops "ran the retraction tweak three times" bugs.
- **Output modes**: in place (with backup), alongside as `<name>.pp.gcode`, or into a chosen folder.

### 3.4 Scripting — two tiers

The request was "run some sort of script on the gcode like slicers do". Slicers shell out to a
local Python/Perl executable, which a browser cannot. Two tiers replace it:

**Tier 1 — Rules (no eval).** A declarative condition/action DSL, interpreted, that covers the
overwhelming majority of real post-processing scripts: *when line matches this regex, and layer is
at least 5, and the active tool is 1, then scale parameter F by 0.8*. Serialisable, diffable,
shareable, CSP-proof, and every rule is a unit test. This is the primary scripting experience and
it drives the same `Transform` interface as everything else.

**Tier 2 — JavaScript step.** For everything else. User JS runs inside the processing worker via
`new Function`, wrapped so it receives a frozen API and nothing else:

```js
// available: line, ctx (lineNo, layer, z, tool, feedrate, relativeE, object, meta),
//            emit(text), drop(), state (per-run scratch object), log(msg)
if (ctx.layer === 3 && line.startsWith("G1 Z")) {
	emit('M291 P"reached layer 3" S0');
}
return line;
```

Hardening, in the worker, **before** user code is evaluated: `fetch`, `XMLHttpRequest`,
`WebSocket`, `importScripts` and `indexedDB` are deleted from the worker global, so a script
cannot exfiltrate a file or call home. It still runs with the browser's CPU, so an infinite loop is
possible — mitigated by a watchdog that aborts a run whose script exceeds a per-line time budget.
Imported or pasted scripts require an explicit "I have read this script" confirmation, and the
bundled library is the safe on-ramp.

Both tiers sit behind one `ScriptEngine` interface, so if DWC ever ships a CSP that blocks
`unsafe-eval`, Tier 2 degrades to "unavailable" and Tier 1 keeps working.

**Tier 3 (future, optional): a DSF companion.** On Duet 3 + SBC, a small DSF plugin could run
*actual* post-processing scripts server-side — Python or Bash handed the file path, exactly the
slicer contract — triggered by the same recipes. Out of scope for v1, but designed for by keeping
the recipe format execution-environment-agnostic.

---

## 4. Phased delivery

Each phase is independently useful and independently shippable.

### Phase 0 — Scaffold
Repo, `plugin.json` (`id: GCodePostProcessor`), `package.json` on `dwc-plugin-runtime` +
`dwc-plugin-test-kit`, vitest config, CI on the shared workflow pinned to a real tag, GPL-3.0,
`CLAUDE.md`. Route registered, empty page mounts, CI green.

### Phase 1 — Browse and inspect *(read-only, zero risk)*
`GcodeBrowser` (FileList wrapper + fallback), file selection persisted to `localStorage`,
`FileInspector` showing slicer and version, print time, filament, layer height and count, bounding
box, tools and heaters used, `M486` objects, thumbnail, dialect detection, and a command histogram.
Header and footer viewer with a raw line view and jump-to-layer.
*Ships as a genuinely useful "what is in this file" tool on its own.*

### Phase 2 — Engine + find/replace
`tokenise`, `state`, `pipeline`, the worker, the chunked read/write, `findReplace` (literal and
regex, case, whole-word, first/all, block mode), `DiffPreview`, dry run, and the full safety layer
from §3.3. One step type, complete end-to-end path, heavily tested.
*This is the milestone where the plugin does the thing the request asked for.*

### Phase 3 — The step library
`commandMap`, `insertAt`, `deleteLines`, `paramRewrite`, `rangeVary` (the calibration-tower step),
plus the schema-driven step forms and the registry-looped smoke test. Bundled preset recipes:
Marlin-to-RRF dialect conversion, pause-at-layer, timelapse triggers, strip thumbnails and
comments, absolute/relative extrusion conversion.

### Phase 4 — Recipes and automation
Named recipes stored under `settings.plugins.gCodePostProcessor` (board-following, per the
duet-tool-align pattern), import/export JSON, per-recipe filename and slicer matching rules, batch
processing over a folder, and auto-run on `fileUploaded` (opt-in, confirm-first by default).
Backup manager with restore.

### Phase 5 — Scripting
Rules DSL, then the JS step and its sandbox, the script library, per-script parameter schemas that
auto-generate their own form, and the watchdog.

### Phase 6 — Preflight checks
Non-mutating validation against the live object model: bounding box against `M208` limits, tools
and heaters referenced actually exist, temperatures within `M143` limits, commands unknown to RRF,
missing homing, first-layer sanity. Presented as a report, and usable as a gate before applying.

### Phase 7 — Polish and release
Flexible-Layouts embeddable widget, About dialog, diagnostics report and self-update via
`dwc-plugin-runtime`, `docs/usage.md`, i18n, mobile and touch layout, and an automated release
workflow mirroring the other plugins in this family.

---

## 5. Testing strategy

- **Unit tests** over every `model/` module — tokeniser, state machine, metadata parsers, each
  step, recipe serialisation, output-path planning.
- **Golden-file tests**: small real fixtures sliced by PrusaSlicer, SuperSlicer, OrcaSlicer, Cura
  and Simplify3D live in `test/fixtures/`; each preset recipe has an expected output committed.
  A diff in CI is a regression, full stop.
- **Property-style checks** for the invariants that matter: a no-op recipe is byte-identical; a
  chunked run over the same input produces identical bytes at every chunk-boundary size (this is
  where a streaming decoder breaks if it is going to); dropping zero lines never changes the line
  count.
- **Mount tests** via `dwc-plugin-test-kit` for every component, plus the registry-driven loop test
  that mounts every step form automatically as steps are added.
- **A safety suite** specifically around §3.3: refuses the printing file, writes the backup, moves
  the temp file, detects a size mismatch.

---

## 6. Open questions

1. **Auto-run on upload** only works while a DWC tab is open. Is browser-tab-dependent automation
   worth shipping, or should it wait for the DSF companion? *(Proposal: ship it, labelled clearly —
   the common case, uploading from the slicer while watching DWC, is exactly when a tab is open.)*
2. **How far to take dialect conversion.** A genuine Marlin-to-RRF converter is a large sub-project
   with real correctness risk. *(Proposal: ship a curated, documented mapping table of the ~20
   common commands, and be explicit that it is not a general translator.)*
3. **Arc fitting, G2/G3 welding** — high value, but a geometry algorithm rather than a text
   transform. Later phase, or a separate plugin.
4. **Where recipes live.** Board settings (follow the printer, shared between browsers) versus
   `localStorage` (private, survives a board reset). *(Proposal: board settings, matching
   duet-tool-align, with export/import as the escape hatch.)*

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Corrupting a good print file | Dry run default, diff preview, backups, atomic temp-then-move, size verification, never touch the running job, idempotency stamp |
| Memory blow-up on a 200 MB file | Chunked Blob read, streamed decode, flushed output parts; hard warning above a threshold; cancel at any point |
| DWC 3.7 alpha API drift (`FileList`, composables, `window.DWC.Components`) | Every DWC touch behind a seam; the browser has a self-contained fallback; `dwcVersion: auto-major` and CI against `v3.7-dev` |
| A future DWC CSP killing `new Function` | Tier-1 rules need no eval; Tier 2 sits behind one `ScriptEngine` interface that can report "unavailable" |
| Hostile or broken user script | Network APIs deleted from the worker global before user code runs; explicit trust prompt for imported scripts; per-line time watchdog |
| Upload interrupted mid-write | Temp file plus move; original untouched; orphaned `.tmp` cleaned up on the next run |
