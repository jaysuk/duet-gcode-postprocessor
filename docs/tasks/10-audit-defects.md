# Task 10 — defect pass on tasks 08 and 09

**Read [README.md](README.md) first, then [CLAUDE.md](../../CLAUDE.md).** The four non-negotiables
there are binding.

This is the second audit-driven defect pass, in the same spirit as
[07-audit-defects.md](07-audit-defects.md): the defects below were found by reading tasks 08 and 09's
own output against the rest of the codebase, not by a hardware report. Every one has a reproduction
below that **fails on the current `main` and must pass after the fix**.

**Do this task before 11, 12 or 13.** Finding A undermines the move-time model that phases 13–15 all
build on top of, and it is the direct consequence of task 08 shipping a step that *creates* the
input the model cannot read. Fixing it later means re-testing everything built on it in between.

---

## Finding A — `TimeEstimator` gives a `G2`/`G3` arc zero time *(high)*

`src/model/gcode/timeModel.ts:163` returns early for anything that is not `G0`/`G1`, so an arc move
contributes **nothing at all** to the estimate. That was harmless when nothing in the codebase
produced arcs. Task 08 shipped `arcWeld`, whose entire purpose is to turn hundreds of `G1` moves into
`G2`/`G3` — and PrusaSlicer 2.8+ and OrcaSlicer emit arcs natively with "arc fitting" enabled, so
arc-bearing source files also arrive without this plugin doing anything.

Everything downstream of the estimate is wrong on such a file:

- the inspector's "Print time (this machine)" under-reports, badly, on any curved print;
- `rewriteTime` writes `M73 P`/`R` markers computed against a total that omits every arc;
- `preheat` places `M568 A2` insertions on a time axis that skips arcs, so a pre-heat lands late —
  the one failure mode task 06 was written to avoid;
- task 09's own `clampedSeconds`/`unclampedSeconds`/`clampedMoveCount` never see an arc either.

Worst case is a file processed by `arcWeld` and then inspected, where the estimate collapses toward
zero because most of the motion is now arcs.

**Reproduction** (add to `src/__tests__/timeModel.test.ts`, or `analysis.test.ts` as shown):

```ts
it("times a G2/G3 arc rather than treating it as zero-duration", () => {
	// Half circle r=10 from (0,0) to (20,0) at F600 (10 mm/s): ~31.4mm of travel, so ~3s
	const arc = analyseText("G1 X0 Y0 F600\nG3 X20 Y0 I10 J0", undefined, LIMITS);
	expect(arc.estimatedSeconds).toBeGreaterThan(1);
});

it("does not report a file made only of arcs as having nothing to time", () => {
	const arcs = analyseText("G1 X0 Y0 F600\nG3 X20 Y0 I10 J0\nG3 X0 Y0 I-10 J0", undefined, LIMITS);
	expect(arcs.timeSource).toBe("model");
});
```

Both currently fail — the second returns `"none"`, the first `null`.

**The fix.** Accept `G2`/`G3` in `TimeEstimator.line` and time them against their **arc length**, not
the chord. Arc length is `radius × |sweep|`, and every input is already on the line:

