# Task 12 — geometry-aware analysis (PLAN.md §8 phase 14)

**Read [README.md](README.md) first, then [CLAUDE.md](../../CLAUDE.md).**

**Depends on [10-audit-defects.md](10-audit-defects.md).** Every item here measures time or distance
per layer, and finding A there means arcs currently measure as zero seconds.

This task is four loosely-related capabilities that share one new idea: the analyser starts caring
about *where the nozzle went*, not only *what commands appeared*. Build them in the order below —
each is independently shippable, and the later ones are the speculative ones.

---

## 1. Per-feature and per-layer statistics *(build first — no new risk)*

**The gap.** `FileAnalysis` (`src/model/analysis.ts:21-108`) reports totals and a command histogram,
and `fanSettings` already breaks down by feature. Nothing reports **time and filament per layer, per
feature, or per object** — the numbers that answer "why is this print 14 hours" and "which feature is
eating the filament".

**What exists to build on.** `normaliseFeature()` (`src/model/gcode/features.ts`) already maps every
slicer's `;TYPE:` names onto the canonical `Feature` union (`features.ts:12-15`), and
`MachineState.featureType` (`state.ts:35`) carries the current one. `state.object` (`state.ts:33`)
carries the `M486` label. `TimeEstimator` gives per-move seconds. All three are already advanced once
per line in `Analyser.line()` (`analysis.ts:160-192`) — the accumulation is the only new part.

**Design decisions.** Accumulate into `Map<Feature, {seconds, filamentMm, moves}>`, plus a parallel
per-layer array and per-object map. Emit them on `FileAnalysis` as sorted arrays, matching the shape
`fanSettings` already uses (`analysis.ts:46-54`) so the inspector renders them the same way. Cap the
per-layer array — a 5,000-layer file must not put 5,000 rows in the UI; report the slowest N layers
and the total, not every layer.

**Tests** (`src/__tests__/analysis.test.ts`, new describe block): time attributed to the feature in
force when the move happens, not the one after; a move before any `;TYPE:` lands under `"unknown"`;
filament attributed per feature in both `M82` and `M83` modes; per-layer totals sum to the file total;
per-object totals only appear when `M486` is present.

**Acceptance.** On `test/fixtures/prusaslicer.gcode`, per-feature seconds sum to `estimatedSeconds`
within rounding, and per-layer seconds sum to the same. That identity is the test that catches
double-counting.

---

## 2. Minimum layer time enforcement *(build second — a step, well-defined)*

**The gap.** A layer that prints in four seconds does not have time to cool, and the next layer goes
down on soft plastic. Slicers have this setting; a file already sliced does not.

**Design decisions.**
- A new step, `minLayerTime`, one module plus one registry line.
- It needs the *whole layer's* duration before it can decide what to do with the layer's first line —
  a forward pass cannot know it. **This is an `analysis()` collector**, same as `rewriteTime.ts`.
  Namespace the collector id by `stepIndex` (`types.ts:117-127`; helper at `rewriteTime.ts:34`).
- Two remedies, user-selected: **slow the layer** (scale every `F` on that layer so the layer takes
  the minimum) or **dwell away from the part** (emit `G4` plus a park move). Slowing is the default —
  dwelling leaves the nozzle hot and stationary over a print.
- **Never slow below a floor.** Scaling an already-slow layer by a large factor produces feedrates
  that ooze. Expose a minimum-feedrate setting and stop scaling there, reporting the layers that could
  not reach the target rather than silently mangling them.

**Trap.** The scale factor must be computed from the *clamped* layer time (what the machine will
actually do), not the file's commanded time — otherwise on a machine whose limits already slow the
layer, this step slows it a second time. Task 09 put both figures on `TimeEstimator`
(`clampedSeconds`/`unclampedSeconds`); use the clamped one.

**Tests** (`src/__tests__/minLayerTime.test.ts`): a fast layer is slowed and a slow one is left
byte-identical; the slowed layer's recomputed duration meets the target; a layer that cannot reach the
target without breaching the feedrate floor is reported, not mangled; dwell mode emits `G4` and a park
move and does not touch any `F`; the step is a no-op with no machine limits, and says so.

---

## 3. `M486` object labelling, including Klipper `EXCLUDE_OBJECT` *(build third)*

**The gap.** DWC's cancel-object UI needs `M486`. Files sliced for Klipper carry
`EXCLUDE_OBJECT_DEFINE`/`EXCLUDE_OBJECT_START`/`EXCLUDE_OBJECT_END` instead, and files sliced with
object labelling off carry nothing. `Analyser` already collects `M486` labels (`analysis.ts` —
`objectSet`, and `macroRefs` shows the established shape for this kind of collection), and
`state.ts:198-211` already parses `M486 S`/`A`.

