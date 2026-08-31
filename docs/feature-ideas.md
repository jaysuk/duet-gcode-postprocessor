# Feature ideas

Candidates beyond the v0.1.0 feature set in [FEATURES.md](../FEATURES.md), weighted towards the
things **only a post-processor running on the printer can do** — because that, not find-and-replace,
is what makes this worth using instead of re-slicing.

Two of these came from Jay and are specified in full; the rest are sketches.

---

## 0. The enabler: a move-time model

Not a feature anyone asks for, but three of the ideas below need it and one is valuable on its own,
so it should be built first.

**What it is.** A pass that estimates how long each move takes, using **this machine's** limits from
the object model — `move.axes[].speed`/`acceleration` (M203/M201), `move.axes[].jerk` (M566) and
`move.printingAcceleration`/`travelAcceleration` (M204) — rather than the slicer's profile for
whatever printer it thought it was targeting. Trapezoidal per move: accelerate, cruise, decelerate,
clamped by the axis limits and by jerk at direction changes.

It will not be exact. It does not need to be: it needs to be *better than the slicer's estimate for
this machine*, and to give a monotonic time axis to hang things on.

**Free shortcut worth exploiting:** PrusaSlicer, SuperSlicer, Orca and Bambu already emit
`M73 P<percent> R<minutes remaining>` throughout the file. When those markers are present, a time
axis exists for free and only needs interpolating between them. Use them when they are there, fall
back to the computed model when they are not, and say which was used.

**Standalone value:** rewrite the `M73` markers with the machine-corrected estimate, so DWC's
progress bar and remaining-time are right. "Fix the wildly wrong time estimate on my printer" is a
feature people would install this plugin for on its own.

**Architectural consequence — this matters.** Everything below that needs lookahead (pre-heat, fan
regions with exit restore, anything anchored to "N seconds before X") cannot be done in the current
single forward pass. The fix is cheap because the whole file is already downloaded as a Blob:
`processFile` gains an optional **analysis pass** over the same Blob before the transform pass.
No second download, no buffering, and the pass is the same chunked reader. Design it once, properly:
`AnalysisPass` collecting events (tool changes, feature regions, cumulative time, layer boundaries)
into a compact array that the transform pass then consumes by index.

---

## 1. Predictive pre-heat before a tool change *(Jay)*

**The problem.** On a toolchanger, an inactive tool sits at its standby temperature. When it is
selected, the print waits for it to reach the active temperature — or worse, does not wait, and the
first extrusion after the change is cold. Slicers handle this crudely or not at all, because they do
not know how fast *your* hot end heats.

**Why this can only be done here.** The machine has already measured it. `M307` tuning results live
in the object model at `heat.heaters[h].model`:

| Field | Meaning |
| --- | --- |
| `heatingRate` | °C/s at full PWM |
| `deadTime` | seconds before the temperature responds at all |
| `coolingRate`, `coolingExp` | loss to ambient, which is what makes the last 20 °C slow |
| `fanCoolingRate` | additional loss with the part fan running |
| `maxPwm`, `standardVoltage` | derating |

Plus `tools[n].active[]` and `tools[n].standby[]` for the temperatures, and `tools[n].heaters[]` for
the tool → heater mapping.

**The estimate.** RRF's model is first-order with a dead time: temperature rises at `heatingRate`
minus a loss term that grows as the target is approached, which is why a naive `ΔT / heatingRate`
under-estimates badly near the top. Use RRF's own form, and **verify the exact normalisation of
`coolingRate`/`coolingExp` against `Duet3D/wiki-content` and the RRF source before implementing** —
the parameters are documented in units that are easy to get wrong (per °C above ambient vs per
100 °C above ambient). Add a user-facing safety margin (default ~15%) and a floor of `deadTime`.

**The transformation.**

1. Analysis pass: collect every tool-change event with its cumulative time.
2. For each change to `Tn`, compute the heat-up time from that tool's standby to its active
   temperature.
3. Walk back that many seconds along the time axis and insert `M568 P<n> A2` — set tool *n* to its
   active temperature **without selecting it**. *(Verify `A2` against the wiki: `M568` superseded
   `G10` for this in RRF 3.3, and the A parameter selects off/standby/active.)*