- centre is `(startX + I, startY + J)` — RRF requires centre format and `arcFit.ts` already relies on
  that (see its module comment and `DoArcMove` in RRF's `GCodes.cpp`);
- `radius = hypot(I, J)`;
- sweep is the signed angle from start to end about that centre, taken the short way for the
  direction the command states — `G2` is clockwise, `G3` anticlockwise. A full circle (start point ==
  end point) is a sweep of exactly `2π`, not `0`, and is a real thing `arcWeld` can emit.

Time the resulting distance with the existing XY branch's own limit lookup — an arc is an XY move and
is limited by the same axes. Do **not** add a second copy of the trapezoid logic; extract the XY
branch's body into a helper if that is what it takes to share it.

**Trap:** `R`-format arcs (`G2 X.. Y.. R..`) exist in Marlin-flavoured files. RRF supports them but
they are ambiguous between the short and long arc (also noted in `arcFit.ts`). Do not guess: time an
`R`-format arc against the chord, exactly as today, and leave a comment saying why. Under-counting a
rare command is acceptable; inventing a sweep is not.

---

## Finding B — flow on an arc is computed from the chord *(medium)*

`src/model/analysis.ts:196` lets `G2`/`G3` into `applyG`, and `analysis.ts:253` then measures the move
with `Math.hypot(dx, dy, dz)` — a straight line between the endpoints. For an arc that is the chord,
which is always shorter than the path actually travelled, so **flow is over-stated**, without limit as
the sweep approaches a full circle (where the chord tends to zero).

This is task 09's flow figure being wrong on exactly the files task 08 produces, and it can raise a
spurious "exceeds its own stated maximum flow" warning — the one warning that check was written to
only ever fire on real evidence.

**Reproduction** (add to `src/__tests__/analysis.test.ts`, `volumetric flow` describe block):

```ts
it("measures an arc along its arc length, not its chord", () => {
	const meta = parseMetadata("; filament_diameter = 1.75");
	// Half circle r=10 from (0,0) to (20,0): chord 20mm, true path ~31.4mm
	const arc = analyseText("G1 X0 Y0 F600\nG3 X20 Y0 I10 J0 E1", meta);
	const straight = analyseText("G1 X0 Y0 F600\nG1 X20 Y0 E1", meta);
	expect(arc.peakFlowMm3PerSec).toBeLessThan(straight.peakFlowMm3PerSec as number);
});
```

Currently the two are *exactly* equal, which is the proof the chord is being used.

**The fix.** Share finding A's arc-length helper. Put it in `model/gcode/arcFit.ts` (it is arc
geometry, it is pure, and that module is already the home for exactly this) and import it from both
`timeModel.ts` and `analysis.ts`. One implementation, two callers — the same rule task 09 applied when
it exported `combinedAxisLimits` rather than copying it.

---

## Finding C — `clampFeedrate` mis-reads extrusion after `G92` *(medium)*

`src/model/steps/clampFeedrate.ts:100` returns early for every command that is not `G0`/`G1`, so the
step's own running `x`/`y`/`e` are never updated by `G92`. `G92 E0` is emitted constantly by Cura and
by any absolute-extrusion file; after one, the step's `e` is stale by the whole file's extrusion so
far, the next move's `deltaE` comes out hugely negative, and the move is classified `"travel"`.

With **Apply to: printing moves**, that move is then silently skipped and never clamped. The step
reports a lower count than it should and quietly does less than the user asked.

**Reproduction** (add to `src/__tests__/clampFeedrate.test.ts`):

```ts
it("keeps tracking extrusion across a G92 E0, as an absolute-E file emits constantly", () => {
	const input = ["M82", "G1 X10 E5 F24000", "G92 E0", "G1 X20 E0.5 F24000"].join("\n");
	const out = run({ applyToMoves: "printing" }, input).output.split("\n");
	// Both moves extrude and both are above X's 12000 mm/min limit
	expect([out[1], out[3]]).toEqual(["G1 X10 E5 F12000", "G1 X20 E0.5 F12000"]);
});
```

The second move currently comes back untouched at `F24000`.

**The fix.** Handle `G92` before the `G0`/`G1` gate: set whichever of `X`/`Y`/`Z`/`E` it names to the
stated value. `G92` sets position absolutely **regardless of `G90`/`G91`**, so it must not go through
`applyAxis` — that would add to the current position under `G91`. Return `undefined` for the line
itself; `G92` is never rewritten by this step.

**While you are there:** `arcWeld.ts` gets this right only by accident — its `applyAxis` calls sit
above its own `G0`/`G1` check, so an absolute-mode `G92 E0` happens to resolve correctly. Under `G91`
or `M83` it does not. Add the same explicit `G92` handling and a comment, so the next reader does not
have to re-derive that it currently works by luck.

---

## Finding D — the clamping report counts moves the step cannot fix *(medium)*

`timeModel.ts:219` and `:238` increment `clampedMoveCount` for Z-only and E-only moves, but
`clampFeedrate.ts:116` bails out on any move with no XY component. So the inspector can say *"14m of
that is this machine clamping 8,412 moves"*, the user adds the step exactly as the panel invites them
to, and the difference does not go away.

Task 09's own acceptance criterion — *"the step removes the difference"* — is not met for any file
with fast Z or E moves.

**Reproduction** (add to `src/__tests__/clampFeedrate.test.ts`):

