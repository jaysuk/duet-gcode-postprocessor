# Work orders

Each file here is a self-contained task, written so an agent with no memory of how it came about can
pick it up and do it correctly. **Read this file first, then [CLAUDE.md](../../CLAUDE.md)** — the
four non-negotiables there are binding, not background.

## The queue

| # | Task | Ready? | Depends on |
| --- | --- | --- | --- |
| [01](01-defects.md) | Pre-hardware defect pass — the late large-file warning, backups that cannot be restored, the widget's fake version | **Done** | — |
| [02](02-fan-audit-and-override.md) | Fan-speed audit and per-feature override | **Done** | — |
| [03](03-machine-aware-checks.md) | `M98` macro validation, cold-extrusion and hygiene checks, Marlin tool-scoped temperatures | **Done** | — |
| [04](04-move-time-model.md) | Move-time model and `M73` rewrite | **Done** | — |
| [05](05-analysis-pass.md) | Two-pass processing, so a step can see what is coming | **Done** | 04 (uses it as the first consumer) |
| [06](06-preheat.md) | Predictive pre-heat before a tool change | **Done** — step 1's verification confirmed both assumptions against RRF source and the wiki; see `src/model/preheat.ts`'s module comment | 04, 05 |
| [07](07-audit-defects.md) | Defect pass on 04–06 — the analysis pass read the wrong file, and pre-heat could cancel its own work | **Done** — every reproduction in the work order now fails before the fix and passes after it | 04, 05, 06 |
| [08](08-arc-welding.md) | Arc welding, `G0`/`G1` → `G2`/`G3` | **Done** | 07 |
| [09](09-flow-and-clamping.md) | Volumetric flow audit and feedrate clamping (finishes §8 phase 12) | **Done** | 04, 07 |
| [10](10-audit-defects.md) | Defect pass on 08–09 — arcs are invisible to the move-time model, and clamping mis-reads `G92` | **Done** — every reproduction in the work order now fails before the fix and passes after it | 08, 09 |
| [11](11-print-recovery.md) | Print recovery and layer surgery (§8 phase 13) | **Done** — stop point resolved: Z re-homing opt-in and off by default, no adhesion trickery invented | 10 |
| [12](12-geometry-analysis.md) | Geometry-aware analysis — per-feature stats, minimum layer time, `M486` labelling, void detection (§8 phase 14) | **Done**. §1–3 shipped; §4 was checked against a real 250-layer dense slice (this repo's own fixtures were too thin) and resolved its own stop point by stopping: 16–1,139 false-positive candidates on an object with no intentional cavities, so `model/gcode/voids.ts` stays a pure, tested, unwired detector — no collector, no step, no UI | 10 |
| [13](13-simulation-and-tail.md) | `M37` simulation round-trip and the long tail (§8 phase 15) | **Done in full**, including "compare two files" — `model/compareFiles.ts` + `components/CompareFiles.vue` | 10 |
| [14](14-scripting-engine-defects.md) | Defect pass on the scripting engines — the QuickJS sandbox's chunking bypassed downstream steps and wrecked the dry-run diff, and it re-serialised the whole metadata block per line (239× slower on a real file) | **Done** — every reproduction in the work order now fails before the fix and passes after it; sandboxed engine moved to one VM call per line, metadata hoisted once per run via `setMeta` | — (the work it audits is uncommitted, not shipped) |
| [15](15-feature-backlog.md) | The remaining feature-ideas backlog — `{meta.*}` placeholders, retraction totals, four presets (H3/H4/H12/H13), tool renumbering, Z-hop + ooze control, per-object timelapse | **Done** — both stop points resolved against the wiki and RRF source and cited in the modules that depend on them; found and fixed a real G92-reset bug in `analysis.ts` and a pre-existing gap in `golden.test.ts` (it never ran the analysis pass, so no analysis-dependent step had ever been golden-tested) along the way | 14 |
| [16](16-automation-and-reporting.md) | The automation phase — recipe matching (D4), run history (D8), the run report (F2), auto-run on upload (D5), batch processing with multi-select (D6/A2), diagnostics (F4), touch layout (F6), and the preflight gate (E13, which was reported as done and is not) | **Done, then audited and corrected** — stop point resolved: Vuetify's `useDisplay` breakpoint *can* be driven under the harness (set `window.innerWidth`, dispatch `resize`, `await nextTick()`), so F6 is tested directly rather than pushed into CSS. Fixed a real pre-existing bug found along the way: `importRecipe` silently dropped step `condition`s that `exportRecipe` had written out. **The audit pass then found seven defects in the first cut — see the note below** | 15 |

**Tasks 11–13, 15 and 16 carry stop points**, because each contains a question that cannot be answered by
reading this codebase: whether the user's machine can safely re-home Z over a part (11), whether void
detection's false-positive rate is low enough to show anyone (12), what `M37` simulation actually
costs the user in machine time (13), two firmware-behaviour questions in 15 (which commands' `P`
parameter is a tool number rather than a fan index; whether `M291` on its own actually pauses a
print), and whether Vuetify's `useDisplay` breakpoint can be driven under the test harness at all
(16 §G). Resolving a stop point by picking the convenient answer is worse than not doing the task —
**stop and report**, as the section at the bottom of this file says.

## What task 16's audit pass caught, as bug classes

All three gates were green and 1,065 tests passed on the first cut of task 16. The audit still found
seven defects, and the shape of them is worth keeping:

1. **A promise chain used as a queue is a single point of failure.** `autoRun`'s serialiser did
   `queue = queue.then(...)`; one unexpected throw left `queue` rejected and every later upload's
   `.then` was skipped — auto-run went permanently and silently dead. Anything chained this way needs
   a handler that cannot reject (`runGuarded`).
2. **An `await` invalidates what you captured before it.** `FileInspector.inspect()` read `props.path`,
   awaited a full analysis, then wrote the result back without re-checking — so switching files
   mid-inspection showed, and reported, one file's figures under another's name. Re-check after every
   await, and make the payload carry the identity it belongs to.
3. **A gate must consume exactly what the UI shows.** The preflight gate re-derived its own check list
   and so missed the asynchronous macro check that the Inspect tab (and `docs/usage.md`) call an Error.
   Emit the rendered verdict outward; do not recompute a parallel one.
4. **Work whose result is discarded is still work.** Both the batch and auto-run downloaded and
   prescanned every file to compute an `existingStamp` that `checkSafety` returns at warn level and
   neither caller reads — a second full transfer of every file, for nothing. Trace what a value
   actually reaches before paying to produce it.
5. **A second copy of a formatter drifts.** `runReport` grew its own `formatBytes` that stopped at
   KiB, so a report said `+40960.0 KiB` where the screen said `+39.1 MiB` for the same run.
6. **A control moved to a new branch can leave its most useful case unreachable** — the run report
   button sat inside `v-else` of "did anything change", hiding it from exactly the no-op run it best
   explains.
7. **A test named for a condition it never establishes proves nothing.** "…at xs" passed identically
   at 1400px wide, because the attribute it asserted was unconditional. Every test added for a
   behaviour here now has its teeth checked by breaking the behaviour and watching it fail.

## What a work order here must contain

If you are writing a new one, match the shape. A task is not ready to hand over without all of it:

1. **The failure or the gap** — what is wrong now, or what cannot be done. Not "add feature X".
2. **Exact call sites** — file and line, verified against the current code, not remembered.
3. **The design decisions already made**, with their reasons — so they are not silently re-litigated.
4. **The traps**, named. Anything discovered the hard way, written down before it is hit again.
5. **The tests to write**, specifically. "Add tests" is not a specification.
6. **Acceptance criteria** — observable, checkable without hardware.
7. **An explicit out-of-scope list.** Scope creep is likeliest in exactly the files a task touches.

If a task has an unresolved question that changes the design, it does not become ready by being
written more confidently. Give it a **stop point**: a first step that resolves the question, and an
instruction to stop and report if the answer differs from the assumption.

## The gates — all three, before every commit

The unit tests alone do not catch the failures that matter:

```bash
npm test
DWC_DIR=/path/to/DuetWebControl npx dwc-plugin-typecheck
DWC_DIR=/path/to/DuetWebControl npx dwc-plugin-verify-build
```

On this machine `DWC_DIR=/c/Users/live/Documents/Github/DuetWebControl`. All three pass on `main`, so
any failure is yours.

**On Windows, `verify-build`'s type check does not run.** DWC's `scripts/build-plugin.js` launches
`node_modules/.bin/vue-tsc` with a bare `spawnSync` — no `.cmd`, no shell — which fails with `ENOENT`
on Windows; the empty output reads as zero errors, and it prints "Type check passed" even with a type
error planted in a source file. `dwc-plugin-typecheck` does run (it goes through a shell) but
deliberately skips test files. So on Windows nothing local type-checks `test/` or `src/__tests__/`:
the v1.2.0 release build failed in CI on a test-file type error (`attachTo` passed to `mountInDwc`)
that every local gate had passed. Until that is fixed upstream, a green local `verify-build` proves the
bundle builds, not that it type-checks — reproduce CI's check by running `vue-tsc` from the DWC
checkout against the tsconfig `typeCheckPlugin` generates (with forward-slash paths), and read its raw
output for this plugin's files.

## Golden files

`test/golden/*.gcode` are committed expectations, one per preset per slicer fixture.
`npx vitest run -u` regenerates them — but **read the resulting diff line by line before committing
it**. A golden diff is either a bug you just introduced or a fix you can explain in the commit
message. If a task says it should not change a golden file and one changes, stop and work out why:
that is the suite doing its job.

Two real bugs have been caught this way already — a spurious timelapse trigger fired by a layer
miscount on the start block's Z move, and a trailing newline duplicated on every run.

## House style

- Tabs, double quotes, `Array<T>` over `T[]`.
- Transformation logic is **pure and lives in `src/model/`**, unit-tested directly. `.vue` files
  render and delegate. `src/dwc/` is the only place that may import from `@/stores/*`.
- Comments explain *why*. Never restate the code. Match the density of the file you are in.
- A new step type is one module plus one line in `model/steps/registry.ts` — the "add step" menu,
  the config form, validation and two self-maintaining tests all follow from the registry. If you
  find yourself writing a bespoke form component for a step, stop: the schema is the mechanism.

## Commits

One per task, or one per coherent part of a large task. Imperative subject. The body explains the
failure being fixed rather than the code being added. End with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## If a task turns out to be wrong

These are written by reading the code, not by running it against a printer. If a premise does not
hold — the object-model field is not there, the store method behaves differently, the design
collides with something — **say so and stop.** Do not build a workaround and carry on. A wrong fix
in the safety layer is worse than the defect it was meant to fix, and a plausible-looking guess in
the transformation layer corrupts print files.
