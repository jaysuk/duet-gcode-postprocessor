# Task 13 — the simulation round-trip and the long tail (PLAN.md §8 phase 15)

**Read [README.md](README.md) first, then [CLAUDE.md](../../CLAUDE.md).**

**Depends on [10-audit-defects.md](10-audit-defects.md)** — §1 below compares the plugin's own estimate
against the firmware's, and finding A means the plugin's estimate is currently wrong on any curved
file. Comparing a known-wrong number against a known-good one teaches nothing.

---

## 1. The `M37` simulation round-trip *(the headline; no slicer can offer it)*

**The gap.** Every print-time estimate in this plugin is a model. RepRapFirmware will simulate a file
against its *own* motion planner and report the real answer — the number the machine will actually
take. `M37 P"file.gcode"` runs the file in simulation mode; the result lands in the object model and
RRF writes the simulated time into the file itself.

**This is the only feature in the whole plan that requires talking to the printer**, and that is a
genuine architectural change, not a detail.

### ⚠️ Stop point — the gateway cannot do this today

`FileGateway` (`src/model/io/transfer.ts:115-123`) has exactly six methods: `download`, `upload`,
`move`, `remove`, `makeDirectory`, `sizeOf`. **There is no `sendCode`, and nothing anywhere in `src/`
calls `machineStore.sendCode`** — verified by search. The entire plugin is, today, a pure file
transformer that never issues a command.

Before writing any simulation code, resolve and report:

1. **How completion is detected.** `M37` returns immediately; the simulation runs for as long as the
   print would take to *simulate* (fast, but not instant on a large file). Is completion observable
   from `job.file.simulatedTime` becoming non-null, from `state.status` leaving `"simulating"`, or
   only by polling `M37` again? **Verify against RRF source and the object model schema** — the
   `Duet3D/wiki-content` `Gcodes.md` M37 section and `state.status`'s enum. This is exactly the kind
   of claim `preheat.ts` sets the standard for: cite the source in the module comment.
2. **What it costs the user.** Simulating a 14-hour print is not free, and the machine is unavailable
   while it does so. If simulation blocks the machine, this must be an explicit, clearly-labelled
   user action with an accurate warning — never something a recipe does as a side effect.
3. **Whether the file must be on the SD card first.** It must — so the round-trip is
   apply → upload → simulate → read back → rewrite `M73` → re-upload. That is **two** writes of a
   large file. Decide whether the `M73` rewrite can be done as a targeted patch rather than a full
   re-upload, or whether the honest answer is "this costs two uploads" and the UI says so.

**Report the answers and stop.** If simulation blocks the machine for the full print duration, this
feature is much less attractive than it looks on the roadmap and the right outcome may be to document
that and drop it. Say so; do not build it anyway.

### Design decisions, once the stop point clears

- **`sendCode` goes on the gateway, not into a component.** `src/dwc/gateway.ts` is the one place that
  touches `machineStore`; `CLAUDE.md`'s first non-negotiable keeps `model/` pure. Add
  `sendCode(code: string): Promise<string>` to `FileGateway` and implement it there. `FakeGateway`
  (`src/__tests__/helpers.ts:107`) gains a matching stub that records codes, exactly as
  `dwc-plugin-test-kit`'s own `sentCodes()` does.
- **Never simulate the file that is printing.** `CLAUDE.md`'s second non-negotiable already forbids
  touching it; the same guard applies here and must be checked immediately before sending, not only
  when the UI was rendered.
- **The comparison is the product, not the rewrite.** Showing "your slicer said 9h 12m, this plugin
  modelled 10h 40m, your printer simulated 10h 31m" is worth more than silently rewriting `M73`.
  Rewriting is the follow-on action, opt-in.

**Tests.** Everything except the gateway call is pure and testable: given a simulated-seconds figure,
`rewriteTime`'s existing machinery already rewrites `M73` (`steps/rewriteTime.ts`) — feed it the
firmware's number instead of the model's and the step needs no change. Test the orchestration against
`FakeGateway` with a scripted `sendCode` response, including the failure paths: simulation refused,
machine disconnected mid-run, `simulatedTime` never appearing (must time out, not hang).

