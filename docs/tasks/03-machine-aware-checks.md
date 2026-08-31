# Task 03 — machine-aware checks and the Marlin temperature gap

Self-contained. **Read [README.md](README.md) and [CLAUDE.md](../../CLAUDE.md) first.**

Four independent items. They share a theme — catching a file that will fail on *this* machine — but
nothing beyond that, so they can be done and committed separately.

Design background: [feature-ideas.md](../feature-ideas.md) §3 and §8.

---

## 3a. Validate `M98` macro references *(the most valuable, and the smallest)*

### The gap

A file calls `M98 P"0:/macros/timelapse.g"`. If that macro is not on the card, RepRapFirmware stops
at that line — possibly forty minutes into the print. Nothing checks it, and this plugin's own
"Insert G-code" step actively encourages adding such calls.

### The seam problem, and how to solve it

Every existing check in [checks.ts](../../src/model/checks.ts) is **pure**: `runChecks(analysis,
machine)` takes a snapshot and returns results. Verifying a macro exists needs a file listing, which
is asynchronous and belongs to `src/dwc/`. Do not make `runChecks` async and do not import a gateway
into `model/checks.ts` — that would drag DWC into the pure layer for one check.

Split it instead:

1. **Analysis collects the references.** Add to `FileAnalysis`:
   ```ts
   /** Macro paths referenced by M98 P"...", de-duplicated, in first-seen order. */
   macroRefs: Array<{ path: string; count: number; firstLine: number }>;
   ```
   Collect in `Analyser.applyM`. Strip the surrounding quotes and RRF's `""` escaping — reuse
   `parseParams`, do not write a regex. Ignore an `M98` whose `P` is an expression (`{...}`): it
   cannot be resolved statically, and guessing is worse than skipping.

2. **A separate resolver in the impure layer.** New `src/dwc/macroCheck.ts`:
   ```ts
   export async function checkMacros(
       gateway: FileGateway,
       refs: FileAnalysis["macroRefs"],
   ): Promise<Array<CheckResult>>;
   ```
   One `sizeOf` per distinct path. Produce an `error`-level result naming the path and the line for
   each one that is missing. **A failed lookup is not a missing file** — if the listing itself throws,
   return nothing rather than claiming the macro is absent.

3. `FileInspector.vue` runs it after the analysis and concatenates the results.

Relative paths (`M98 P"macros/foo.g"`) resolve against `0:/` in RRF. Handle that, and note it in the
detail text so a user with a genuinely relative path understands what was checked.

**Tests:** the collection in `analysis.test.ts` (quoted, escaped, expression, relative, duplicate);
`checkMacros` against the existing `FakeGateway` in `src/__tests__/transfer.test.ts` — present,
missing, and a gateway that throws.

---

## 3b. Cold-extrusion detection

### The gap

Extrusion commanded before anything has waited for the hot end to reach temperature. It jams the
nozzle, and it is easy to introduce by hand-assembling a file or by an over-enthusiastic
find-and-replace on the start block.

### What to add

`Analyser` already tracks enough to spot it. Add to `FileAnalysis`:

```ts
/** Line number of the first extruding move, or null. */
firstExtrusionLine: number | null;
/** Line number of the first command that waits for a hot end (M109 or M116), or null. */
firstHeatWaitLine: number | null;
```

An extruding move is `G0`/`G1` with a positive `E` in absolute mode, or any non-zero `E` in relative
mode — the state machine already knows which mode is in force. A retraction (negative E) is not
extrusion and must not trip this.

New check: `error` when `firstExtrusionLine` precedes `firstHeatWaitLine`, or when there is extrusion
and no wait at all. Word the detail so it is actionable and does not cry wolf: many perfectly good
files heat via a macro the plugin cannot see into, so say that in the message and keep it at `error`
only when there is no heating command of any kind — otherwise `warning`.

**Tests:** extrusion before `M109` fires; after does not; a retraction before heating does not; a
file with no extrusion at all produces nothing.

---

## 3c. End-of-file hygiene

Three `info`-level checks over what the file does after the last extrusion:

- heaters left on (no `M104 S0`/`M140 S0`/`M568` to standby, and no `M0`/`M2`);
- part fan left running (no trailing `M107` or `M106 S0`);
- motors left energised (no `M18`/`M84`).

Each is a one-line observation with a one-line detail. Keep them `info`: plenty of setups deliberately
leave the bed warm or handle shutdown in an end macro, and a warning that is usually wrong gets
ignored along with the ones that are not.

**Tests:** one per condition, plus a clean file producing none.

---

## 3d. Marlin tool-scoped temperatures — a real gap in the current preset

### The defect

In Marlin, `M104 S200 T1` sets **tool 1's** temperature. In RepRapFirmware `M104`'s `T` parameter
does not mean that, so the command silently heats the wrong thing. The correct translation is
`M568 P1 S200`.

The bundled "Marlin to RepRapFirmware" preset in [presets.ts](../../src/model/presets.ts) does not
handle it, so the preset currently produces a file that looks converted and is not.

### Why it needs a small feature first

`commandMap` maps *every* occurrence of a command. Here the mapping must apply **only when `T` is
present** — a bare `M104 S200` targets the current tool and is correct as it stands in both
firmwares, so rewriting it to `M568` without a `P` would be wrong.

Add an optional condition to `commandMap`'s config:

```ts
/** Only map lines that have this parameter. Empty means map every occurrence. */
onlyWithParam: string;
```

One field in the schema, one guard in `mapCommand`. Then add two steps to the Marlin preset:
`M104 S… T…` → `M568 P… S…` (rename `T`→`P`, `onlyWithParam: "T"`), and the same for `M109` — noting
in the step's `note` that `M109`'s wait semantics are not preserved by the rename and the user should
check whether they need `M116`.

**Tests:** `onlyWithParam` set and the parameter absent leaves the line untouched; present maps it;
empty behaves as today (regression). The golden files for `marlinToRrf` **will** change — that is the
point; read the diff and confirm every changed line is a `M104`/`M109` that carried a `T`.

---

## Acceptance

- A file calling a macro that is not on the card produces an error naming the path and the line.
- A file that extrudes before heating produces an error; one that heats first produces nothing.
- The Marlin preset converts `M104 S200 T1` to `M568 P1 S200` and leaves `M104 S200` alone.
- All three gates pass; the only golden-file changes are `marlinToRrf.*`.

## Out of scope

- The volumetric flow-rate audit and feedrate clamping. Same family, but both need the move-time
  model from task 04 to say anything useful about time.
- Making `runChecks` asynchronous. The split above exists precisely to avoid that.
