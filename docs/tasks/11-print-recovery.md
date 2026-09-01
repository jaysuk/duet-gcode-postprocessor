# Task 11 — print recovery and layer surgery (PLAN.md §8 phase 13)

**Read [README.md](README.md) first, then [CLAUDE.md](../../CLAUDE.md).**

**Depends on [10-audit-defects.md](10-audit-defects.md).** Finding A there (arcs are invisible to the
move-time model) must be fixed first: this task's "restart from layer N" reconstructs machine state by
replaying a file, and a step that silently skips `G2`/`G3` reconstructs the wrong position on any
curved print.

---

## ⚠️ Stop point — resolve this before writing any code

This task writes a file whose **first move happens with a part already on the bed**. Getting it wrong
drives the nozzle into the print. Two questions decide the design and neither can be answered by
reading source:

1. **Does the user's machine home Z by probing the bed, or to an endstop?** A `G28 Z` that probes will
   probe *the part*, not the bed, and set Z to a height that is wrong by the part's height. A machine
   with a Z endstop at the top is safe to re-home; one with an inductive/BLTouch/eddy probe is not.
2. **What should the recovered file do about the first layer's adhesion and the cold part?** There is
   no single right answer, and the wrong one wastes filament at best.

**Do this first:** implement `recoveryPlan()` (the pure planner, §2 below) and its tests, then
**stop and report** with a written summary of what state it reconstructs and what it proposes to emit
at the cut. Do not write the file-producing half until the answers to (1) and (2) are agreed. If the
answer to (1) turns out to be "it depends on the machine and we cannot tell from the object model",
say so — that is a finding, and it changes this task from "produce a runnable file" to "produce a file
plus a mandatory human review step", which is a different feature.

`move.axes[].homed` and the presence of `sensors.probes[]` in the object model are evidence but not
proof: a machine can have a probe configured and still home Z to an endstop.

---

## 1. The gap

A print fails at layer 300 of 500 — a filament jam, a power cut, a knocked part that recovered. Today
the only options are reprint from scratch or hand-edit a 200 MB file. RepRapFirmware itself has no
"resume from layer" for a file it is not already printing.

Three related capabilities, in the order they should be built:

| | What | Why it is first/last |
| --- | --- | --- |
| **A** | **Extract a layer range** to a standalone file | Simplest, read-mostly, no state reconstruction beyond a preamble. Proves the layer-boundary machinery. |
| **B** | **Split at a layer** into two files | Same machinery as A, run twice. Nearly free once A works. |
| **C** | **Restart from layer N** | Needs everything in A *plus* correct, safe state reconstruction. The dangerous one. |

Build A, then B, then C. Do not start C before A and B are green.

## 2. The design decisions already made

**This is a step, not a new page.** It goes in `model/steps/`, registered in
`model/steps/registry.ts` like every other step — see README's house style: "A new step type is one
module plus one line in the registry." Two step types:

- `extractRange` — covers A and B (a split is two extractions; expose it as one step with a
  "from"/"to" layer pair, and let the user add it twice).
- `restartFrom` — covers C.

**The cut is a layer boundary, and layers already exist.** `model/gcode/state.ts` tracks `layer` and
sets `layerChanged` on the line where it changes (`state.ts:36-37`), preferring the slicer's own
marker over the geometric fallback. Every layer-anchored step in the codebase uses it —
`inLayerRange(ctx.layer, from, to)` in `steps/types.ts:191` is the shared gate. **Use them.** Do not
re-detect layers.

**State reconstruction is a collector, not a second read.** The facts needed at the cut — the last
temperature commanded for each tool and the bed, the last fan speed, the active tool, `M82`/`M83`,
`G90`/`G91`, the absolute `E` value, the last `Z` — are all knowable only by reading everything
*before* the cut. That is exactly what `model/analysisPass.ts` exists for; `steps/preheat.ts` and
`steps/rewriteTime.ts` are the two worked examples of declaring an `analysis()` collector and reading
its result back in `onStart`. Follow `rewriteTime.ts` — it is the smaller of the two.

**Namespace the collector id by `stepIndex`.** `StepFactoryContext.stepIndex` (`steps/types.ts:127`)
exists precisely so two instances of one step type do not collide in the merged results map. Both
`rewriteTime.ts:34` and `preheat.ts` have a `collectorId(ctx)` helper; copy it. Getting this wrong is
task 07's defect A, reintroduced.

**The preamble is generated, not templated by the user.** A user-supplied "start G-code" box would put
the safety burden on them. Generate it from the reconstructed state, show it in the diff (which the
plugin already renders), and let the user edit the resulting file afterwards if they want. What to
emit, in order:

1. A comment block stating plainly what this file is, which source it came from, which layer it
   resumes at, and that Z is **not** re-homed unless the user asked for it.
2. `G21`, and the `G90`/`G91` and `M82`/`M83` modes that were in force at the cut.
3. Temperatures: bed first (`M140` then `M190` to wait), then each tool that was hot, `M568`/`M104`
   then a wait. Heat the bed before the tool — a tool held at temperature over a cold bed oozes for
   the entire bed heat-up.
4. Tool selection (`T<n>`) matching the tool active at the cut.
5. Fan state as it was at the cut.
6. `G92 E<value>` restoring the absolute extrusion position, **only** when the file is in absolute-E
   mode. In relative mode it is meaningless and must not be emitted.
7. A `G1 Z<safe> F<slow>` lift to a height clear of the part, then an XY travel to the first
   coordinate of the resumed layer, *then* a controlled `G1 Z` down to the layer's own Z. Never move
   XY at the layer's Z: the first travel would drag the nozzle across the top of the existing part.

