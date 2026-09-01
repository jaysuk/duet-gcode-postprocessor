# Task 08 — arc welding (G0/G1 → G2/G3)

Self-contained. **Read [README.md](README.md) and [CLAUDE.md](../../CLAUDE.md) first.**
Do [07](07-audit-defects.md) first — it fixes a defect in how steps see the file, and this step is
ordering-sensitive.

Prior art: [ArcWelderLib](https://github.com/FormerLurker/ArcWelderLib) by FormerLurker (AGPL-3.0).
**This is a clean-room reimplementation of a published algorithm, not a port of that code.** See the
attribution policy in `docs/feature-ideas.md`; credit the algorithm in the module comment and in
`docs/usage.md`, do not copy source.

## The gap

A slicer approximates every curve with hundreds of short straight `G1` moves. On a curved part that
is most of the file. Consequences: large files, and a command rate that can outrun the board on fast
curves, giving visible faceting and stuttering.

RepRapFirmware executes true arcs natively. Converting runs of collinear-on-a-circle `G1` moves into
single `G2`/`G3` arcs typically removes 50–80% of the lines in a curved file, and hands the motion
planner a smooth path instead of a polyline.

## Firmware behaviour — verified, do not re-derive

Checked against the RRF source at `C:\Users\live\Documents\Github\RRFBuild\RepRapFirmware`
(`src/GCodes/GCodes.cpp`, `GCodes::DoArcMove`, and `src/Config/Configuration.h`). Record these
citations in the module comment.

| Fact | Where |
| --- | --- |
| Both centre format (`I`/`J`) and radius format (`R`) are supported; `R` takes precedence if present | `DoArcMove`, `const bool radiusFormat = gb.Seen('R')` |
| **At least one of `I`/`J` must be present and non-zero**, else `"no I J K or R parameter"` | `DoArcMove`, centre-format branch |
| Plane comes from `G17`/`G18`/`G19`; XY is index 0 and the default | `selectedPlane`, `axis0`/`axis1` lookup |
| `E` works on `G2`/`G3` exactly as on `G1` — same `LoadExtrusionFromGCode` call | `DoArcMove` |
| A full circle results when start and end coincide in centre format | comment in `DoArcMove` |
| **In non-CNC mode, start-radius and end-radius may differ by at most `MaxNonCncRadiusError = 0.05 mm`**, else `"final radius not equal to initial radius"` | `Config/Configuration.h:73`, checked in `DoArcMove` |
| In CNC mode that tolerance is `MaxCncRadiusErrorMm = 0.0022` | `Config/Configuration.h:71` |

The comment beside that tolerance in RRF's own source reads:

> *"In non-CNC modes we allow a larger error because slicers and **ArcWelder** may not output
> coordinates to a resolution of 0.002mm"*

— RRF already accommodates exactly this transformation. Use **centre format (`I`/`J`)**: radius
format has a short-arc/long-arc sign ambiguity and throws outright when the radius is fractionally
too small to reach the endpoint.

## The algorithm

From ArcWelderLib's `ArcWelder/segmented_shape.cpp` and `segmented_arc.cpp`. Implement it in
`src/model/gcode/arcFit.ts`, **pure**, with no knowledge of steps or pipelines.

Buffer consecutive candidate points. Once at least `minSegments` are buffered, test whether they fit
one arc; keep extending while they do; when a new point breaks the fit, emit the arc for the points
that did fit and restart the buffer from the last emitted endpoint.

**Circle from three points** — not least squares. Use `points[0]`, `points[floor(n/2)]` and
`points[n-1]`, and the circumcircle:

```
a = x₁(y₂ − y₃) − y₁(x₂ − x₃) + x₂y₃ − x₃y₂
b = (x₁² + y₁²)(y₃ − y₂) + (x₂² + y₂²)(y₁ − y₃) + (x₃² + y₃²)(y₂ − y₁)
c = (x₁² + y₁²)(x₂ − x₃) + (x₂² + y₂²)(x₃ − x₁) + (x₃² + y₃²)(x₁ − x₂)

centre = (−b / 2a, −c / 2a)      radius = |centre − p₁|
```

`a == 0` means the three points are collinear — reject, and do not let floating-point noise turn a
straight line into a vast arc (that is what `maxRadius` is really for).

**Deviation test**, every buffered point, both parts:

1. **Radial** — `abs(distance(point, centre) − radius) > resolution` rejects.
2. **Perpendicular** — for each consecutive pair, project the centre onto that segment; if the
   projection falls within the segment, its distance to the centre must also be within `resolution`.
   Without this, a chord that cuts the circle passes the radial test at both ends while bowing away
   in the middle.

**Arc length test** — the fitted arc's length must be within `pathTolerancePercent` of the summed
length of the original polyline. This is what stops a fit that is geometrically plausible but takes a
different route (the long way round the circle).

**Direction** — convert start, middle and end to angles about the centre with `atan2`, take the swept
angle, and emit `G2` when it is negative (clockwise) and `G3` when positive.

**`I`/`J`** are the centre relative to the **arc's start point**: `I = centre.x − start.x`,
`J = centre.y − start.y`.

### Configuration and defaults

Match ArcWelder's names and defaults so a user who knows the tool is not surprised:

| Field | Default | Meaning |
| --- | --- | --- |
| `resolutionMm` | `0.05` | maximum deviation of the arc from the original path |
| `pathTolerancePercent` | `5` | permitted difference between arc length and polyline length |
| `maxRadiusMm` | `9999` | reject arcs larger than this (catches near-collinear noise) |
| `minSegments` | `3` | fewest source moves worth replacing with one arc |
| `allow3dArcs` | `false` | permit Z to change across an arc (vase mode helices) |
| `extrusionRateVariancePercent` | `5` | abort the arc if mm of filament per mm of travel varies more than this |

### When the buffer must break

Getting this list wrong is how arc welding corrupts a file. Break — flush the current arc and start
fresh — on **all** of:

- any command that is not `G0`/`G1`, including every `M`-code and every `T`;
- a change of extrusion character: extruding / retracting / travelling must be homogeneous across one
  arc (a retraction welded into an arc becomes a retraction spread along it);
- a `Z` change, unless `allow3dArcs`;
- a change of feedrate (or carry `F` onto the arc — pick one and say which; carrying it is fine
  because RRF applies `F` to the whole arc);
- a layer change or a `;TYPE:` feature-comment boundary — welding across a feature boundary makes the
  fan-by-feature and per-feature statistics wrong;
- zero-length moves;
- extrusion rate varying beyond `extrusionRateVariancePercent`;
- the buffer reaching a hard cap (see the memory trap below).

### Extrusion

Accumulate relative E across the merged moves and emit the sum on the arc. In absolute-E mode
(`M82`) emit the final absolute value instead. `LineContext.relativeE` already tracks which mode is
in force — use it, do not guess from the sign.

## Wiring it into a step

`src/model/steps/arcWeld.ts`, registered in `registry.ts` as usual.

**The pipeline contract needs care here and it is the part most likely to go wrong.** `onLine` is
called with one line and returns its replacement — a step cannot retroactively delete lines it has
already emitted. So an arc-welding step must *withhold* lines:

- while buffering a candidate run, return `null` (drop the line) for each line taken into the buffer;
- when the run closes, return the `G2`/`G3` command from the `onLine` call that closed it, followed
  by the line that closed it;
- if the run turns out not to be weldable, return the buffered lines verbatim, in order, followed by
  the closing line;
- **`onEnd` must flush** whatever is still buffered, or you silently truncate the end of every file.

### Traps

- **Rounding can break the firmware's radius check.** RRF recomputes the radius from the *emitted*
  numbers. Rounding `X`, `Y`, `I` and `J` to three decimals can push
  `|endRadius − startRadius|` past the 0.05 mm limit and the print stops with *"final radius not
  equal to initial radius"*. After formatting the numbers, **re-parse them and verify the check RRF
  will do**; if it fails, either emit more decimals or reject the arc. Test this explicitly.
- **Memory.** Buffering is unbounded by construction and this plugin's whole design is that a 200 MB
  file is never held in memory. Cap the buffer at a few thousand points and flush when it fills.
- **Ordering.** This step changes line counts and coordinates, so it must run *after* anything that
  reads or rewrites moves. `rewriteTime` is unaffected (it neither adds nor removes lines) but
  `preheat` inserts lines, and a `findReplace` targeting `G1` will no longer match a welded arc.
  Document the recommended position (last) in `docs/usage.md` and warn if a `script` or `rules` step
  is ordered after it.
- **`G2`/`G3` are not universally understood.** Most G-code *viewers* render arcs badly or not at
  all, and non-RRF firmware may ignore them entirely, which prints nothing where the curve was. The
  step's help text must say so plainly.
- Do not weld across a `G92` (E reset) — it is not a `G0`/`G1`, so the "any other command" rule
  already covers it; make sure the test proves it.

## Tests

`src/__tests__/arcFit.test.ts` — the pure geometry, all hand-checkable:

- points sampled exactly on a known circle fit it, with the expected centre, radius and direction;
- a straight line is rejected (`a == 0` collinear case), and does **not** come back as a huge arc;
- a point nudged beyond `resolutionMm` breaks the fit; nudged within it, the fit holds;
- the perpendicular test rejects a chord that passes the radial test at both endpoints;
- an arc taking the long way round fails the path-length test;
- clockwise and anticlockwise inputs produce `G2` and `G3` respectively;
- `I`/`J` are relative to the arc's start point, and at least one is non-zero;
- a fitted arc's emitted, **rounded** coordinates still satisfy RRF's 0.05 mm radius check.

`src/__tests__/arcWeld.test.ts` — the step:

- a circle of `G1` moves collapses to one `G2`/`G3` and the endpoint is unchanged;
- total extruded filament across the welded output equals the original, relative and absolute;
- every break condition above ends the arc — one test each, they are cheap;
- a file with no weldable runs is byte-identical;
- `onEnd` flushes a buffer left open at end of file;
- a run shorter than `minSegments` is emitted verbatim, not dropped.

Add a **curved fixture** — `test/fixtures/arc-circle.gcode`, a polygonal circle or two, small enough
to read in a diff. The existing three fixtures are rectilinear and will weld nothing, which is worth
one assertion of its own.

## Acceptance

- On the new curved fixture, line count drops substantially and the traced end position matches the
  original within `resolutionMm`.
- Emitted arcs satisfy RRF's own radius check after rounding.
- All three gates pass.
- Golden files: unchanged, **unless** you add an arc-welding preset — which is worth doing, as one
  step with defaults. If you do, its golden files are new; the existing seven must not move.

## Out of scope

- `G18`/`G19` (ZX and YZ planes). XY only; a slicer does not emit the others.
- Un-welding (`G2`/`G3` → `G1`). Useful for firmware without arc support; separate task.
- `--allow-dynamic-precision` and `--min-arc-segments`/`--mm-per-arc-segment` firmware compensation.
  Those exist for Marlin 1.x and Klipper quirks; RRF does not need them.
- Any attempt to render arcs in the diff preview. It shows text, and that is fine.