**Two separate capabilities — do not conflate them:**

- **(a) Convert Klipper markers to `M486`.** Mechanical, safe, well-defined. `EXCLUDE_OBJECT_START
  NAME=foo` → `M486 S<n> A"foo"`, with a stable index per distinct name, and `EXCLUDE_OBJECT_END` →
  `M486 S-1`. The `commandMap` step already exists but cannot do this — it maps commands, not
  stateful name→index assignment — so this is its own step, `objectLabels`.
- **(b) *Invent* object labels for a file that has none.** This needs connected-component analysis
  over per-layer geometry to decide what is a separate object. **That is speculative and is not part
  of this task** — see out-of-scope.

**Trap.** Klipper's bare-word commands are invisible to command counting; `bareMacroName()`
(`analysis.ts:145-147`, and `gcode/dialect.ts`) is the existing handling for exactly this, and
`detectDialect` already flags a file as Klipper-flavoured. Reuse both rather than adding a second
bare-word parser.

**Tests** (`src/__tests__/objectLabels.test.ts`): a define/start/end triple becomes correct `M486`;
the same name reused later gets the same index; `EXCLUDE_OBJECT_END` becomes `M486 S-1`; a file
already carrying `M486` is left byte-identical and warns rather than double-labelling; a name
containing a quote is escaped the way `unquoteString`'s inverse requires.

---

## 4. Hole detection with insert pauses *(build last — and read this section's warning)*

**The gap.** A pocket that gets roofed over is the one moment a magnet or a nut can be dropped in, and
it is invisible once the print passes it.

**This is the speculative one.** It requires per-layer occupancy: rasterise each layer's extruding
moves into a coarse grid, find cells that are empty on layer *n* and occupied on layer *n+1* — a void
being closed. The plugin **cannot tell an insert boss from a lightening pocket or a bridged window**,
which is why `PLAN.md` §8 phase 14 already specifies presenting these as *candidates to tick*, never
as automatic pauses.

**Design constraints, all non-negotiable:**
- **Never insert a pause automatically.** Detection produces a list; the user ticks. The existing
  `insertAt` step with a `layer` anchor is what performs the insertion once they have.
- **Bounded memory.** `CLAUDE.md`'s fourth non-negotiable is a chunked read that never materialises
  the file. A per-layer grid at a sane resolution (say 1 mm cells over the bed, ~90 kB per layer as
  a bitset) is fine; retaining every layer's grid for a 5,000-layer file is not. Keep **two** layers
  at a time — previous and current — which is all the "was empty, now covered" test needs.
- **Report coordinates and depth**, so the user can identify the pocket. A candidate with no position
  is not actionable.

**Stop point.** Before building the UI half, implement the detector as a pure module
(`model/gcode/voids.ts`) plus tests over synthetic layer geometry, and **report the false-positive rate
on the real fixtures**. If a plain rectilinear test print yields dozens of candidates, the heuristic is
not good enough to show a user and this sub-feature should be dropped rather than shipped noisy. Say
so and stop — do not tune it into looking good on one fixture.

**Tests** (`src/__tests__/voids.test.ts`): a synthetic two-layer case with a genuine covered pocket is
found; a pocket that stays open to the top is not; a bridge across a window is *not* reported as a
closed void unless it fully encloses; sparse infill's own gaps do not register (this is the main
false-positive source — infill is not solid, and the detector must use `Feature` to ignore
`sparseInfill` moves).

---

## Out of scope

- **Inventing object labels for an unlabelled file** (§3b) — connected-component segmentation is its
  own task with its own stop point.
- **A 3D viewer, heatmaps, or in-viewport editing.** `PLAN.md` §8 "Not scheduled" is explicit: the
  right move is integrating with DWC's existing G-code viewer, not building a second one.
- **Warp prediction.** Same section. The modest version (flagging geometry that correlates with
  lifting) is an *information* check, and belongs with the other checks, not here.
- **Retaining full per-layer geometry** for anything. Two layers at a time, or redesign the feature.
- **Changing `Feature`'s canonical set.** If a slicer name is unmapped, add it to `features.ts`'s
  existing mapping — do not widen the union without a reason.

## Acceptance (whole task)

- Each of §1–§3 is independently shippable and independently tested; §4 stops at its stop point if the
  false-positive rate is bad, and that is a successful outcome, not a failure.
- Per-feature and per-layer seconds each sum to the file total (§1's acceptance identity).
- The memory profile is unchanged: no step retains more than two layers of geometry, and the chunked
  read still never materialises the file.
- All three gates pass. Golden files unchanged unless a preset is added — none is proposed here.
