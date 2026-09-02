# Suggested features

Grouped by area, tagged with the phase from [PLAN.md](PLAN.md) that would deliver them.
**v1** = the first release worth installing. **Later** = wanted, not blocking.

> **v1.0.0 delivers every item tagged v1**, plus the rules tier (C1), the script tier (C2–C4), the
> calibration-tower step (B6), the range of insertion anchors (B3), the preflight checks (E8–E12),
> the Flexible-Layouts widget (F1), the backup manager with restore/download/delete (D7), the fan
> audit and per-feature override (G3), `M98` macro validation (G5), cold-extrusion and end-of-file
> hygiene checks (G8), the Marlin tool-scoped temperature fix (H8), the move-time model with the
> `M73` rewrite (G1), predictive pre-heat before a tool change (G2), arc welding (B16), and the
> volumetric flow-rate audit with feedrate clamping (G6–G7). Still outstanding: auto-run on upload
> (D5), batch processing (D6), automatic recipe selection (D4), run history (D8), and the "Later"
> items.
> See [PLAN.md](PLAN.md#status) for the deviations.

---

## A. Browsing and inspection

| # | Feature | Phase |
| --- | --- | --- |
| A1 | **SD-card G-code browser** — breadcrumbs, folders, sort, name filter, tile/list view, thumbnails; reuses DWC's own `FileList` where available | 1 · v1 |
| A2 | **Multi-select** for batch operations | 4 |
| A3 | **File inspector** — slicer name and version, print time, filament length/weight/cost, layer height, layer count, bounding box, tools and heaters used, `M486` object list, embedded thumbnail | 1 · v1 |
| A4 | **Dialect detection** — flags a file as RRF-flavoured, Marlin-flavoured or Klipper-flavoured from the commands it actually uses | 1 · v1 |
| A5 | **Command histogram** — which G/M codes appear and how often; the fastest way to spot something the firmware will reject | 1 · v1 |
| A6 | **Header/footer viewer** and a raw line viewer with jump-to-layer and jump-to-line | 1 · v1 |
| A7 | **Compare two files** — diff a post-processed file against its backup, or two slices of the same model | Later — the one item left in PLAN.md §8 phase 15; needs a UI place to hold two loaded files at once, unlike the rest of that phase |
| A8 | **Layer slider preview** using DWC's existing G-code viewer plugin if installed | Later |

## B. Transformations

| # | Feature | Phase |
| --- | --- | --- |
| B1 | **Find and replace** — literal or regex, case-sensitive, whole-word, first-match or all, per-line or per-layer-block. Deliberately PrusaSlicer *G-code Substitutions*-compatible so existing rules port across | 2 · v1 |
| B2 | **Command mapping table** — rewrite one command as another with parameter capture: `M900 K0.05` → `M572 D0 S0.05`, `M205 X…` → `M566 X…`, `M84` → `M18`, tool-number remaps | 3 · v1 |
| B3 | **Insert at anchor** — inject lines at file start/end, before/after layer N, at a Z height, every N layers, at first layer change, before/after a tool change, before/after an `M486` object, at a percentage of progress, or before/after any matched pattern | 3 · v1 |
| B4 | **Delete or comment out** matching lines | 3 · v1 |
| B5 | **Parameter rewrite** — scale, offset or clamp a numeric parameter on matched commands: all feedrates ×0.8, every Z +0.02, clamp E per move | 3 · v1 |
| B6 | **Range-varying parameter (calibration towers)** — sweep a value across layers or Z bands, turning any print into a pressure-advance / temperature / speed / retraction tower without re-slicing | 3 |
| B7 | **Pause / filament change at layer** — pick the layer in the UI, inject `M600` or `M25` plus a macro call | 3 · v1 |
| B8 | **Timelapse triggers** — a macro call or `M118` at each layer change, the single most-requested post-process on the Duet forum | 3 · v1 |
| B9 | **Replace slicer start/end G-code with a macro call** — swap a wall of slicer preamble for `M98 P"start.g"`, so the printer owns its own start sequence | 3 |
| B10 | **Absolute ↔ relative extrusion conversion** | 3 |
| B11 | **Strip** — thumbnails, comments, line numbers and checksums; big file-size reductions for slow SD writes | 3 |
| B12 | **Object labelling** — add or normalise `M486` markers, converting Cura/Orca object comments so cancel-object works | 3 |
| B13 | **Cooling / fan overrides by layer range** — superseded by the more useful by-*feature* override, done in phase 10 (`fanByFeature` step) | 3 |
| B14 | **Marlin-to-RRF preset** — a curated, documented mapping bundle for the ~20 commands that actually differ (explicitly not a general translator) | 3 |
| B15 | **Z-offset / mesh injection** — insert or replace `G31`, `G29 S1`, baby-stepping at the top of a file | 3 |
| B16 | ✅ **Arc welding** (G1 runs → G2/G3) — Done — `model/gcode/arcFit.ts`, `model/steps/arcWeld.ts`; RRF executes arcs natively and its source explicitly accommodates ArcWelder output. Un-welding is a separate, later task | — |
| B17 | **Retraction rewriting** — convert firmware retraction to explicit E moves or vice versa | Later |

## C. Scripting

| # | Feature | Phase |
| --- | --- | --- |
| C1 | **Rules DSL (no eval)** — declarative *when condition then action*, composable, serialisable, unit-testable; covers most real post-processing scripts without arbitrary code | 5 · v1 |
| C2 | ✅ **JavaScript step** — user JS with `line`, `ctx` (layer, Z, tool, feedrate, extrusion mode, object, slicer metadata), `emit()`, `drop()`, per-run `state` and `log()` | Done — `model/steps/script.ts`. Not literally a worker (the bundle is a single IIFE, see PLAN.md §3.2): two engines instead, both per-line, "fast" (`new Function`) and "sandboxed" (a real QuickJS VM) — see C3 |
| C3 | ✅ **Script sandbox hardening** — network APIs unreachable before user code runs, a time watchdog, explicit trust prompt for imported scripts | Done — the "sandboxed" engine (`model/steps/quickjs/`) runs inside a real QuickJS VM with no network/DOM globals to begin with (not shadowed — genuinely absent), a real memory limit, and a wall-clock interrupt handler verified against an actual infinite loop. The original "fast" engine's guardrail (shadowed globals, an averaged-time watchdog) ships alongside it as the no-download default. Both require the same explicit trust prompt |
| C4 | **Bundled script library** — worked examples for the common asks, ready to copy and edit | 5 |
| C5 | **Script parameter schemas** — a script declares its inputs and the plugin generates the form, so a shared script is usable without editing code | 5 |
| C6 | **Import/export scripts and rules** as JSON, with a share-by-URL/gist path behind a trust confirmation | 5 |
| C7 | **DSF companion for real server-side scripts** (Python/Bash handed the file path, exactly the slicer contract) on Duet 3 + SBC | Later |

## D. Recipes and automation

| # | Feature | Phase |
| --- | --- | --- |
| D1 | **Named recipes** — ordered steps, each individually enabled/disabled, reorderable, duplicable | 4 · v1 |
| D2 | **Recipe storage on the board** so it follows the printer, not the browser | 4 · v1 |
| D3 | **Import/export recipes** as JSON | 4 · v1 |
| D4 | **Recipe matching rules** — auto-select a recipe by filename glob, folder, or detected slicer | 4 |
| D5 | **Auto-run on upload** — hooks DWC's `fileUploaded` event; opt-in, confirm-first by default, with a silent mode. Works while a DWC tab is open | 4 |
| D6 | **Batch processing** over a selection or a whole folder, with progress and cancel | 4 |
| D7 | **Backup manager** — browse, restore and prune backups with a retention policy | 4 · v1 |
| D8 | **Run history** — what ran, on what, when, with what result | 4 |

## E. Safety and validation

| # | Feature | Phase |
| --- | --- | --- |
| E1 | **Dry run with diff preview** — unified diff, per-rule hit counts, jump between changes. Default action; applying is a separate deliberate step | 2 · v1 |
| E2 | **Never touch the running job** — refuses the printing or simulating file outright | 2 · v1 |
| E3 | **Automatic backup** before any in-place overwrite | 2 · v1 |
| E4 | **Atomic write** — upload to a temp name, then move into place; an interrupted transfer never destroys the original | 2 · v1 |
| E5 | **Post-write verification** — byte size checked against what was sent | 2 · v1 |
| E6 | **Idempotency stamp** — a header line recording recipe and hash; re-running the same recipe warns first | 2 · v1 |
| E7 | **Large-file guard** — warning and time estimate above a size threshold, cancel at any point | 2 · v1 |
| E8 | **Preflight: bounding box vs machine limits** — compares the file's extents against `M208` from the live object model | 6 |
| E9 | **Preflight: referenced tools, heaters and fans exist** on this machine | 6 |
| E10 | **Preflight: temperatures within `M143` limits** | 6 |
| E11 | **Preflight: commands RRF does not know** — dictionary-driven, flags Marlin/Klipper leftovers before they stall a print | 6 |
| E12 | **Preflight: structural sanity** — missing homing, duplicated start G-code, missing `M400` before a critical move, no `T` selected before extrusion | 6 |
| E13 | **Preflight as a gate** — optionally block Apply while errors are outstanding | 6 |

## F. Integration and UX

| # | Feature | Phase |
| --- | --- | --- |
| F1 | **Flexible-Layouts embeddable widget** — "post-process the selected job" plus recent runs, in a dashboard tile | 7 |
| F2 | **Run report** — rules applied, lines added/changed/removed, time taken, warnings, downloadable log | 4 |
| F3 | **Self-update and About dialog** via `dwc-plugin-runtime`, wired into the shared cross-plugin update hub | 7 · v1 |
| F4 | **Diagnostics report** — captured errors plus sanitised object model, replayable directly into a regression test | 7 |
| F5 | **i18n** and full dark-mode support | 7 · v1 |
| F6 | **Touch and mobile layout** for the 4.3"/7" panel case | 7 |
| F7 | **`docs/usage.md`** — the full guide, linked from the About dialog | 7 · v1 |

---

## G. Machine-aware features (post-v1)

The ideas that need the printer's own knowledge — its heater tuning, its axis limits, its file
system — and so cannot be done by a slicer or by a desktop script. Designed in
[docs/feature-ideas.md](docs/feature-ideas.md).

| # | Feature | Notes |
| --- | --- | --- |
| G1 | ✅ **Move-time model** using this machine's M201/M203/M204/M566, and rewriting `M73` so DWC's remaining-time is right — Done — `model/gcode/timeModel.ts`, `dwc/machineSnapshot.ts` (`machineLimits`), `model/steps/rewriteTime.ts` | The enabler for G2–G4; useful alone |
| G2 | ✅ **Predictive pre-heat before a tool change** — estimates heat-up from the M307 model and inserts `M568 P<n> A2` at the right moment — Done — `model/preheat.ts`, `model/steps/preheat.ts` | Needs G1 (done) and the lookahead pass (done — `model/analysisPass.ts`) |
| G3 | ✅ **Fan audit and per-feature override** — every fan speed in the file by feature, and overrides for bridging, overhangs, external perimeters | Done — `model/gcode/features.ts`, `model/steps/fanByFeature.ts` |
| G4 | ✅ **Restart from layer N** — rebuild a runnable file after a failure | Done — `model/recovery.ts`, `model/steps/restartFrom.ts`. Z re-homing is opt-in, off by default (a probe would probe the part, not the bed); no first-layer adhesion trickery is invented |
| G5 | ✅ **Validate `M98` macro references** against the SD card | Done — `dwc/macroCheck.ts` |
| G6 | ✅ **Volumetric flow-rate audit** — mm³/s demanded vs what the hot end can melt, from the slicer's own stated filament diameter, never assumed | Done — `model/analysis.ts`, `model/checks.ts` |
| G7 | ✅ **Feedrate and acceleration clamping** to the machine's real limits, with an honest report of how much time that adds | Done — `model/steps/clampFeedrate.ts`, `model/gcode/timeModel.ts` |
| G8 | ✅ **Cold-extrusion and end-of-file hygiene checks** | Done — `model/checks.ts` |
| G9 | ✅ **`M486` object labelling**, including from Klipper `EXCLUDE_OBJECT` | Done — `model/steps/objectLabels.ts`. `EXCLUDE_OBJECT_DEFINE`/`_START`/`_END` → `M486`; inventing labels for an unlabelled file is a separate, later task (needs geometry segmentation) |
| G10 | ✅ **`M37` simulation round-trip** — the firmware's own time estimate | Done — `model/io/simulate.ts`, `FileGateway.sendCode` (the first thing in this plugin that talks to the printer). Shows the result next to the plugin's own estimate; writing it back into `M73` is a manual follow-on (re-run "Rewrite print time"), not automatic |
| G11 | ✅ **Extract or split a layer range** into a standalone file | Done — `model/steps/extractRange.ts`. A split is two extractions with adjoining ranges; not state-reconstructing (that's G4) — the result is a partial file for debugging or splitting, not a runnable print |
| G12 | ✅ **Per-feature and layer-time statistics** | Done — `model/analysis.ts` (`featureStats`, `slowestLayers`, `objectStats`), rendered in `FileInspector.vue`. Time needs machine limits; filament does not |
| G13 | ✅ **Conditional steps** — run a step only when a condition on the file's own slicer metadata holds | Done — `model/stepCondition.ts`, `RecipeStep.condition`. Metadata-only, not `FileAnalysis`-aware — see PLAN.md §8 phase 15 for why. A skipped step is named in the run report, not silently absent |
| G14 | ✅ **Apply and start the job** — offer to start the resulting file printing once it is written | Done — `model/io/applyAndStart.ts`, built on `M32` (verified against RepRapFirmware source). A checkbox on the existing Apply confirmation, never available for a dry run |

## H. Longer-term candidates

Designed in [docs/feature-ideas.md](docs/feature-ideas.md) sections 7-8. Items marked with a caret
were prompted by [G-Code Modifier](https://github.com/little-did-I-know/Gcode) (MIT, (c) 2026
little-did-I-know) - ideas only, no code taken; see [docs/attribution.md](docs/attribution.md).

| # | Feature | Notes |
| --- | --- | --- |
| H1 | ^ **Hole detection with insert pauses** - find voids that get roofed over, report the depth, offer a pause at each | The standout borrow; present as candidates to tick, never an automatic rewrite. **Investigated and stopped** — `model/gcode/voids.ts`'s detector, checked against a real 250-layer dense slice per task 12 §4's own stop point, produced 16–1,139 false-positive candidates (depending on grid resolution) on a single object with no intentional cavities at all, mostly from rasterising curved thin walls. Not built further: no collector, no step, no UI |
| H2 | ✅ ^ **Minimum layer time enforcement** on a thermal basis - slow or dwell on layers too fast to cool | Done — `model/steps/minLayerTime.ts`. Never slows below a configured feedrate floor; reports a layer that cannot reach the target rather than mangling it |
| H3 | ✅ ^ **Eject sequence preset** for print farms | Done — `presets.ts`'s "Eject sequence (template)". Every move ships commented out; it is a shape to edit for your own machine, not a ready sequence |
| H4 | ✅ ^ **Per-layer Z-offset preset** - first-layer squish, or a correction partway up | Done — `presets.ts`'s "Per-layer Z-offset", over the existing `paramRewrite` step |
| H5 | ^ **G-code command palette with click-to-insert** in the insert and rules editors | Cheapest route may be the upstream Monaco ask |
| H6 | ^ **Geometric warp-risk notes** - large flat first layers, tall thin features, high-shrinkage material | Information-level only; no pretence of prediction |
| H7 | ✅ **Pressure advance (and other parameters) per filament**, from the file's own metadata | Done — no dedicated table/step; G13's conditional steps already cover it, one existing step added per filament, each gated by its own `filament_type` condition. Documented with a worked example in `docs/usage.md` |
| H8 | ✅ **Marlin tool-scoped temperatures** - `M104 S200 T1` becomes `M568 P1 S200` | Done — `commandMap`'s `onlyWithParam` |
| H9 | ✅ **Tool renumbering** - remap T0 to T2 without mangling comments and `M568 P0` | Done — `model/steps/toolRenumber.ts`. Rewrites bare `T<n>` and the tool-number parameter of `M563`/`M567`/`M568`/`M116`, verified command-by-command against the RRF G-code dictionary; deliberately leaves `M106`/`M107` (fan index), `M585` (Z probe number) and `G10` (ambiguous with a workplace coordinate system) alone |
| H10 | ✅ **Z-hop injection** on travels above a length threshold | Done — `model/steps/zHop.ts`, sharing travel detection with H11 via `model/steps/travel.ts`. Skips a travel with an existing hop, and the whole rest of a file using firmware retraction (`G10`/`G11`) |
| H11 | ✅ **Ooze control** - retract or drop temperature before long travels | Done — `model/steps/oozeControl.ts`. Temperature drop is opt-in and only fires when a prior temperature is known to restore |
| H12 | ✅ **Bed-temperature ramp** after the first N layers | Done — `presets.ts`'s "Bed-temperature ramp", over `insertAt`. Uses `M140`, never `M190` — the latter waits and would stall the print with the nozzle hot over the part |
| H13 | ✅ **`M291` confirmation gates** at chosen points | Done — `presets.ts`'s "Confirmation gate at a layer". `M291 ... S2` genuinely blocks on its own, verified against `Duet3D/wiki-content` and RepRapFirmware's own source (`GCodes7.cpp`'s `DoMessageBox`) — no `M25` needed |
| H14 | ✅ **Timelapse trigger on each object's top layer only** | Done — `model/steps/timelapseTopLayer.ts` (an `analysisPass` collector, same pattern as `preheat`) plus `presets.ts`'s "Timelapse trigger per object". A file with no `M486` labels is left untouched and reported, never falls back to firing every layer |
| H15 | ✅ **Plain-English file summary** generated from the analysis | Done — `model/summary.ts`'s `summariseFile`, shown at the top of the inspector |
| H16 | **Integrate with DWC's G-code viewer** - jump it to the layer under discussion | Rather than building a second 3D engine |

## Proposed v1 scope

Everything tagged **v1** above: browse, inspect, find/replace, the core step library, the rules
DSL, recipes on the board, dry-run diff, and the complete safety layer. That is a plugin that does
what a slicer's *Output options* page does, against files already on the printer — which is the
whole point of the exercise.