**Z homing is opt-in and off by default**, for the reason in the stop point.

## 3. Exact call sites

| What | Where |
| --- | --- |
| Layer state, `layerChanged`, `sawLayerMarker` | `src/model/gcode/state.ts:17-47`, `advance()` at `:81` |
| Shared layer-range gate | `src/model/steps/types.ts:191` (`inLayerRange`) |
| Collector contract + worked example | `src/model/analysisPass.ts`; `src/model/steps/rewriteTime.ts:38-54` |
| `stepIndex` collector namespacing | `src/model/steps/types.ts:117-127`; helper at `rewriteTime.ts:34` |
| Registry (the one line to add) | `src/model/steps/registry.ts:24-38` |
| `StepResult` contract — read this before withholding any line | `src/model/steps/types.ts:40-47` |
| Withholding/emitting worked example | `src/model/steps/arcWeld.ts` (its module comment explains the contract) |
| Test helpers (`runStep`, `runStepsWithAnalysis`) | `src/__tests__/helpers.ts:9-70` |

## 4. The traps, named

- **`undefined` does not mean "drop this line".** It means *leave it exactly as it was*. `null` drops
  it. This cost task 08 a real bug (`PLAN.md`'s arc-welding section records it). `extractRange`
  discards most of the file and will hit this on its very first test.
- **`G92 E0` and absolute E.** A file that resumes mid-print must restore the absolute E position, or
  the first extruding move retracts by the whole print's filament usage. Finding C in task 10 is the
  same trap in a different step — read it.
- **The geometric layer fallback is off when markers exist**, and `Analyser` passes
  `geometricFallback: !meta.hasLayerMarkers` (`analysis.ts:129`). A file with no markers has
  *approximate* layers. `extractRange` on such a file must warn, not pretend.
- **`M486` object state.** If the cut lands inside a labelled object, the resumed file starts
  mid-object with no `M486 S<n>`. Emit the active object label in the preamble, or DWC's cancel-object
  UI will attribute the rest of the print to the wrong object.
- **Do not re-emit the source's own start block.** Everything before the first layer change is the
  slicer's start G-code — homing, purge line, bed mesh. A resumed file must *not* run the purge line
  across a part that is already there. Drop it; that is what the generated preamble replaces.
- **`arcWeld` must not run before either of these steps.** Both need to reason about layer boundaries
  and coordinates; a welded arc hides the coordinates they need. Say so in `docs/usage.md`'s ordering
  guidance, which already carries the same warning for `preheat`.

## 5. The tests to write

`src/__tests__/extractRange.test.ts`:
- extracting layers 5–10 from a 20-layer fixture yields exactly those layers' lines, and nothing from
  layer 4 or 11;
- the extracted file carries a generated preamble, and does **not** carry the source's start block;
- `from` beyond the file's layer count produces an empty body and a warning, not a crash;
- `from > to` is a validation error (`validate()`, like `arcWeld.ts:322`);
- a file with no layer markers still extracts, and warns that layers were inferred;
- a single-layer extraction (`from === to`) works.

`src/__tests__/restartFrom.test.ts`:
- the preamble restores the tool that was active at the cut, not tool 0;
- the preamble restores bed and tool temperatures as last commanded before the cut, and heats the bed
  before the tool;
- in absolute-E mode a `G92 E<value>` is emitted with the E position at the cut; in relative-E mode
  **no** `G92 E` appears at all;
- `M82`/`M83` and `G90`/`G91` in force at the cut are restored;
- the first motion after the preamble lifts Z, then travels in XY, then descends — assert the order,
  since this is the one that drives the nozzle into the part if it regresses;
- no `G28 Z` appears unless the opt-in is set;
- the fan speed in force at the cut is restored;
- an `M486` object active at the cut is named in the preamble;
- a cut at layer 0 degenerates to "the whole file", with no preamble surprises.

`src/__tests__/recovery.test.ts` — the pure planner (`recoveryPlan()`) alone, no pipeline:
- reconstructs state from a synthetic event list, with each field's precedence tested independently;
- a tool never heated before the cut is *not* heated in the preamble;
- an unknown/absent value produces `null` and is omitted from the preamble rather than defaulted.

Add one golden fixture only if a bundled preset is added — see out-of-scope.

## 6. Acceptance

- On `test/fixtures/prusaslicer.gcode`, extracting a mid-file layer range produces a file whose every
  line came from that range, plus a preamble, and which contains no `G28` unless opted in.
- `restartFrom` at a mid-file layer produces a file that, read back through `Analyser`, reports the
  same active tool, extrusion mode and temperatures the source had at that point.
- The `recoveryPlan()` planner is pure and tested without any pipeline or I/O.
- All three gates pass. Golden files unchanged.
- **The stop point above was resolved and the answer is written into the step's module comment**, with
  the same "verified, not guessed" standard `preheat.ts` sets for its own firmware claims.

## 7. Out of scope

- **Resuming a print that is currently paused on the machine.** That is RRF's own `M24`/resurrect
  territory and involves `resurrect.g`; this task produces a *file*, and never talks to the printer.
- **Detecting where a print actually failed.** The user states the layer. Inferring it from the
  object model's last-known position is a separate feature and a much harder one.
- **Bed mesh / `G29` handling.** Whether to re-run or re-load a mesh depends on the stop point's
  answers; leave the source's own `G29 S1` out of the preamble and note it in `docs/usage.md`.
- **A bundled preset.** Neither step has a safe default configuration — the layer number is
  file-specific by definition. No preset, and therefore no golden-file changes.
- **Multi-material purge-tower reconstruction.** A resumed multi-tool print needs the purge tower's
  own state; that is its own task and should be refused loudly rather than approximated.
