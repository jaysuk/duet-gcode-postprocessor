# Task 07 — defect pass on tasks 04–06

Self-contained. **Read [README.md](README.md) and [CLAUDE.md](../../CLAUDE.md) first.**

Every defect below was found by auditing the work committed in `603b32c`, `4760e31` and `9738d23`,
and every one is **reproduced with evidence** rather than suspected. Fix them in the order given —
A is the one that makes the other features untrustworthy.

> These are not hypotheses. Each has a reproduction you can run before you change anything. Run it
> first and watch it fail; if it does not fail, stop and report, because something has changed.

---

## A — the analysis pass reads the source file, not the recipe's own output *(high)*

### The failure

`rewriteTime` and `preheat` both take their time axis from `AnalysisRunner`, which
[`processFile`](../../src/model/io/transfer.ts) drives over the **downloaded blob** — the file
*before* any step has touched it. So a recipe whose earlier steps change how long the print takes
produces `M73` markers computed for a file that no longer exists.

### Reproduction

Put a `paramRewrite` step (scale `F` by 0.25 on `G0,G1`) **before** a `rewriteTime` step. Every
feedrate is quartered, so the real print takes roughly four times as long. Observed:

```
F quartered by an earlier step:  M73 P0 R25 | M73 P51 R12 | M73 P100 R0
F untouched:                     M73 P0 R25 | M73 P51 R12 | M73 P100 R0
IDENTICAL? true
```

The markers are byte-identical and confidently wrong. This is worse than not rewriting them: DWC's
remaining-time display trusts `M73` completely, and the whole point of the feature is that it can be
trusted. `preheat` has the same root cause — its lead times are measured on a time axis that ignores
every preceding step.

### The fix

Collectors must see what their own step will see: the output of the steps ordered **before** the
step that declared them.

1. Group collectors by the **index of the step that declared them**. `collectorsFor` currently
   returns a flat array and throws that association away — change it to return
   `Array<{ stepIndex: number; collectors: Array<AnalysisCollector> }>`, or a `Map` keyed on index.
2. For each distinct index `i` that has collectors, run one analysis sub-pass in which the lines are
   first pushed through a `Pipeline` built from steps `[0, i)`, and the **resulting** lines are fed
   to that group's collectors.
3. Merge every group's results into the single `ReadonlyMap<string, unknown>` the transform pass
   already receives. Collector ids are already unique per step type; if two instances of the same
   step type both declare collectors, the second silently overwrites the first — fix that too, by
   namespacing the id with the step index (`` `${id}#${stepIndex}` ``) and having the step read back
   the same namespaced key. `RunContext` will need to tell a step its own index for that to work;
   add `readonly stepIndex: number` to the per-step view or pass the resolved key into `create`.

In the common case (one collector-declaring step, nothing before it that matters) this is one extra
pass, exactly as today.

### Traps

- **Build separate transform instances for the analysis sub-pass.** Transforms are stateful
  (`rewriteTime` counts markers, `insertAt` tracks `fired`). Reusing the same objects across both
  passes corrupts both. Call `buildTransforms` again for the prefix.
- **Do not feed the stamp line to collectors.** Construct the sub-pass `Pipeline` with
  `stampLine: null`.
- **`onStart`/`onEnd` of the prefix steps fire twice** — once per pass. For `insertAt` with a
  `fileStart`/`fileEnd` anchor those emitted lines are genuinely part of what the later step sees, so
  feed them to the collectors; but a `script` step's `ctx.warn` output will now be recorded twice.
  De-duplicate warnings (`RunStats.warn` already dedupes by message — verify it still does) and do
  **not** let the sub-pass's `RunStats` leak into the reported result.
- A step that declares a collector and is *preceded by another* collector-declaring step gets the
  earlier step's transform output, which is correct, but that earlier step's own collector result is
  not yet available when the prefix pipeline runs its `onStart`. Accept that: pass an empty analysis
  map to the prefix pipeline and say so in a comment.

### Tests

In `src/__tests__/transfer.test.ts` (it has `FakeGateway` and the real `processFile`):

- the reproduction above, as an assertion: with the `paramRewrite` step in front, the emitted `R`
  values **differ** from the no-op case, and the final marker is still `P100 R0`;
- a recipe whose earlier steps do not affect timing produces the same markers as today (no
  regression);
- two collector-declaring steps in one recipe each get their own upstream view;
- the no-collector recipe still runs exactly one pass (the existing test must keep passing).

---

## B — a clamped pre-heat is cancelled by a later standby *(medium)*

### The failure

`planPreheats` decides whether to emit a standby for the outgoing tool with:

```ts
const prevHasPendingPreheat = insertions.some(
    (ins) => ins.tool === previousTool && ins.action === "preheat" && ins.atSeconds >= changeTime,
);
```

Two things are wrong. It inspects **insertions already pushed**, so a pre-heat for a *later* change
has not been created yet and cannot be seen. And when a pre-heat is clamped it sits at
`atSeconds === 0`, which is never `>= changeTime`, so the guard cannot fire even in principle.

### Reproduction

Run the `preheat` step over the committed `test/fixtures/two-tool.gcode` fixture. Observed output
begins:

```
M568 P0 A2
M568 P1 A2
M568 P0 A2
; generated by PrusaSlicer ...
```

and tracing the heater state through the result gives:

```
T0 selected -> ACTIVE
T1 selected -> ACTIVE
T0 selected -> standby      <-- the third pre-heat was cancelled
```

`M568 P0 A1` is emitted before T0's third selection and nothing re-activates it. The run report
nonetheless says *"Pre-heated 3 tool changes"*. RRF's own `T` handling will set the tool active on
selection, so this does not break the print — it silently achieves nothing while claiming success,
which is precisely the failure mode `06-preheat.md` called out.

On a file with generous gaps between changes the behaviour is correct (verified: all three
selections ACTIVE, leads ~56 s), so this is specific to any change whose lead cannot fit.

### The fix

Make `planPreheats` two-phase:

1. Walk the changes and compute every pre-heat time first.
2. Then decide standbys, with the guard asking the question that actually matters: *does
   `previousTool` have a pre-heat scheduled at or before this point that has not yet been consumed by
   its own tool change?* If so, emit no standby for it.

Count in `leadSeconds` only the pre-heats that survive this pass, so the report stops over-claiming.

## C — a clamped pre-heat is emitted before the file's own temperature setup *(medium)*

Same reproduction. The three `M568 ... A2` commands land at absolute line 0 — **above**
`M568 P0 R140 S200`, the line that defines what "active" even is for that tool. Setting a tool active
before its active temperature has been set applies whatever was left over from the previous job.

Clamp to the first line *after* the file's own temperature setup for that tool (the first `M568`/`G10`
carrying `R`/`S` for it, or the first tool selection, whichever comes first) rather than to line 0. If
no such point exists early enough to give any useful lead, emit nothing for that change and say so —
a pre-heat with a one-second lead is not worth a line of G-code.

Do not stack several pre-heats at one instant. If two changes both clamp to the same point, keep the
earliest-needed tool's and drop the rest with a report line.

### Tests for B and C

Add to `src/__tests__/preheatStep.test.ts` a **state-trace helper** — walk the output, track each
tool's active/standby/off state through the `M568 A<n>` commands, and record its state at each `T`
selection. Then assert:

- on the two-tool fixture, **every tool is ACTIVE at every selection** (this is the invariant the
  existing tests failed to check, and it is what caught B);
- no `M568 P<n> A2` is emitted before the file's own `S`/`R` setup for tool `n`;
- the reported pre-heat count equals the number of pre-heats that actually survive to their change;
- the long-file case (generous gaps) still behaves as it does today.

The existing assertions `expect(output).toContain("M568 P0 A1")` and
`expect(lines[0].trim()).toBe("M568 P0 A2")` both pass *because of* these defects. Replace them.

---

## D — the two-tool fixture is not in the fixture suite *(low)*

`test/fixtures/two-tool.gcode` was added by task 06 but never added to `FIXTURES` in
[`golden.test.ts`](../../src/__tests__/golden.test.ts), so it is not parse-checked and gets no
golden coverage. Add it. Expect new golden files for the existing presets against it; read the diff
line by line before committing, as always.

The fixture is also unrealistically short — the whole print is a few seconds while a heat-up is
~20 s, which is why everything clamps. Either lengthen it so at least one change has a genuine lead,
or add a second, longer two-tool fixture for the pre-heat tests specifically. Prefer the latter: the
short one is a good clamping regression case now that clamping is fixed.

## E — `machineLimits` degrades silently on a partly-configured machine *(low)*

`machineLimits` returns whatever it finds. A machine with no `motionSystems`, an axis missing
`acceleration`, or an untuned setup yields partial maps, and `TimeEstimator` quietly falls back to
`Infinity` accelerations — which degenerates to `distance / feedrate`. The inspector still labels the
result *"estimated from this machine's limits"*.

The Inspect button is disabled while disconnected, so this is not a "nonsense while offline" bug; it
is a labelling problem on a real but incompletely configured machine. Make `machineLimits` report
completeness (e.g. return `{ limits, complete: boolean }`, or expose a `hasAxisLimits` flag), and have
the inspector say *"estimated (machine limits incomplete)"* when it is not. A number presented as
machine-specific when it is not is the same class of error as A.

## F — `T-1` is invisible to the tokeniser *(informational, pre-existing)*

`tokenise("T-1")` returns `code: null` because the scanner accepts only digits and `.` after the
command letter. `T-1` is RRF's deselect-all-tools command, so the state machine and the pre-heat
collector never see a deselect. This predates task 06 and is **not** in scope here — recorded so the
next person does not rediscover it. If it is ever fixed, `preheat` must not treat `-1` as a tool
number to look up.

---

## Acceptance

- Every reproduction above fails before your change and passes after it.
- The full suite, `dwc-plugin-typecheck` and `dwc-plugin-verify-build` all pass.
- Golden files change **only** for the newly added `two-tool` fixture (D). If any existing
  golden file changes, stop and work out why.

## Out of scope

- Making the analysis pass incremental or cached (see `05-analysis-pass.md`'s own out-of-scope list).
- Fixing `T-1` (F above).
- Any new feature. This task only makes what was already shipped do what it claims.