---

## 2. Metadata-driven parameters

**The gap.** Pressure advance, retraction and temperature offsets that should differ per filament are
fixed in the file. The file already states which filament it is.

**What exists.** `SlicerMetadata.values` (`gcode/metadata.ts`) is a normalised `key → value` map of
everything in the header and footer, and `filament_type` is in it for the whole PrusaSlicer/Orca
family. `LineContext.meta` (`steps/types.ts:22`) already hands it to every step.

**Design.** A table step: match on a metadata key's value, apply a set of parameter changes. This is
mostly a *config-shape* problem, not a G-code one — the transformation itself is what `paramRewrite`
and `insertAt` already do. Consider whether this is better expressed as a **recipe-level condition**
(§3) plus existing steps than as a new step type with a table editor. Prefer the former: it composes,
and it does not need a bespoke form component, which the README's house style explicitly warns against.

**Trap.** `meta.values` keys are normalised (lower-cased, spaces to underscores — `metadata.ts`'s
`normaliseKey`). Match against the normalised form, and state that in the field help, or users will
type the slicer's own spelling and get silence.

---

## 3. Conditional steps

**The gap.** A recipe applies every enabled step to every file. "Only if this is PETG", "only if the
file has more than 200 layers", "only if it was sliced by Cura" all require editing the recipe by hand.

**Design.** A per-step condition evaluated **once, before the run**, from `SlicerMetadata` and the
file's `FileAnalysis` — not per line. A per-line condition is what the `rules` step already does
(`steps/rules.ts`); this is deliberately the coarser, cheaper thing.

Put the condition on the recipe's step entry (`model/recipe.ts` — `effectiveSteps()` at `:60` already
filters disabled steps, and is the natural place to also filter unmet conditions). **Note that
`effectiveSteps` indexing drives `stepIndex`** (see `recipe.ts` and task 07's collector-namespacing
fix): a condition that removes a step must remove it *before* indices are assigned, or two steps
collide on a collector id. `src/__tests__/recipe.test.ts`'s `collectorsFor` block already tests that
disabled steps do not occupy an index — extend it for conditions rather than writing a new one.

**Tests.** A step whose condition is unmet contributes nothing and appears in the report as skipped,
not as failed; conditions see metadata even when the file's analysis was not requested; an
unparseable condition is a validation error at edit time, not a silent no-op at run time.

---

## 4. The remaining long tail

Small, independent, no shared design. Take them one at a time; none needs a work order of its own.

- **Compare two files** — a diff of two files' `FileAnalysis`, not a text diff. The diff renderer
  already exists (`Pipeline.diff`, `model/pipeline.ts:61`).
- **Plain-English file summary** — one paragraph from `FileAnalysis`. Pure function, trivially
  testable, genuinely useful in the widget.
- **Apply and start the job** — needs `sendCode` from §1, and the same never-touch-the-printing-file
  guard. Do not build before §1's stop point clears.
- The rest of `FEATURES.md` §H.

---

## Out of scope

- **Auto-run on upload (D5), batch processing (D6), automatic recipe selection (D4), run history
  (D8).** All four are listed in `PLAN.md`'s "Not built yet" and are workflow features, not phase-15
  ones. They do not depend on anything here and should not be smuggled in.
- **Anything requiring the machine to move.** Simulation is `M37`; this plugin does not home, probe or
  extrude. If a feature needs real motion it belongs in a different plugin — `duet-tool-align` and
  `duet-eddy-align` are the siblings that own that territory.
- **A second Vuetify or a bespoke form component** for the metadata table (§2) — `verify-build` fails
  on the first and the README's house style forbids the second.

## Acceptance (whole task)

- §1 either ships with its stop point resolved and its firmware claims cited in the module comment, or
  is **documented as not worth building** with the reason. Both are acceptable outcomes.
- `model/` stays pure: no `@/stores/*` import outside `src/dwc/`, which `dwc-plugin-typecheck` and
  `verify-build` will both catch.
- No feature here talks to the printer without an explicit user action and a
  never-touch-the-printing-file guard checked at send time.
- All three gates pass.
