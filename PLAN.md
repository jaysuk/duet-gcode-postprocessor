# Build plan — duet-gcode-postprocessor

A DuetWebControl 3.7 plugin that post-processes G-code files already sitting on the Duet's SD
card. Planning document: architecture, phased delivery, decisions and risks. Feature list lives in
[FEATURES.md](FEATURES.md).

---

## Status

Implemented in v0.1.0, with 626 tests green and `typecheck` + `verify-build` passing against DWC
`v3.7-dev`. Nine work orders in `docs/tasks/` are complete: `01-defects.md`,
`02-fan-audit-and-override.md` (§8 phase 10), `03-machine-aware-checks.md` (§8 phase 12, partially),
`04-move-time-model.md` (§8 phase 8), `05-analysis-pass.md` (§8 phase 9), `06-preheat.md`
(§8 phase 11), `07-audit-defects.md` (a defect pass on 04–06 found by auditing that work rather than
by a hardware report), `08-arc-welding.md`, and `09-flow-and-clamping.md` (finishes §8 phase 12).

**Built:** phases 0–3 in full, plus most of 4–7, plus phases 8–12 in full, plus arc welding — the
browser (reusing DWC's own `FileList` where available, with a self-contained fallback), the
inspector and its preflight checks, the streaming engine and safe write path, thirteen step types,
recipes with import/export and board-backed storage, the diff preview, the Flexible-Layouts widget,
self-update, a backup index with a restore/download/delete UI, feature-type normalisation across
slicers, a fan-speed audit, a fan-by-feature override step, `M98` macro validation, cold-extrusion
and end-of-file hygiene checks, a `commandMap` condition (`onlyWithParam`) that fixed a real
mistranslation in the Marlin preset, a machine-aware move-time model with an inspector estimate
alongside the slicer's own, a `rewriteTime` step that recomputes `M73` markers from it, an opt-in
second read-only pass over the file for steps that need to see a whole-file fact before the
transform pass reaches it, a predictive pre-heat step using RRF's own `M307` heater model, an
`arcWeld` step that collapses curved `G1` runs into `G2`/`G3`, a volumetric-flow audit that never
assumes a filament diameter or invents a flow ceiling, a `clampFeedrate` step and a matching
clamped-vs-unclamped time comparison in the inspector, and the usage guide.

**Deviations from the plan, and why:**

1. **No Web Worker.** §3.2 called for one; the pipeline instead runs on the main thread over the
   same chunked Blob read, yielding to the event loop every ~16 ms. The plugin bundle is a single
   IIFE with no dynamic `import()`, so a worker needs the entire pipeline inlined into it at build
   time — a build-level change, not a code-level one. The chunking, the memory profile and the
   working Cancel button are all as designed; only the thread differs. Vite's `?worker&inline` is
   the likely route and is untested against DWC's rolldown-based lib build.
2. **Find and replace is per line, not per layer block.** PrusaSlicer applies substitutions to a
   whole layer block, so a regex there can span lines. Supporting that means buffering a layer and
   splitting the step chain around block-mode steps, which roughly doubles the pipeline's
   complexity for a feature most rules do not use. Documented in `docs/usage.md`; deferred.
3. **The script tier is a guardrail, not a sandbox.** The network globals are shadowed and a
   watchdog catches runaway loops, but `new Function` code can still reach the real global object.
   A trust gate stands in front of it. `docs/scripting-engines.md` sets out what a real sandbox
   (QuickJS in WASM) and real Python (Pyodide) would take.
4. **i18n is scaffolded, not applied.** The nav caption and widget strings go through
   `registerPluginMessages`; the rest of the UI is literal English.

**Not built yet:** auto-run on upload (D5), batch processing (D6), automatic recipe selection by
filename (D4 — the field exists and is stored, nothing consumes it), and run history (D8). D7
(backup browser) is now done — see `model/io/backups.ts` and `components/BackupManager.vue`.

**Next:** tasks 01–09 are done — the whole of phases 8–12. Phases 13–15 remain deliberately
unspecified — see the work-order queue's own note on why: they need a hardware session first.

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
├── components/                  render + delegate; no transformation logic lives here
│   ├── PostProcessorPage.vue    the page: browser | recipe | inspect | preview | backups tabs
│   ├── PostProcessorWidget.vue  compact Flexible-Layouts tile (preview only, no Apply)
│   ├── GcodeBrowser.vue         DWC FileList wrapper, with a self-contained fallback list
│   ├── FileInspector.vue        metadata, stats, dialect, preflight checks
│   ├── RecipeEditor.vue         ordered step list, reorder, import/export, bundled presets
│   ├── StepFields.vue           ONE schema-driven form that renders every step type
│   ├── DiffPreview.vue          the diff, per-step hit counts, run statistics
│   └── BackupManager.vue        lists, restores, downloads and deletes backups
├── dwc/                         the only layer that may import from @/stores/* — everything here
│   │                            narrows DWC's loosely-typed world into what model/ consumes
│   ├── gateway.ts               FileGateway implementation over the machine store
│   ├── machineSnapshot.ts       object-model narrowing: preflight snapshot, job file, plugin version
│   └── recipeStore.ts           recipe persistence — board settings, localStorage fallback
├── model/                       ← ALL transformation logic here, pure, unit-tested, no Vue/DWC imports
│   ├── constants.ts
│   ├── analysis.ts              single-pass file analysis feeding the inspector + preflight checks
│   ├── checks.ts                the preflight rules, pure (takes a plain machine snapshot)
│   ├── pipeline.ts              compose steps, drive lines through, collect stats + diff
│   ├── recipe.ts                recipe type, (de)serialise, validate, the identity stamp
│   ├── presets.ts               bundled recipes
│   ├── updateCheck.ts           self-update — the one model/ module that does talk to DWC directly
│   ├── gcode/
│   │   ├── tokenise.ts          line → { command, params, comment, raw } — quote- and escape-aware
│   │   ├── state.ts             running machine state: layer, Z, tool, feed, abs/rel E, M486 object
│   │   ├── metadata.ts          slicer header/footer parser (Prusa, Super, Orca, Cura, S3D, ideaMaker)
│   │   └── dialect.ts           detect Marlin / Klipper / RRF flavour from command usage
│   ├── steps/                   one module per step type, all implementing Transform
│   │   ├── types.ts             the Transform interface + the field-schema StepDefinition
│   │   ├── findReplace.ts  commandMap.ts  insertAt.ts  deleteLines.ts  paramRewrite.ts
│   │   ├── rangeVary.ts  rules.ts  script.ts
│   │   ├── scriptApi.ts         the tokeniser-backed helpers handed to a script (gcode.parse/set/…)
│   │   └── registry.ts          id → StepDefinition — drives the UI and a self-maintaining test
│   └── io/
│       ├── plan.ts              output naming, backup naming, collision + safety rules (pure)
│       ├── backups.ts           the backup index: parse/add/prune/serialise (pure)
│       └── transfer.ts          the only impure model/ module: chunked download → transform → upload
└── i18n/en.json
```

The hard rule from the template guide applies with force here: **`model/` is pure and
exhaustively unit-tested**; `.vue` files only render and call into it; `dwc/` is the sole seam
between the two. A post-processor that silently corrupts a 40-hour print file is unacceptable, and
the only defence that scales is a golden-file test suite over real slicer output.

There is no `worker/` directory and no per-step form components — see the Status section above for
why (no Web Worker; `StepFields.vue` is schema-driven rather than one file per step) and
`docs/tasks/05-analysis-pass.md` for the two-pass design a future worker would sit inside.

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
- **Backup before in-place overwrite** into `0:/postproc/backups/`, indexed in
  `0:/postproc/backups.json` (original path, timestamp, size, recipe) so it can be restored to where
  it came from — see `model/io/backups.ts` and `components/BackupManager.vue`. Pruned to the newest
  `MAX_BACKUPS` (20).
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

---

## 8. Roadmap beyond v1

Phases 0–7 delivered the post-processor itself. What follows is what makes it worth having *on the
printer* rather than as a desktop script — the features that need the machine's own knowledge of
itself. Design detail for every item is in [docs/feature-ideas.md](docs/feature-ideas.md); the
feature tables are in [FEATURES.md](FEATURES.md) §G–H.

Ordered by dependency, not by appeal. The first two are infrastructure that four later features
need, and building them late means building the later features twice.

### Phase 8 — the move-time model *(unlocks 11, 12)* *(done)*

A per-move time estimate using **this machine's** `move.axes[].speed`/`acceleration`/`jerk` and
`move.printingAcceleration`/`travelAcceleration`, rather than the slicer's profile for a printer it
guessed at. Trapezoidal per move, clamped by axis limits and by jerk at direction changes.

Where the slicer has emitted `M73 P<percent> R<minutes>` markers (PrusaSlicer, SuperSlicer, Orca,
Bambu all do), interpolate those instead and skip the modelling — then say which source was used.

**Ships on its own as:** rewriting the `M73` markers with the machine-corrected estimate, so DWC's
remaining-time is right. That is a reason to install the plugin all by itself.

- ✅ `moveTime`/`TimeEstimator` (`model/gcode/timeModel.ts`), `MachineLimits` narrowed from the
  object model in `dwc/machineSnapshot.ts` (extruder limits come from `move.extruders[]`, a
  separate collection from `move.axes[]`; printing/travel acceleration prefer
  `move.motionSystems[].printingAcceleration`/`.travelAcceleration`, falling back to the deprecated
  top-level fields of the same name).
- ✅ `FileAnalysis.timeSource`/`estimatedSeconds`, shown in the inspector next to the slicer's own
  print-time estimate.
- ✅ The `rewriteTime` step, rewriting existing `M73` markers in place from the model — originally
  via a one-off pre-pass in `transfer.ts`, since folded into phase 9's general analysis pass (see
  that phase's own notes).
- ✅ **Fixed in task 07** (defect E): `machineLimits` filled in whatever it could find and stayed
  silent about the rest, so a partly-configured machine (an axis missing `acceleration`, no
  `move.motionSystems` and no deprecated fallback either) got an estimate labelled "from this
  machine's limits" that was really `TimeEstimator` quietly falling back to `distance / feedrate` for
  the missing pieces. `machineSnapshot.ts` now also exposes `machineLimitsComplete` (sharing one pass
  over the model with `machineLimits` so the two definitions cannot drift apart), and the inspector
  says "limits are incomplete" rather than presenting a partial estimate as fully machine-specific.

### Phase 9 — the analysis pass *(unlocks 11, 14)* *(done)*

The architectural change. Everything involving lookahead — pre-heating before a tool change,
restoring a fan speed when a region ends, anchoring to "90 seconds before X" — is impossible in the
current single forward pass.

`processFile` gains an optional analysis pass over the same already-downloaded Blob, before the
transform pass: no second download, no unbounded buffering, the same chunked reader. It collects
events (tool changes, feature regions, layer boundaries, cumulative time) into a compact array the
transform pass consumes by index.

Do this once and properly. Retro-fitting lookahead one feature at a time is how a clean pipeline
turns into a pile of special cases.

- ✅ `model/analysisPass.ts` — `AnalysisCollector`/`AnalysisRunner`, built on the same `LineContext`
  the transform pass uses (via `createLineContext`/`syncLineContext`, factored out of
  `pipeline.ts` so both passes build it identically).
- ✅ `StepDefinition.analysis(config, ctx)` — a step declares the collectors it needs; the extra
  `ctx` parameter (beyond the task's own sketch) is there because `rewriteTime`'s collector needs
  this machine's motion limits, which a user does not configure on the step.
- ✅ `RunContext.analysis` — a step reads its collector's result back in `onStart`. Always present
  (an empty map when no pass ran), so a step degrades to doing less rather than throwing.
- ✅ `recipe.ts`'s `collectorsFor` and the opt-in pass in `processFile`, reporting its own
  `"analysing"` phase and its own timing (`ProcessResult.analysisMs`/`transformMs`) so a two-pass
  recipe's extra cost is visible rather than folded silently into one number.
- ✅ The chunked blob-walk (`processFile`'s transform pass, `inspectFile`, and now the analysis
  pass) was extracted into one shared `forEachLine` (`io/transfer.ts`) first, per the task's own
  instruction — it had already drifted to three near-identical copies once.
- ✅ `rewriteTime` (phase 8) migrated onto this seam as its first real consumer, replacing the
  one-off pre-pass task 04 had built and explicitly flagged as temporary.
- ✅ **Fixed in task 07**: the first version ran the analysis pass over the raw downloaded blob —
  the file *before* the recipe's own steps had touched it — so a step's collector saw a different
  file than the one its own `onLine` would actually receive. `processFile` now runs one sub-pass per
  collector-declaring step, each through a throwaway `Pipeline` built from only the steps ordered
  before it (`recipe.ts`'s `buildPrefixTransforms`), and collector ids are namespaced by step index
  (`` `${id}#${stepIndex}` ``) so two instances of the same step type in one recipe no longer collide
  on one shared result. See `docs/tasks/07-audit-defects.md`, defect A.

### Phase 10 — fan audit and per-feature override *(done)*

An audit listing every fan speed in the file by feature type, and a step that overrides fan speed
per feature — bridges, overhangs, external perimeters, first layer.

Two pieces of real work: normalising slicer-specific `;TYPE:` names onto a canonical feature set
(`model/gcode/features.ts`, pure and tested), and suppressing the slicer's own `M106` inside an
overridden region so it cannot undo the override on the next line. Same machinery then gives fan
scaling, a minimum non-zero speed clamp, and a spin-up kick.

**Does not depend on phase 9.** An earlier draft said this needed the analysis pass to know where a
region ends; it does not — a region's end is observable at the transition into the next `;TYPE:`
marker, which the existing single forward pass already sees. So this is the best *first* feature:
self-contained, immediately useful, no infrastructure required, and it forces the feature
normalisation that phase 11's reporting wants anyway.

### Phase 11 — predictive pre-heat before a tool change *(done)*

Estimate heat-up time from the machine's own `M307` model (`heat.heaters[h].model.heatingRate`,
`deadTime`, `coolingRate`, `coolingExp`) between `tools[n].standby[]` and `tools[n].active[]`, walk
back that far along the time axis, and insert `M568 P<n> A2` so the tool arrives at temperature
exactly when it is needed. Optionally return a deselected tool to standby so it stops cooking
filament.

**Verify before implementing:** the normalisation of `coolingRate`/`coolingExp` (documented in units
that are easy to misread), and the `M568` A parameter, against `Duet3D/wiki-content` and RRF source.
The most distinctive feature on this roadmap, and the one where a wrong constant produces a cold
extrusion rather than a visible error.

- ✅ **Verified, not guessed**: `coolingRate`/`coolingExp` are per 100°C above ambient (confirmed in
  `HeaterModel::GetBasicCoolingRate`, RepRapFirmware source, and word-for-word in the wiki's M307
  section); `M568 A0/A1/A2` = off/standby/active and does not select the tool or wait for it
  (confirmed in `GCodes::SetOrReportOffsets`, shared with G10, and in the wiki's M568 section). Full
  citations in `model/preheat.ts`'s module comment.
- ✅ `heatUpSeconds` (`model/preheat.ts`) — numerically integrates RRF's own first-order model rather
  than a generic cooling approximation; a missing/untuned heater returns `null` rather than a guess,
  an unreachable target is capped rather than looping forever.
- ✅ `toolHeaterConfigs` (`dwc/machineSnapshot.ts`) — per-tool active/standby temperatures and tuned
  model, narrowed from `tools[]`/`heat.heaters[]`.
- ✅ The `preheat` step (`model/steps/preheat.ts`) — a `PreheatCollector` (this task's first real use
  of the phase-9 analysis pass) gathers every tool change and its position on the time axis ahead of
  the transform pass; `planPreheats` (pure, independently tested) turns that into an ordered list of
  `M568 A2`/`A1` insertions, handling every edge case the task specified: clamping to the earliest
  legitimate point, never contradicting a pending pre-heat with a standby command, skipping a change
  the file already pre-heats, and reporting a heater with no standby gap, no tuned model, or an
  unreachable target.
- ✅ **Fixed in task 07**: the first version's standby guard inspected only insertions already
  pushed and compared `atSeconds >= changeTime`, so it could not see a pre-heat for a *later*
  occurrence of the same tool and could never fire at all for one clamped to time 0 — a clamped
  pre-heat could be immediately cancelled by a standby, with the run report still claiming success.
  `planPreheats` is now two-phase (every pre-heat computed before any standby is decided). The same
  fix also corrected where a clamp lands: it used to clamp to line 0 regardless of content, which
  could set a tool active *above* the line that first states its active temperature; it now clamps
  to the earliest point that temperature is actually known (an explicit `M568`/`G10`, or the tool's
  own first selection), gated by line sequence rather than elapsed time alone, since the setup line
  and everything around it share zero elapsed time. See `docs/tasks/07-audit-defects.md`, defects
  B and C.

### Phase 12 — machine-aware checks and rewrites *(done)*

Individually small, collectively the thing that stops failed prints:

- ✅ **Validate `M98` macro references** against the SD card — catches a typo that would otherwise
  stop the print at layer 40, and this plugin's own insert steps add macro calls.
- ✅ **Volumetric flow-rate audit** — `analysis.ts` computes mm³/s per move from the slicer's own
  stated filament diameter (`meta.filamentDiameterMm`, never assumed), reporting the worst move and
  its line; `checks.ts` warns only when the slicer *also* stated its own ceiling
  (`max_volumetric_speed`, PrusaSlicer/Orca's `0` meaning "no limit" handled explicitly) and the file
  exceeds it. No threshold is invented. See
  [docs/tasks/09-flow-and-clamping.md](docs/tasks/09-flow-and-clamping.md).
- ✅ **Feedrate clamping** to the machine's real limits — `steps/clampFeedrate.ts`, reusing
  `timeModel.ts`'s own per-axis-combination limit lookup (`axisLetters`/`combinedAxisLimits`, now
  exported for exactly this) rather than a second copy that could drift from the inspector's own
  estimate. Reports how many moves were clamped and the added time; a move already within limits is
  untouched. `TimeEstimator` grew a parallel unclamped accumulator and a clamped-move count so the
  inspector can show "how much of the estimate is this machine's own limits" next to the two
  print-time figures it already had; suppressed when this machine's limits are known incomplete (see
  phase 9's finding E) rather than shown as fact. Acceleration clamping (`M204` against
  `printAccel`/`travelAccel`) is included, off by default.
- ✅ **Cold-extrusion detection** and end-of-file hygiene (heaters left on, fan running, motors live).
- ✅ **Marlin tool-scoped temperatures** — `M104 S200 T1` means tool 1 in Marlin; the RRF equivalent is
  `M568 P1 S200`. Was a real gap in the Marlin preset, and a silent mistranslation.

### Arc welding — `G1` runs into `G2`/`G3` arcs *(done)*

A slicer approximates curves with hundreds of short `G1` moves; RepRapFirmware executes real arcs.
Welding those runs back into `G2`/`G3` typically removes 50–80% of the lines in a curved file and
hands the planner a smooth path instead of a polyline. RRF's own source explicitly loosens its arc
radius tolerance *because of* ArcWelder output (`MaxNonCncRadiusError = 0.05 mm`), so this is a
transformation the firmware already expects to receive.

The interesting constraint is architectural rather than geometric: a step cannot retract lines it has
already emitted, so arc welding is the first step that must **withhold** lines — returning `null`
while it buffers a candidate run and emitting the arc when the run closes. That is within the
existing `Transform` contract, but it is the first use of it, and `onEnd` must flush.

- ✅ `model/gcode/arcFit.ts` — the pure geometry (`tryFitArc`, `arcRadiusWithinTolerance`), a
  clean-room reimplementation of ArcWelderLib's published algorithm (see `docs/attribution.md`):
  three-point circumcircle, radial-and-perpendicular deviation, arc-length-vs-polyline-length, all
  independently tested with hand-checkable circles.
- ✅ `model/steps/arcWeld.ts` — buffers a candidate run, tests it against `tryFitArc` as each point
  arrives, and restarts the buffer *at* whichever point broke the run rather than discarding it, so a
  feature/Z/rate boundary does not waste an otherwise weldable move. Breaks on every condition the
  task specified; `F` is carried onto the arc rather than treated as a break, since RRF applies one
  feedrate to the whole arc anyway.
- ✅ A real defect caught by the step's own tests before this ever ran against a fixture: `onLine`
  returning `undefined` to mean "withhold this line" — it means the opposite, "keep it as it was".
  The fix is `null` for a withheld line's own return value, which is what the pipeline's own
  `StepResult` contract actually says.
- ✅ **The rounding trap named in the task did occur in practice** — the welded output on the new
  curved fixture needed 4 decimal places on `I`/`J` to satisfy RRF's own radius check, not the 3 this
  codebase otherwise defaults to; `buildArcCommand` escalates precision until the check passes rather
  than emitting a move RRF would reject.
- ✅ `test/fixtures/arc-circle.gcode` (a full 90-point circle) collapses to a single `G3` plus a
  1-line residual — a 19-line replacement for 90 source lines — added to the golden-file matrix
  alongside a bundled "Weld curves into arcs" preset using ArcWelder's own defaults.

### Phase 13 — print recovery and surgery

- **Restart from layer N** — rebuild a runnable file after a failure. The care is in reconstructing
  state at the cut: temperatures, fan, tool, extrusion mode, absolute E, and whether to re-home Z
  against a part already on the bed.
- **Extract a layer range** into a standalone file, for debugging one bad region without re-slicing.
- **Split at a layer**, for multi-day prints or a filament budget.

### Phase 14 — geometry-aware analysis

- **Hole detection with insert pauses** *(prompted by G-Code Modifier)* — find voids that get roofed
  over, report each one's depth, and offer a pause at the closing layer so an insert can be dropped
  in. Presented as candidates to tick; the plugin cannot tell an insert boss from a lightening
  pocket.
- **Per-feature and layer-time statistics** — time and filament by feature, tool and object.
- **Minimum layer time enforcement** — slow, or dwell away from the part, on layers too fast to cool.
- **`M486` object labelling**, including converting Klipper `EXCLUDE_OBJECT` markers, so DWC's
  cancel-object works on files that did not ship with it.

### Phase 15 — closing the loop, and the long tail

- **`M37` simulation round-trip** — apply, let the firmware simulate, report its own estimate and
  optionally write it back into `M73`. No slicer can offer this.
- **Metadata-driven parameters** — pressure advance, retraction and temperature offsets from a table
  keyed on the file's own `filament_type`.
- **Conditional steps** — run a step only when a condition on the file holds.
- **Compare two files**, **plain-English file summary**, **apply and start the job**, and the
  remaining long tail in FEATURES.md §H.

### Not scheduled

Deliberately excluded rather than forgotten: a 3D viewer with heatmap overlays, in-viewport
editing, and warp prediction with material-aware failure modelling. DWC already has a G-code viewer
plugin — the right move is to *integrate* with it, jumping it to a layer this plugin is discussing,
not to build a second, worse 3D engine inside a post-processor. Warp prediction is beyond what can
be validated here; the modest version (flagging the geometry that correlates with lifting) belongs
in Phase 12's checks as information, with no pretence of prediction.
