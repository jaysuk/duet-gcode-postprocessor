# Task 06 — predictive pre-heat before a tool change

Self-contained. **Read [README.md](README.md) and [CLAUDE.md](../../CLAUDE.md) first.**
Requires tasks 04 (time model) and 05 (analysis pass).

Design background: [feature-ideas.md](../feature-ideas.md) §1.

> ## ⚠ Step 1 is a verification, and it can invalidate this spec
>
> Two firmware facts below are stated from documentation and object-model field names, **not from
> reading RepRapFirmware's source or the wiki**. Both change the output materially and both are easy
> to get wrong. Verify them first. If either differs from what is written here, **stop and report** —
> do not adjust the code to fit a guess.
>
> 1. **The units and normalisation of `coolingRate` and `coolingExp`** in the `M307` heater model.
>    The assumption below is that the cooling term is expressed per 100 °C above ambient. If it is
>    per 1 °C, every estimate is out by a factor of 100 and the feature will insert pre-heats in
>    absurd places.
> 2. **`M568`'s `A` parameter.** The assumption is `A0` = off, `A1` = standby, `A2` = active, and
>    that `M568 P<n> A2` sets a tool to its active temperature **without selecting it**.
>
> Check `Duet3D/wiki-content` (`User_manual/Reference/Gcodes.md`) *and* the RRF source. CLAUDE.md
> explains why both: source shows what a command does, the wiki says what it is *for*, and the two
> together have already caught one wrong-command choice in this family of plugins.
>
> Record what you find in the module comment, with a link. The next person must not have to redo it.

## The gap

On a toolchanger an idle tool sits at its standby temperature. When it is selected, either the print
stalls waiting for it to heat, or it does not wait and the first extrusion is cold. Slicers handle
this crudely because they do not know how fast a particular hot end heats.

The Duet does know: it measured it during `M307` tuning, and the result is in the object model.

## What to build

A step that, for each tool change, inserts the command to start heating that tool early enough for it
to arrive on temperature exactly when needed.

### Inputs, all from the object model

Narrow them in `src/dwc/machineSnapshot.ts` (the only place that touches the model) into a plain
structure the step can consume:

| Path | Use |
| --- | --- |
| `heat.heaters[h].model.heatingRate` | °C/s at full PWM |
| `heat.heaters[h].model.deadTime` | seconds before temperature responds at all |
| `heat.heaters[h].model.coolingRate`, `.coolingExp` | loss to ambient — what makes the last 20 °C slow |
| `heat.heaters[h].model.maxPwm`, `.standardVoltage` | derating |
| `tools[n].heaters[]` | tool → heater mapping |
| `tools[n].active[]`, `tools[n].standby[]` | the temperatures to move between |

### The estimate

Pure, in `src/model/preheat.ts`:

```ts
export function heatUpSeconds(input: {
	from: number;  // °C, the standby temperature
	to: number;    // °C, the active temperature
	model: { heatingRate: number; deadTime: number; coolingRate: number; coolingExp: number };
	ambient: number;
	/** Multiplier applied to the result. Default 1.15. */
	safetyFactor?: number;
}): number;
```

`ΔT / heatingRate` alone **under-estimates badly**, because the cooling loss grows as the target is
approached and the last stretch is much slower than the first. Integrate the first-order model
numerically — a fixed 0.1 s step is ample and avoids any closed-form algebra that a change to
`coolingExp` would invalidate. Add `deadTime`, then the safety factor.

Guard rails, all of which need tests:
- `to <= from` → 0 seconds, nothing to do.
- A target at or above the model's achievable steady state → the integration never converges. Cap the
  iterations, return the cap, and have the caller warn that the tool may not reach temperature at all.
  That is a genuinely useful thing to tell someone.
- Missing or zero `heatingRate` (an untuned heater) → return `null` and warn. **Do not guess a rate.**

### The transformation

1. **Analysis pass** (task 05) collects every tool-change event: line number, tool number, cumulative
   seconds from the time model.
2. For each change to `Tn`, compute the heat-up time and find the point that far back on the time
   axis.
3. Insert `M568 P<n> A2` there.
4. Optionally (config, default on) return the tool being *left* to standby with `M568 P<m> A1`, so it
   is not cooking filament for the rest of the print.

### Edge cases — decide them, do not discover them

- **Not enough print before the first change.** Clamp to the start of the file, warn naming the tool
  and how much lead was actually available.
- **Two changes closer together than the heat-up time.** The second pre-heat lands before the first
  change. That is correct; make sure the emitted commands do not contradict each other, and never
  emit a standby command for a tool that has a pending pre-heat.
- **The file already pre-heats.** Some profiles emit `M568`/`G10` themselves. Detect an existing
  active-temperature command for that tool within the lead window and skip rather than double up.
- **No standby temperature**, or standby above active → nothing to do for that tool; report it once,
  not per change.
- **A tool with no heater** (a laser, a pen) → skip silently.
- **Only one tool used** in the whole file → the step does nothing and says so, rather than appearing
  to have worked.

### Report it

The run report should say what happened in a form that can be judged: *"Pre-heated T1 12 times,
average lead 94 s, longest 210 s; 1 clamped at layer 3."* A step that silently inserts 12 commands is
indistinguishable from one that silently inserts none.

---

## Tests

`src/__tests__/preheat.test.ts` — the estimator, entirely pure:

- a known model and a known ΔT produce a hand-checkable time (state the arithmetic in the test);
- the result exceeds the naive `ΔT / heatingRate` — this is the whole point of the model;
- `to <= from` is 0; an unreachable target hits the cap and reports it; a zero heating rate is `null`;
- the safety factor scales the result and defaults to 1.15;
- `deadTime` is added, not multiplied.

Step-level, using the analysis-pass harness from task 05:

- a two-tool fixture gets one `M568 P<n> A2` per change, each ahead of its change;
- the lead time matches the estimate within the granularity of the time axis;
- a change too early in the file clamps and warns;
- a file with one tool produces no insertions and a clear message;
- a file that already pre-heats produces no duplicates.

You will need a **two-tool fixture** — `test/fixtures/` has none. Add one in the style of the
existing three, small enough to read in a diff, with at least three tool changes and a standby
temperature configured.

---

## Acceptance

- Step 1's verification is recorded in the module comment with a link to the source consulted.
- On the two-tool fixture, each tool change is preceded by a pre-heat at a defensible lead.
- Every edge case above behaves as specified rather than throwing.
- All three gates pass. Existing golden files must not change; the new fixture adds its own.

## Out of scope

- Any change to how a tool change itself is performed. This step only heats; it never moves,
  selects, or purges.
- Chamber and bed pre-heating. Same idea, different enough to be its own task.
- Adjusting `M116` waits, or removing the slicer's own wait commands. Leaving a redundant wait after
  a successful pre-heat costs nothing; removing one that was load-bearing costs a print.