4. Optionally insert the complement: return the tool just deselected to standby, so it is not
   cooking filament while idle.

**Edge cases that need deciding, not discovering:**

- The first tool change happens before enough print time exists to pre-heat within — clamp to the
  start of the file and warn rather than inserting at a negative time.
- Two tool changes closer together than the heat-up time — the second pre-heat lands before the
  first change; that is correct, but the emitted commands must not fight each other.
- The file already contains its own pre-heat (some slicer profiles do) — detect and either skip or
  replace, never double up.
- No standby temperature configured, or standby above active — nothing to do; say so.
- Tool with no heater (a laser, a pen) — skip silently.

**Report it.** "Pre-heated T1 12 times, average lead 94 s, longest 210 s" is the output that tells
the user it worked. If a lead had to be clamped, name the layer.

---

## 2. Fan-speed audit and per-feature override *(Jay)*

**Part one — the audit.** List every distinct fan speed in the file: `M106` index (`P`), speed (`S`),
how many times each appears, and **which feature type it occurs under**. That alone answers "why is
this print's bridging bad" faster than reading G-code.

**Part two — the override.** Set fan speed per feature: bridges at 100%, external perimeters at 60%,
overhangs at 100%, first layer off, and so on.

**The real work is feature-name normalisation.** Every slicer names them differently:

| Canonical | PrusaSlicer / Orca | Cura |
| --- | --- | --- |
| External perimeter | `External perimeter` | `WALL-OUTER` |
| Internal perimeter | `Perimeter` | `WALL-INNER` |
| Bridge | `Bridge infill` | `BRIDGE` |
| Overhang | `Overhang perimeter` | — |
| Solid infill | `Solid infill`, `Top solid infill` | `SKIN` |
| Sparse infill | `Internal infill` | `FILL` |
| Support | `Support material` | `SUPPORT` |

So: a pure, tested `model/gcode/features.ts` mapping slicer-specific `;TYPE:` values onto a canonical
set, with an "unknown" bucket that the UI surfaces rather than silently dropping. The state machine
already tracks `featureType`; this normalises it.

**The design trap.** The slicer re-emits `M106` constantly, including inside the region you are
overriding. Setting the fan on entry is not enough — the slicer's next `M106` undoes it. The step
must **suppress the slicer's own `M106` inside an overridden region** and restore the previous speed
on exit. That is what makes this a real transformation rather than a one-line insert, and it is why
it wants the analysis pass: knowing where a region *ends* is lookahead.

**Extras that fall out of the same machinery:** scale every fan speed by a factor (for a different
blower), clamp minimum non-zero speed (fans that stall below ~20%), and a spin-up kick (brief 100%
before settling to a low speed, for fans that will not start from stopped).

---

## 3. Machine-aware checks and rewrites

**Validate `M98` macro references.** The file calls `M98 P"0:/macros/timelapse.g"` — does that file
exist on this card? A one-line `getFileList` check catches a typo that would otherwise stop the print
at layer 40. Especially pointed because this plugin's own insert steps add macro calls.

**Volumetric flow-rate audit.** Compute mm³/s per move from the E distance, filament diameter and
move length, and flag where the file exceeds what the hot end can actually melt. Catches "sliced for
a Volcano, printing on a V6" before it under-extrudes for four hours. Optionally clamp by scaling F
on the offending moves.

**Feedrate and acceleration clamping.** A file sliced for another machine commands 300 mm/s on a
printer whose `move.axes[].speed` tops out at 120. RRF clamps silently, so the print takes longer
than estimated and nobody knows why. Rewrite the F values to the machine's real ceiling and report
how much time that actually adds.

**Cold-extrusion detection.** Extrusion commanded before the hot end has been told to reach
temperature, or before an `M109`-style wait. A classic cause of a jam on a file assembled by hand or
by another post-processor.

**End-of-file hygiene.** Heaters left on, part fan left running, motors not disabled, no `M400`
before a final move. Cheap checks, occasionally save a night.

---

## 4. Print recovery and surgery

