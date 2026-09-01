# Task 09 — volumetric flow audit and feedrate clamping

Self-contained. **Read [README.md](README.md) and [CLAUDE.md](../../CLAUDE.md) first.**
Requires [04](04-move-time-model.md) (the move-time model) and [07](07-audit-defects.md) (which fixes
how a step sees the file). This finishes §8 phase 12 — the last two bullets there are the only ones
still open.

## The gap

Two failures that the plugin can now see and currently does not mention.

**The hot end cannot melt as fast as the slicer asked.** Flow is `mm³/s`, and it is the real limit on
a fast print. A profile tuned for a 0.4 mm nozzle, re-used with a 0.6, or a "fast" profile on a stock
hot end, asks for more than the heater can deliver. The result is under-extrusion that looks like a
partial clog and gets misdiagnosed as one. Nothing in the file says which move first asks for too
much — but the plugin already tracks extrusion per move and, since task 04, how long each move takes.

**RepRapFirmware clamps silently.** A file full of `F18000` on a machine whose `M203` tops out at
`F9000` simply takes twice as long, and nothing anywhere says so — not the slicer's estimate, not the
file, not DWC. The user concludes the printer is slow. The move-time model already computes the
clamped time; computing the unclamped one alongside it turns that into a number worth showing.

## Part 1 — per-move flow, in the analyser

Extend the analyser (`src/model/analysis.ts`) to record volumetric flow. It already sees every move
and, with `limits` supplied, already drives a `TimeEstimator`.

```ts
/** mm³/s of filament demanded, at the worst move in the file. Null when the file does not extrude,
 *  or when the filament diameter is unknown and cannot be assumed. */
peakFlowMm3PerSec: number | null;
/** 1-based source line of that move, for a report that can be acted on. */
peakFlowLine: number | null;
/** The slicer's own stated ceiling, when it states one. Null otherwise. */
statedMaxFlowMm3PerSec: number | null;
```

Flow for one move is `filamentArea × ΔE / seconds`, where `filamentArea = π × (d/2)²`.

**Do not assume a filament diameter.** Read it from the slicer metadata — `meta.values` already holds
every raw key, so `filament_diameter` (PrusaSlicer/Orca) and `filamentdiameter` (Cura) are there.
Promote it to a real field on `SlicerMetadata` alongside `layerHeight`. If it is absent, report
`null` rather than assuming 1.75 mm: a 2.85 mm machine would get a figure 2.65× wrong, and a
confidently wrong flow number is worse than none. Say so in the comment.

Likewise `statedMaxFlowMm3PerSec` comes from the slicer's own `max_volumetric_speed` /
`max_volumetric_extrusion_rate_slope` style keys when present — **do not invent a threshold.** There
is no object-model field for what a hot end can melt, and guessing one produces either false alarms
or false comfort.

### The check

In `src/model/checks.ts`, machine-independent so it runs offline like the other structural checks:

- **Information** — always, when a flow figure exists: the peak flow and the line it occurs on.
- **Warning** — only when the slicer stated a ceiling and the file exceeds it. That means the file
  contradicts its own profile, which is a real and attributable finding.

Nothing else. Without a stated ceiling there is no honest warning to give.

## Part 2 — the clamping report

`TimeEstimator` already clamps each move to the machine's limits. Add a second, parallel accumulator
that does not — the time the file would take if the machine could do what the file asks — and expose
both:

```ts
/** Seconds the machine will actually take, limits applied. */
clampedSeconds: number;
/** Seconds the file asks for, ignoring this machine's speed and acceleration limits. */
unclampedSeconds: number;
/** Moves whose commanded feedrate exceeds this machine's limit for the axes involved. */
clampedMoveCount: number;
```

Keep it in `timeModel.ts` next to the existing accumulator; it is the same loop with the limit
lookups skipped, and doing it in one pass costs nothing.

Report it in the inspector, next to the two print-time figures already there (see
`FileInspector.vue`'s `stats`): *"1 h 42 m — 14 m of that is this machine clamping 8,412 moves that
ask for more than its limits."* Show it only when `clampedMoveCount > 0`; on a correctly-profiled
file it is noise.

Honour task 07's finding E: if the machine's limits are incomplete, do not present this as fact.

## Part 3 — the clamping step

`src/model/steps/clampFeedrate.ts`, registered as usual. Rewrites feedrates the machine cannot honour
down to what it can, so the file states the truth and any downstream estimate is right.

Config: `applyToMoves` (`printing` / `travel` / `both`, default both) and `alsoClampAcceleration`
(default off — emits `M204` at the machine's limits where the file sets a higher one).

Two things this must get right:

- **`F` is per-axis-combination, not global.** A move using only X may legitimately exceed the Y
  limit. Clamp against the limit for the axes the move actually touches, exactly as `moveTime` does.
  Reuse that logic; do not write a second copy.
- **Do not touch a move whose `F` is already within limits**, and leave the line byte-identical when
  the clamped value equals the original. The diff must show only real changes.

Report in `onEnd` how many moves were clamped and the time difference, so the user can see whether it
was worth doing.

## Tests

`src/__tests__/analysis.test.ts`:

- flow is computed from the metadata's filament diameter, and is `null` when the diameter is absent;
- a 2.85 mm file and a 1.75 mm file with identical `E` values give different flow figures — this is
  the assumption most likely to be silently wrong;
- peak flow reports the right line;
- `statedMaxFlowMm3PerSec` is read when the slicer states it and `null` when it does not.

`src/__tests__/checks.test.ts`:

- exceeding a stated ceiling warns; exceeding no stated ceiling does not warn;
- the informational flow line appears whenever a figure exists.

`src/__tests__/timeModel.test.ts`:

- a file entirely within limits has `clampedSeconds === unclampedSeconds` and `clampedMoveCount === 0`;
- a file asking for double the machine's max speed takes measurably longer clamped than unclamped;
- the count is of moves, not lines.

`src/__tests__/clampFeedrate.test.ts`:

- a move above the limit is rewritten, one below it is byte-identical;
- an X-only move is clamped against X's limit, not the tighter of X and Y;
- travel and printing moves are selected correctly by the config;
- a file needing no clamping is byte-identical and the report says so.

## Acceptance

- On a fixture with feedrates above the fixture machine's limits, the inspector states how much time
  clamping adds, and the step removes the difference.
- No flow warning is ever produced from an assumed filament diameter or an invented flow ceiling.
- All three gates pass. Golden files unchanged unless a preset is added.

## Out of scope

- Predicting under-extrusion. Flow above a stated ceiling is reported; what it does to the print is
  not something this can honestly model.
- Pressure advance and `M572` interaction with flow — out of reach, same as in task 04.
- Reading a melt-rate limit from the object model. There is no such field; do not add a made-up
  default in place of one.
