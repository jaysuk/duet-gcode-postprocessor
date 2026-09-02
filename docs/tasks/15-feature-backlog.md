# Task 15 — the remaining feature-ideas backlog

**Read [README.md](README.md) first, then [CLAUDE.md](../../CLAUDE.md).** The four non-negotiables
there are binding.

This clears what is genuinely left of [docs/feature-ideas.md](../feature-ideas.md) after tasks 01–14.
Everything in §0–§4, §6 and most of §5 and §8 is shipped (see FEATURES.md's G-series and H-series);
§7's headline item (H1, hole detection) was investigated and deliberately stopped in task 12 §4 and
**must not be revived here**. What remains is ten items, and the single most useful thing this work
order does is sort them by *what they actually need*:

| | Item | What it really is |
| --- | --- | --- |
| **A** | `{meta.*}` placeholders | One shared helper, lands in 6 call sites at once |
| **B** | Retraction totals per tool (§5) | Analysis only — no step, no transformation |
| **C** | H3 eject, H4 per-layer Z-offset, H12 bed ramp, H13 `M291` gate | **Presets. No new machinery at all** |
| **D** | H9 tool renumbering | A new step |
| **E** | H10 Z-hop + H11 ooze control | One new step's worth of shared travel detection |
| **F** | H14 timelapse on each object's top layer | A new step *and* an analysis collector |

**Group C is the important realisation.** Four backlog items that read like features are recipes over
steps that already exist — `insertAt` and `paramRewrite` between them already do the work, and
`presets.ts` already has the shape (`Pause at a layer` is exactly the pattern). CLAUDE.md's house rule
says a new step is one module plus a registry line; the inverse is also true and matters more here:
**if a preset does it, do not write a step.** Group C should be about an hour, not a phase.

Do A and B first (smallest, no risk, and B's numbers feed nothing else so it can never block).
Then C. Then D. Then E. Then F, which is the only item needing the analysis pass.

**Two items carry stop points** — D and part of C — because both turn on a firmware behaviour that
cannot be settled by reading this codebase. Resolve them the way CLAUDE.md prescribes: against
`Duet3D/wiki-content` **and** the RRF source, not by picking the convenient answer.

**One process note, carried over from task 14.** That task shipped correct code with a wrong number
in the docs, because the work order itself quoted a measurement taken under different conditions and
the number got copied through rather than re-measured. So: **no figure in this document is a result.**
The line counts, the 6 fixtures, the 54 goldens are facts about the current tree; anything this task
*produces* — a throughput, a count of retractions, a threshold that "works well" — must be measured
on the finished implementation before it is written into a doc, a tip, or a test bound. And when a
test asserts a bound, calibrate it against a real measurement rather than against the failure it is
meant to catch: task 14's perf test passed comfortably while the behaviour it claimed to pin was off
by 8×, because the bound had been set loose enough to catch only the original bug.

---

## A — `{meta.*}` placeholders in inserted text

**The gap.** `expandPlaceholders` (`src/model/steps/types.ts:267`) expands exactly seven keys:

```ts
return text.replace(/\{(layer|z|tool|line|file|feedrate|object)\}/g, (_all, key: string) => {
```

So an insert can say `M117 layer {layer}` but not `M117 {meta.layer_height} mm` — the idea in
feature-ideas §6, and the thing that would let one recipe drive a value from the slicer profile
rather than a hard-coded number.

**Why it is worth doing first.** Six call sites consume this helper and all of them benefit with no
further work: `insertAt.ts:168`, `rangeVary.ts:125`, and `rules.ts:198`/`:247`/`:250`/`:253`
(`replaceLine`, `insertBefore`, `insertAfter`, `appendComment`).

**The design.** Extend the pattern to also match `\{meta\.([A-Za-z0-9_]+)\}`. Resolve in this order:

1. the typed fields on `SlicerMetadata` under their own names — `totalLayers`, `layerHeight`,
   `filamentMm`, `printTimeSeconds`, `filamentDiameterMm`, `maxVolumetricSpeedMm3PerSec`;
2. otherwise `ctx.meta.values.get(key)`, the raw normalised map.

**Trap — the keys are normalised, and the docs must say so.** `metadata.ts` lower-cases keys and
collapses spaces to underscores (`values` is documented as "Normalised key -> value"), so it is
`{meta.layer_height}`, never `{meta.layerHeight}` or `{meta.Layer Height}`. Users will get this wrong;
`docs/usage.md` needs the rule and one worked example.

**Trap — an unknown key must not expand to nothing.** Leave the placeholder text *literally intact*
when the key is absent, exactly as the existing `default: return _all` branch does. Expanding to an
empty string would silently turn `M104 S{meta.first_layer_temperature}` into `M104 S` — a command
that means something different rather than a command that is obviously wrong.

**Decision already made: no warning for an unknown key, and `expandPlaceholders` keeps its current
signature.** The obvious instinct is to report unknown keys in the run report, but `warn` lives on
`RunContext` (`types.ts:37`) and this function is handed a `LineContext` — there is no warn channel
in scope, and threading `RunContext` through all six call sites to add a nicety is a far larger blast
radius than the feature deserves. **Do not change the signature.** The surviving literal
`{meta.whatever}` in the output *is* the signal, and it appears in the dry-run diff, which is exactly
where the user is already looking before they apply. If a warning is genuinely wanted later, it
belongs in a separate task with its own scope.

**Tests** — extend `src/__tests__/steps.test.ts` (it already covers `insertAt`; nothing currently
imports `expandPlaceholders` directly, so these are new):

- a typed field (`{meta.totalLayers}`) and a raw key (`{meta.layer_height}`) both expand;
- an unknown key survives verbatim, and the output is otherwise untouched;
- a `{meta.*}` placeholder works from `insertAt` **and** from a `rules` `appendComment`, proving the
  shared helper reached both;
- a file with no metadata at all leaves every `{meta.*}` intact rather than throwing.

---

## B — Retraction totals per tool

**The gap.** feature-ideas §5 asks for "count and total distance, per tool — a proxy for oozing and
for wear". `model/analysis.ts` has `featureStats`, `slowestLayers` and `objectStats` but no
retraction accounting; the only mentions of retraction in that file are comments explaining how
*extrusion* is distinguished from it (`analysis.ts:257–259`).

**The design.** Extend `Analyser` (`analysis.ts:149`, a class whose `line(raw: string)` at `:206`
and `result(): FileAnalysis` at `:475` are the whole interface) with a per-tool
`{ count, totalMm }`, incremented on any move whose E delta is negative. Add it to `FileAnalysis` and
surface it in `FileInspector.vue` beside the existing per-feature table. Analysis only — no step, no
transformation, so it cannot corrupt a file.

**Note the interface: `Analyser.line()` takes a raw string, not a `LineContext`.** It maintains its
own `MachineState` internally (`this.state`, built with `createState` in the constructor at `:198`
and advanced at `:212`), so the tool and E mode come from **`this.state.tool` and
`this.state.relativeE`** — there is no `ctx` in this class. Do not add a parameter to `line()`; every
existing caller passes a bare string.

**Trap — E mode.** A retraction is a negative *delta*, which in relative mode (`M83`) is a negative E
on the line and in absolute mode (`M82`) is an E lower than the previous one. Both `timeModel.ts` and
`arcWeld.ts` already track absolute E position across both modes — follow one of those, do not
re-derive it. `G92 E0` resets the datum and must not be counted as a gigantic retraction; that is the
specific bug this trap exists to prevent.

**Trap — attribute to the tool active at the time**, from `this.state.tool`, not to whichever tool
the file ends on. A `-1` tool (none selected yet) is a real state and needs its own bucket or to be
skipped explicitly, not to become tool 0.

**Tests** (`src/__tests__/analysis.test.ts`):

- relative mode (`M83`, `G1 E-2`) counts 2 mm;
- absolute mode (`M82`, `G1 E10` then `G1 E8`) counts 2 mm;
- `G92 E0` between two extrusions counts nothing;
- two tools split correctly, and moves before any `T` are not attributed to tool 0.

---

## C — Four presets, no new machinery

Each is a `Preset` in `src/model/presets.ts` following the existing shape (`key`, `name`,
`description`, `build()` returning a `Recipe`) — copy `pauseAtLayer` (`presets.ts:63–82`), which
already demonstrates that every field of the step config must be spelled out, not just the ones being
used.

**Know the golden-file cost before you start.** `golden.test.ts:103` enumerates
`PRESETS × FIXTURES` automatically, and there are 6 fixtures, so **each preset added here generates
6 new golden files — 24 across the four**, taking the directory from 54 to 78. They are generated by
`npx vitest run -u`, but README's rule still applies to every one of them: a golden is a committed
expectation, so read what each new file actually contains rather than accepting 24 files sight
unseen. If a preset's output looks wrong on the `two-tool` or `arc-circle` fixture, that is the
suite telling you the preset is wrong, not the fixture.

**H4 — per-layer Z-offset.** `paramRewrite` already offsets Z over a layer range; feature-ideas says
outright "what is missing is the *preset* and a sensible UI for it, not the machinery". One preset:
offset Z by a small delta from a chosen layer upward, with a note telling the user which two numbers
to change.

**H12 — bed-temperature ramp.** `insertAt` with `anchor: "layer"` and `text: "M140 S<lower>"`.

> **Use `M140`, never `M190`.** `M140` sets the bed temperature and returns immediately; `M190`
> *waits* for it. Inserting a wait mid-print stalls the head over the part with the nozzle hot —
> exactly the failure a bed ramp is supposed to avoid causing. State this in the preset's own note.

**H3 — eject sequence.** `insertAt` with `anchor: "fileEnd"`. Ship it as a *template* with the moves
commented out and a note saying so: an eject routine is machine-specific, and a preset that drives an
unknown gantry to unknown coordinates is the one kind of preset that could break hardware. The
value here is the shape and the placement, not the coordinates.

**H13 — `M291` confirmation gate.** `insertAt` at a chosen layer with an `M291` prompt.

> ### Stop point 1 — does `M291` on its own actually pause the print?
>
> The whole point of a confirmation gate is that the printer *stops and waits*. `M291` has several
> modes (its `S` parameter), and only some block; a non-blocking prompt would display a message and
> carry on printing, which is worse than no feature at all because it looks like it worked.
>
> **First step:** check `M291`'s `S` modes in `Duet3D/wiki-content`
> (`User_manual/Reference/Gcodes.md`) *and* against the RRF source, and determine whether a blocking
> `M291` alone is sufficient or whether the preset must pair it with `M25`. Build the preset around
> whichever is actually true. If neither gives a clean answer, **stop and report** rather than
> shipping a prompt that might not pause.

**Tests.** One golden-file case per preset, plus the existing self-maintaining preset smoke test
picks them up automatically. Assert the bed-ramp preset emits `M140` and *not* `M190`.

---

## D — H9, tool renumbering

**The gap.** Remapping `T0`→`T2` for a file sliced against a different tool assignment is currently a
find-and-replace, which also rewrites `T0` inside comments and does nothing sensible with `M568 P0`.

**The design.** A new step `toolRenumber` (one module, one registry line), config: a mapping of old
tool number to new.

**The field schema has no "list of pairs" type** (`FieldType` is `text | textarea | number | boolean
| select | gcode | regex`), and CLAUDE.md's house rule is explicit that reaching for a bespoke form
component means you have taken a wrong turn. Use the precedent that already exists for structured
config: **a `text` field holding a compact mapping the step parses itself**, e.g. `0->2, 1->0`,
validated in `validate()` so a malformed mapping is a save-time error rather than a silent no-op.
`rules.ts:321` is the same idea at a larger scale (a `textarea` of JSON, parsed and validated by
`parseRules`); a one-line mapping does not need JSON, but it does need the same
validate-at-save-time discipline.

> ### Stop point 2 — which commands' `P` parameter is a tool number?
>
> `M568 P0` is a tool. **`M106 P0` is a fan index, not a tool** — remapping it would silently
> redirect fan commands, and on a file that also renumbers tools the result would be a print with the
> wrong part cooling and no error anywhere. `M563 P` is a tool definition. There are others.
>
> **First step:** build the list from `Duet3D/wiki-content`'s G-code dictionary
> (`User_manual/Reference/Gcodes.md`, one page with `## Mxxx` sections), confirming each command's
> `P` semantics, before writing any rewriting code. Encode it as an explicit allow-list of
> `{ command, parameter }` pairs in the module, with the wiki as the cited source — never a
> heuristic like "P after an M-code is a tool". If the wiki is ambiguous for a command, leave that
> command alone and say so in the step's tip.

**Trap — remapping must be simultaneous, not sequential.** `T0→T1, T1→T0` is a swap. Applying the
pairs in order would turn every `T0` into `T1` and then straight back into `T0`. Resolve each
occurrence once, against the original value, from a snapshot of the mapping.

**Trap — the tokeniser already solves the comment problem.** `tokenise()` separates body from
comment (quote-aware), so operate on `token.body` and rebuild with `withBody()`, exactly as every
other parameter-rewriting step does. Never regex the raw line.

**Tests** (new `src/__tests__/toolRenumber.test.ts`):

- `T0` → `T2` on a command line, and **not** inside `; use T0 for this` or `M117 T0`;
- `M568 P0` is remapped;
- `M106 P0` is **not** (the regression this step's stop point exists to prevent);
- a simultaneous swap `T0↔T1` produces a real swap;
- a tool not in the mapping is untouched.

---

## E — H10 Z-hop injection and H11 ooze control

Build these **together**: both key off "a travel move longer than a threshold", and implementing that
detection twice is how the two end up disagreeing about what a travel is.

**The design.** One shared helper — a travel move is `G0`/`G1` with XY displacement and no positive E
delta — then two steps over it, or one step with a mode. Prefer two steps sharing a helper module:
the configs are unrelated (hop height vs retraction length and temperature drop) and one step with
two disjoint config halves is the shape CLAUDE.md's field-schema rule exists to discourage.

**Trap — do not double up on what the file already does.** Both features are defined by the file
*not* already doing them. A slicer file that already retracts before travels will grind filament if a
second retraction is inserted, and one that already hops will hop twice. Detect the immediately
preceding retraction/hop and skip; report how many insertion points were skipped for this reason,
because "it did nothing" needs to be distinguishable from "it was not needed".

**Trap — firmware retraction.** `G10`/`G11` (no parameters) are firmware retract/unretract and may
already include a Z-hop configured by `M207`. A file using those must be detected and left alone, not
treated as un-retracted. Check `M207`'s Z parameter against the wiki before assuming.

**Trap — relative vs absolute.** A hop must respect `relativeMoves` (`G91`) and restore exactly, and
a retraction must respect `relativeE`. `ctx` carries both; the arithmetic differs and getting it
backwards writes a Z that walks away over the file.

**Trap — ordering against `arcWeld`.** `arcWeld` is documented to run last because it changes line
counts and coordinates. These steps insert lines into travel runs; they must run *before* it, and the
steps' tips should say so.

**Tests:** a travel above the threshold gets a hop/retraction and one below does not; an existing
retraction on the preceding line suppresses insertion; relative and absolute modes both round-trip to
the original position; a `G10`/`G11` file is left alone; the skipped-insertion count is reported.

---

## F — H14, timelapse trigger on each object's top layer only

**The gap.** The shipped `timelapse` preset (`presets.ts:83–102`) fires
`M98 P"0:/macros/timelapse.g"` at **every** layer change. On a plate of twenty parts that is twenty
times more triggers than wanted; feature-ideas §8 asks for one per object, at that object's top layer.

**Why this one needs the analysis pass.** "That object's top layer" is only knowable after seeing the
whole file — it is lookahead, which is precisely what `model/analysisPass.ts` exists for and what
`preheat` already uses. A collector (`AnalysisCollector`, `{ id, onLine, result }`) records the
highest layer on which each `M486` object extrudes; the step then fires only where an object's last
layer completes.

**Trap — namespace the collector id by `stepIndex`.** `StepFactoryContext.stepIndex` exists for
exactly this and its own doc comment explains why: two instances of the same step type in one recipe
otherwise collide on one key in the merged results map and silently both read whichever wrote last.
This was task 07's defect A; do not reintroduce it.

**Trap — a file with no `M486` labels.** `ctx.object` is `null` throughout. The step must degrade to
doing nothing and say so in the run report — not fall back to firing every layer, which is the
behaviour the user was trying to get away from. Pair it with `objectLabels` in the preset's note,
since that step can add the labels.

**Trap — "top layer" is per object, not per file.** Objects finish at different heights; that is the
entire point. A single "last layer" for the whole plate is the bug to avoid.

**Tests** (new `src/__tests__/timelapseTopLayer.test.ts`): a two-object file where the objects end on
different layers fires exactly twice, at the right two layers; an unlabelled file fires zero times and
warns; two instances of the step in one recipe do not collide.

---

## Out of scope

- **H1, hole/void detection.** Investigated and stopped in task 12 §4 against a real 250-layer dense
  slice: 16–1,139 false positives on an object with no cavities. `model/gcode/voids.ts` stays a pure,
  tested, unwired detector. **Do not revive it here**, and do not wire the existing detector up
  "just to see" — the stop point already ran and its answer was no.
- **H5 (G-code command palette) and H16 (drive DWC's viewer).** Both depend on DWC exposing something
  it does not currently expose; the cheapest route is the upstream Monaco ask in
  `docs/scripting-engines.md`, not building either here.
- **H6, geometric warp-risk notes.** Information-level only, and needs a design pass of its own
  before it is a task.
- **D4/D5/D6/D8** (recipe matching by filename, auto-run on upload, batch processing, run history).
  Genuinely unbuilt — `matchesFilter` (`recipe.ts:324`) exists and is consumed by nothing outside its
  own test — but they are an automation phase, not a feature backlog, and D5 in particular needs a
  decision about running without a visible tab that is not this task's to make.
- Anything requiring a new `Transform` contract, pipeline change, or a second pass beyond the
  existing `analysisPass`. If an item here seems to need one, **stop and report**.

## Acceptance criteria

- Each part's listed tests pass, and each fails before its own change.
- **No golden file changes for A, B, D, E.** None of those alters an existing preset, and no bundled
  preset currently uses a `{meta.*}` placeholder, so A cannot move one either — if a golden changes
  under A, B, D or E, stop and find out why. **C and F do change goldens**: C *adds* 24 (4 presets ×
  6 fixtures), F *modifies* the 6 existing `timelapse.*` ones. Regenerate with `npx vitest run -u`
  and read them, per README's golden-file rule.
- All three gates: `npm test`, `dwc-plugin-typecheck`, `dwc-plugin-verify-build`, with
  `DWC_DIR=/c/Users/live/Documents/Github/DuetWebControl`.
- Both stop points resolved against the wiki *and* the RRF source, with the citation written into the
  module that depends on it — not into a commit message, where the next reader will not find it.
- `docs/usage.md` covers `{meta.*}` (with the normalised-key rule) and each new step; `FEATURES.md`'s
  H-series rows are ticked with their module paths, matching how G1–G14 are recorded.