**Restart from layer N.** After a failure at layer 300, generate a file that heats up, homes, moves
to the right Z and continues from that layer. Genuinely hard to do by hand, frequently needed, and
the plugin already has everything required — layer indexing, state tracking, and knowledge of the
machine. The care is in reconstructing state at the cut point: temperatures, fan, tool, extrusion
mode, absolute E position, and whether to re-home Z against a part already on the bed.

**Extract a layer range.** Pull layers 40–60 into a small standalone file, with the start block
preserved and a synthesised approach. The fastest way to debug one bad region without re-slicing a
six-hour print.

**Split at a layer.** For multi-day prints, or to stop at a known filament budget.

---

## 5. Analysis worth having

**Per-feature statistics** — time and filament by feature, by tool, by object. "38% of this print is
sparse infill" changes how people slice the next one.

**Layer-time analysis** — flag layers so short the plastic cannot cool, and offer to enforce a
minimum layer time after the fact (slow down, or insert a dwell away from the part).

**Retraction totals** — count and total distance, per tool. A proxy for oozing and for wear.

**Compare two files** — diff two slices of the same model to see what a profile change actually did
to the G-code. Already on the list as "Later"; it is more useful than its position suggests.

**Simulation round-trip.** After applying, run RRF's own `M37` simulation and report the firmware's
real time estimate — then optionally write it back into the file's `M73` markers. A closed loop no
slicer can offer: the machine that will run the file tells you how long it will take.

---

## 6. Object and workflow

**`M486` object labelling.** Convert slicer object markers into `M486` so DWC's cancel-object works,
including Klipper's `EXCLUDE_OBJECT_DEFINE`/`_START`/`_END` for files that came from that ecosystem.
Turns a feature the firmware already has on for files that would not otherwise support it.

**Metadata placeholders.** Extend the existing `{layer}`/`{z}` placeholders to slicer metadata, so
inserted G-code can say `M117 {meta.layer_height} mm` or drive a value from the profile.

**Conditional steps.** Run a step only when a condition on the file holds — slicer is Cura, layer
height below 0.15, more than one tool used. Keeps one recipe useful across a mixed library.

**Apply and start.** After a successful apply, offer to start the resulting file as the print job.

---

## Suggested order

1. **The time model + `M73` rewrite** (§0) — standalone value, and the prerequisite for the rest.
2. **The analysis pass** in `processFile` — the architectural change that unlocks lookahead.
3. **Fan audit and per-feature override** (§2) — self-contained once feature normalisation exists,
   and immediately useful.
4. **Pre-heat before tool change** (§1) — the most distinctive feature on this list.
5. **`M98` validation and the flow-rate audit** (§3) — cheap, and they prevent failed prints.
6. **Restart from layer N** (§4) — highest effort, highest gratitude.

---

## 7. Prompted by G-Code Modifier

