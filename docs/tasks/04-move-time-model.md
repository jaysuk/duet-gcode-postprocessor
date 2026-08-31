# Task 04 — move-time model and `M73` rewrite

Self-contained. **Read [README.md](README.md) and [CLAUDE.md](../../CLAUDE.md) first.**

Design background: [feature-ideas.md](../feature-ideas.md) §0.

## The gap

The slicer's print-time estimate is computed for the machine it *thinks* it is slicing for. On a Duet
with different acceleration, jerk and speed limits it can be out by a large margin, and DWC's
remaining-time display inherits the error because it reads the slicer's own `M73` markers.

Nothing in the plugin has any notion of time. That blocks this feature, and it blocks three others:
pre-heating a tool a known number of seconds ahead (task 06), anchoring an insertion to a point in
time, and reporting where a print actually spends its hours.

## Deliverable

1. A pure move-time model in `src/model/gcode/timeModel.ts`.
2. Time in `FileAnalysis`, and a print-time figure in the inspector alongside the slicer's, so the
   two can be compared.
3. A `rewriteTime` step that replaces the file's `M73` markers with corrected ones.

---

## Part 1 — the model

```ts
export interface MachineLimits {
	/** Per-axis maximum speed, mm/s. */
	maxSpeed: Record<string, number>;
	/** Per-axis maximum acceleration, mm/s². */
	maxAccel: Record<string, number>;
	/** Per-axis instantaneous speed change (jerk), mm/s. */
	jerk: Record<string, number>;
	/** M204 printing and travel acceleration, mm/s². Null when not set. */
	printAccel: number | null;
	travelAccel: number | null;
}

/** Seconds for one move. Pure. */
export function moveTime(input: {
	distance: number;      // mm
	nominalSpeed: number;  // mm/s — already clamped to the axis limits
	accel: number;         // mm/s²
	entrySpeed: number;    // mm/s
	exitSpeed: number;     // mm/s
}): number;
```

Standard trapezoidal profile: accelerate from `entrySpeed` toward `nominalSpeed`, cruise, decelerate
to `exitSpeed`. When the distance is too short to reach `nominalSpeed` the profile is triangular and
the peak speed is `sqrt((2·a·d + v₀² + v₁²) / 2)` — handle that case explicitly, because short
segments are the overwhelming majority of a real file and getting them wrong makes the whole estimate
wrong.

A full lookahead planner is **out of scope**. Approximate the junction speeds with the jerk limit:
entry and exit speed at a corner is the axis jerk, not zero and not the full nominal speed. Assuming
a full stop at every segment boundary would over-estimate enormously; assuming no deceleration at all
would under-estimate. Say which approximation is used in the module comment.

### The unit trap — this will bite

**G-code `F` is mm/min. The object model is mm/s.** `move.axes[].speed`, `.jerk` and
`.acceleration` are all per second; a `G1 F1200` is 20 mm/s. Convert once, at the boundary, and say
so in a comment. A factor-of-60 error here produces an estimate that looks plausible for exactly one
class of file and is nonsense everywhere else.

Also: `E`-only moves (retractions) take time too — they are limited by the extruder's own axis
limits, not the XY ones.

**Tests** (`src/__tests__/timeModel.test.ts`), all closed-form and checkable by hand:

- a long move at constant speed from and to rest: `t = v/a + (d − v²/a)/v + v/a`;
- a short move that never reaches nominal speed uses the triangular peak;
- zero distance is zero time, not `NaN` or a division by zero;
- zero acceleration falls back to `d/v` rather than dividing by zero;
- entry and exit speeds above nominal do not produce negative times;
- doubling acceleration on a short move reduces the time but never below the cruise-limited floor.

---

## Part 2 — the estimator, and the free shortcut

`src/model/gcode/timeModel.ts` also exports a `TimeEstimator` with the same push-per-line shape as
`Analyser`, so the existing chunked reader can drive it:

```ts
export class TimeEstimator {
	constructor(limits: MachineLimits);
	line(token: Tokenised, state: MachineState): void;
	/** Cumulative seconds after every line processed so far. */
	get elapsed(): number;
}
```

**Before modelling anything, look for `M73`.** PrusaSlicer, SuperSlicer, Orca and Bambu all emit
`M73 P<percent> R<minutes remaining>` throughout the file. Where those markers exist, a time axis
already exists and only needs interpolating between them — far more accurate than any model, because
the slicer knew the geometry.

So the estimator has two sources, and `FileAnalysis` must record which was used:

```ts
timeSource: "m73" | "model" | "none";
estimatedSeconds: number | null;
```

The model is for files with no markers, and for the corrected estimate in part 3.

Narrow `MachineLimits` from the object model in `src/dwc/machineSnapshot.ts` alongside the existing
narrowing — not in `model/`.

**Tests:** a file with `M73` markers reports `timeSource: "m73"` and a time matching them; a file
without reports `"model"` and a plausible non-zero time; an empty file reports `"none"` and `null`.

---

## Part 3 — the `rewriteTime` step

A new step, registered as usual, that recomputes `M73 P R` from the model and rewrites every marker,
so DWC's progress bar and remaining-time reflect this machine.

- Rewrite existing markers in place. Do **not** insert new ones at a fixed cadence in this task —
  a file with no markers gets nothing, and the step says so in a warning.
- `P` is percent complete by time (not by bytes — that is what makes the current progress bar
  misleading on prints with dense top layers). `R` is whole minutes remaining, per `M73`'s
  definition.
- Preserve any other parameters on the line.

**Tests:** markers are rewritten and monotonic; `P` reaches 100 and `R` reaches 0 at the end; `P`
never decreases; a file with no markers is byte-identical and produces the warning.

---

## Acceptance

- The inspector shows an estimated print time next to the slicer's, and says which source it used.
- On a fixture with `M73` markers, the reported time matches them closely.
- `rewriteTime` produces monotonic markers ending at `P100 R0`.
- Golden files: only if a new preset is added. The existing seven must not change.

## Out of scope

- A full lookahead planner. The jerk approximation is deliberate; note its limits, do not fix them.
- Inserting `M73` markers into a file that has none. Worth doing later; not here.
- Anything consuming the time axis — pre-heat is task 06.
- Input shaping, pressure-advance timing effects, and the `M593`/`M572` interactions. Out of reach
  and not worth pretending about.

## A note on accuracy

This will not match the firmware exactly, and it does not need to. The bar is *better than the
slicer's estimate for this machine*. Compare against a fixture's own `M73` markers as a sanity check;
if the model is out by more than roughly 20% on a file whose markers exist, something is wrong with
the model rather than with the slicer — most likely the mm/min conversion.
