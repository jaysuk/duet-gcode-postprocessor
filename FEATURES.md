# Suggested features

Grouped by area, tagged with the phase from [PLAN.md](PLAN.md) that would deliver them.
**v1** = the first release worth installing. **Later** = wanted, not blocking.

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
| A7 | **Compare two files** — diff a post-processed file against its backup, or two slices of the same model | Later |
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
| B13 | **Cooling / fan overrides by layer range** | 3 |
| B14 | **Marlin-to-RRF preset** — a curated, documented mapping bundle for the ~20 commands that actually differ (explicitly not a general translator) | 3 |
| B15 | **Z-offset / mesh injection** — insert or replace `G31`, `G29 S1`, baby-stepping at the top of a file | 3 |
| B16 | **Arc welding / unwelding** (G1 runs ↔ G2/G3) | Later |
| B17 | **Retraction rewriting** — convert firmware retraction to explicit E moves or vice versa | Later |

## C. Scripting

| # | Feature | Phase |
| --- | --- | --- |
| C1 | **Rules DSL (no eval)** — declarative *when condition then action*, composable, serialisable, unit-testable; covers most real post-processing scripts without arbitrary code | 5 · v1 |
| C2 | **JavaScript step** — user JS per line in a sandboxed worker, with `line`, `ctx` (layer, Z, tool, feedrate, extrusion mode, object, slicer metadata), `emit()`, `drop()`, per-run `state` and `log()` | 5 |
| C3 | **Script sandbox hardening** — network APIs deleted from the worker global before user code runs, per-line time watchdog, explicit trust prompt for imported scripts | 5 |
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

## Proposed v1 scope

Everything tagged **v1** above: browse, inspect, find/replace, the core step library, the rules
DSL, recipes on the board, dry-run diff, and the complete safety layer. That is a plugin that does
what a slicer's *Output options* page does, against files already on the printer — which is the
whole point of the exercise.