```ts
it("clamps a Z-only move against Z's own limit", () => {
	// Z's limit is 20 mm/s = 1200 mm/min
	const { output } = run({}, "G1 Z10 F30000");
	expect(output).toBe("G1 Z10 F1200");
});
```

**The fix — decide which way, and say so in the commit.** Two coherent options; pick one, do not do
half of each:

1. **Make the step do what the report promises** — extend `clampFeedrate` to Z-only and E-only moves,
   against `Z`'s and `E`'s own limits, matching `TimeEstimator`'s own three branches exactly.
2. **Make the report promise what the step does** — count only XY moves in `clampedMoveCount`, and
   say in the doc comment that Z/E clamping is deliberately not reported because nothing offers to
   fix it.

Option 1 is the better one and is what the reproduction above assumes: the whole point of the pairing
is that the report is actionable. Note that an E-only move is a retraction, and clamping a retraction
changes print behaviour more than clamping a travel does — so if you take option 1, gate E-only
clamping behind the existing `applyToMoves` setting rather than doing it unconditionally, and say so
in `docs/usage.md`.

---

## Finding E — two doc comments describe an implementation that was changed *(low, but actively misleading)*

`timeModel.ts:151` and `analysis.ts:102` both say `unclampedSeconds` is measured with **"no speed or
acceleration limit applied"**, and the first adds *"instantaneous acceleration assumed"*. Neither is
true of the shipped code: the unclamped accumulator uses this machine's real acceleration and jerk and
skips **only** the speed cap.

That was a deliberate and correct decision — task 09's spec asked both for "limit lookups skipped" and
for `clampedSeconds === unclampedSeconds` on a within-limits file, and those two are mutually
exclusive, because a finite acceleration always costs time the infinite-acceleration figure does not
have. The implementation resolved it the right way round; only the comments were left describing the
version that was replaced.

**The fix.** Correct both comments to say what the code does — the file's own commanded speeds, with
this machine's real acceleration and jerk still applied, so the difference isolates the speed cap
alone — and record *why* it is not the naive "ignore every limit" figure, so it is not "simplified"
back later. No behaviour change, no test change.

**Also**: `clampFeedrate.ts:69`'s `secondsSaved` accumulates seconds **added**, not saved. The warning
text it feeds is right; the variable name is backwards. Rename it.

---

## Finding F — the clamping panel can contradict the stat beside it *(low)*

`FileInspector.vue`'s `clampingLabel` renders `formatDuration(a.clampedSeconds)` — always the *model*
figure. But when the file has `M73` markers, the "Print time (this machine)" stat shows the M73 figure
instead (`analysis.ts`'s `timeSource === "m73"` branch). So the panel can read *"2h 05m — 14m of that
is this machine clamping…"* directly under a stat saying *"1h 40m (from M73 markers)"*, with no
explanation of why the two disagree.

**The fix.** Either present the clamping figure purely as a *difference* ("this machine's limits add
about 14m to this file, across 8,412 moves") and never restate a total, or name the total it belongs
to. The first is simpler and cannot go stale. No new state is needed — `clampedMoveCount` and the two
second counts are already on `FileAnalysis`.

---

## Out of scope

- Anything in phases 13–15. Those are tasks 11–13; this one is repairs only.
- Reworking `TimeEstimator` into a real lookahead planner. Its two documented approximations stand;
  finding A is about a command it does not handle at all, not about accuracy.
- `R`-format arc sweep disambiguation — explicitly excluded by finding A's own trap note.
- Retro-fitting a `clampFeedrate` bundled preset. No preset was asked for in task 09 and adding one
  here would change the golden-file matrix for reasons unrelated to any defect.

## Acceptance

- Every reproduction above fails before your fix and passes after it.
- Golden files are **unchanged**. None of these findings should alter the output of any bundled preset
  on any existing fixture — the four rectilinear fixtures contain no arcs, no `G92 E0` under `M82`,
  and no over-limit feedrates. **If a golden file does change, stop and work out why before
  regenerating it**; that is the suite catching something this task did not anticipate.
- All three gates pass. Note that `npm test` and `dwc-plugin-typecheck` both **exclude** `__tests__`,
  and only `dwc-plugin-verify-build` type-checks test files — task 09 shipped a type error in a test
  that only CI caught, for exactly this reason. Run all three.