[github.com/little-did-I-know/Gcode](https://github.com/little-did-I-know/Gcode) is a browser-based
G-code visualiser, analyser and modifier (MIT, © 2026 little-did-I-know). **Ideas only — no code has
been taken; see [attribution.md](attribution.md).** The two projects are shaped very differently:
theirs is a standalone visual editor you upload a file into, ours is a headless transformation
pipeline sitting on the printer. That difference decides what is worth borrowing and what is not.

### Worth taking

**Hole detection with automatic pauses, and insert-depth calculation.** The standout idea, and
squarely a post-processing feature rather than a visualisation one: scan the layers for holes that
get roofed over later, work out the layer at which each becomes enclosed, and offer to insert a
pause there — so a heat-set insert, nut or magnet can be dropped in and buried.

Doing it by hand means scrubbing a preview and counting layers. Doing it here means the plugin
already knows the geometry and can write the pause itself.

The full version needs per-layer geometry: extract extrusion paths, find closed loops, detect an
enclosed void, then find the layer where solid infill first covers it. A worthwhile MVP is much
smaller — find XY regions that are empty on layer *n* and extruded on layer *n+1*, cluster them, and
report each as "a void closing at layer *n+1*, Z = …, roughly *w* × *d* mm". That alone gets someone
to the right layer number. It also gives the insert depth for free: the void's own height in
millimetres.

Present it as a **list of candidates with a checkbox each**, not an automatic rewrite. The user
knows which hole is for an insert and which is a lightening pocket; the plugin does not.

**A recovery / resume-from-layer generator.** Already on our list at §4; worth noting that they
built it too, which is decent evidence the demand is real rather than assumed.

**Eject sequences.** An end-of-print part-ejection routine, as a preset. Niche, but print farms want
it and it costs a preset rather than a feature.

**Per-layer Z-offset adjustment.** Nudging Z at a chosen layer — first-layer squish after the fact,
or a correction partway up a long print. Our `paramRewrite` step can already offset Z over a layer
range; what is missing is the *preset* and a sensible UI for it, not the machinery.

**A G-code reference with click-to-insert.** Their reference covers 40+ commands with
firmware-specific notes. The transferable part is the interaction: when someone is typing into an
"insert G-code" or rules field, a searchable palette that inserts the right RepRapFirmware command —
with its parameters — is a real improvement over alt-tabbing to the Duet documentation. Note DWC
already ships Monaco with G-code language support and a "search G-code" action, so the cheapest
route may be upstream (see the Monaco ask in `scripting-engines.md`) rather than building our own.

**Thermal analysis feeding a decision, not a picture.** Their thermal simulation drives a heatmap.
The same underlying idea is more useful to us as an *action*: identify layers that print too fast to
cool, and offer to enforce a minimum layer time (slow the layer, or dwell away from the part). That
is §5's layer-time analysis with a physical basis rather than a stopwatch.

**Motion-kinematics analysis** — independent confirmation that the move-time model in §0 is the
right foundation, and that an accel-aware estimate is worth the effort over a naive
distance-over-feedrate sum.

### Deliberately not taking

**The WebGL viewer, the 12 heatmap overlays, and in-viewport editing.** DWC already has a G-code
viewer plugin. Building a second, worse 3D engine inside a post-processor would be scope creep of
the least defensible kind. If a visual layer is wanted, the right move is to *integrate* — jump the
existing viewer to a layer this plugin is talking about — not to rebuild it.

**Warp prediction with material-aware failure modelling.** Genuinely ambitious, and well outside
what we can validate. A modest version fits our checks, though: flag the geometric conditions that
correlate with lifting — a large flat first layer, tall thin towers, sharp corners on a
high-shrinkage material named in the slicer metadata — as an information-level preflight note, with
no pretence of prediction.

---

## 8. Further ideas

**Pressure advance per filament, from the file's own metadata.** The slicer already records
`; filament_type = PETG` and often the filament name. Keyed on that, inject the right `M572` for
that material automatically. One recipe then does the right thing across a mixed library, and it
generalises: any per-material parameter — retraction, temperature offsets, fan limits — can come
from a small table keyed on metadata.

**Marlin tool-scoped temperatures.** `M104 S200 T1` sets tool 1's temperature in Marlin; in
RepRapFirmware the T parameter means something different, and the correct translation is
`M568 P1 S200`. Our Marlin-to-RRF preset does not currently handle it, and it is exactly the kind of
silent mistranslation that heats the wrong hot end.

**Tool renumbering.** Remap `T0`→`T2` and friends for a file sliced against a different tool
assignment. Trivial to implement, regularly needed on a toolchanger, and currently a find-and-replace
that catches `T0` inside comments and `M568 P0`.

**Z-hop injection.** Add a hop to travels longer than a threshold, for a file sliced without it that
is knocking over a part.

**Ooze control on long travels.** Insert a small retraction and/or a brief temperature drop before
travels above a length threshold.

**Bed-temperature ramp.** Drop the bed by a few degrees after the first *n* layers — common practice
for reducing elephant foot, and for not heating a bed at 100 °C for nine hours unnecessarily.

**Confirmation gates.** Insert `M291` prompts at chosen points ("bed clear?", "insert magnets now")
for print-farm and multi-stage workflows.

**Timelapse trigger on the top layer of each object only.** With `M486` object tracking, avoid
firing the trigger once per object per layer on a plate of twenty parts.

**A plain-English summary of the file.** One paragraph generated from the analysis — what it prints,
how long, how much filament, which tools, anything unusual. Cheap to produce once the analysis
exists, and it is the thing someone actually wants when they open a file they did not slice.
