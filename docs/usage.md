# Using the G-code Post-Processor

Post-process G-code that is already on the Duet's SD card: browse, inspect, apply an ordered recipe
of transformations, preview exactly what would change, then write it back.

Everything runs in your browser. The Duet is only a file store for this — nothing is installed on
the board beyond the plugin itself, and it works the same on a standalone Duet and on a Duet 3 with
an SBC.

---

## The short version

1. Open **Plugins → Post-Processor**.
2. Pick a file in the browser on the left.
3. On the **Recipe** tab, pick or build a recipe.
4. Press **Preview**. Read the diff.
5. Press **Apply**.

Preview never writes anything. Apply always asks first, always takes a backup when it overwrites,
and refuses outright to touch the file the printer is currently reading.

---

## Recipes and steps

A **recipe** is an ordered list of **steps**. Each step transforms every line of the file in turn,
and each step sees the output of the one before it. Steps can be reordered, disabled without being
deleted, and annotated with a note so a six-step recipe is still readable in a year.

Recipes are stored on the board, so they follow the printer rather than the browser — open DWC from
a phone and they are there. (On an older DWC without the plugin-settings API they fall back to
browser storage; the "Export as JSON" action is the way to move them either way.)

### Conditions — only run a step for certain files

Every step has an optional **"Only run if..."** field — a JSON array of conditions, checked once
against the file's own slicer metadata before the recipe runs at all. A step whose condition is not
met is skipped entirely for that file: it never sees a line, and the run report says so ("skipped:
condition not met") rather than leaving you to wonder why nothing changed.

```json
[{ "key": "filament_type", "op": "eq", "value": "PETG" }]
```

- **`key`** — a slicer metadata field. A handful of well-known ones (`slicer`, `slicerVersion`,
  `totalLayers`, `layerHeight`, `filamentMm`, `filamentDiameterMm`, `printTimeSeconds`) are typed;
  anything else is looked up in the file's own settings block the same way the inspector's "Slicer
  settings found" panel shows it (so `filament_type`, `nozzle_diameter`, `first_layer_temperature`,
  whatever your slicer states, all work) — matched leniently, the same way the raw key is: lower-cased,
  spaces to underscores.
- **`op`** — `eq`, `neq`, `contains`, `gt`, `lt`, `gte`, `lte`, `exists`, `notExists`.
- **`value`** — compared case-insensitively for text. Omit for `exists`/`notExists`.

Multiple conditions in the array all have to hold (AND). This is deliberately metadata-only, not
aware of the fuller per-file analysis (layer count, tools used, and so on beyond what the slicer
itself states) — metadata is already read before a single line of the file is processed, so a
condition costs nothing extra to check, and in practice `totalLayers`/`layerHeight` already cover the
common "how big is this file" questions whenever the slicer states them.

**This is also how to do metadata-driven parameters** — different pressure advance, retraction or
temperature per filament, without a dedicated step: add the same step (say, "Rewrite a parameter") to
the recipe once per filament, each with its own condition —

```json
// Step 1: condition [{"key":"filament_type","op":"eq","value":"PETG"}], scale F by 0.9
// Step 2: condition [{"key":"filament_type","op":"eq","value":"PLA"}], scale F by 1.0
```

— and only the one whose filament matches actually runs.

### Find and replace

The workhorse, and deliberately compatible with PrusaSlicer's **G-code Substitutions**: the same
literal/regex, case-sensitive and whole-word switches, so a rule you already use ports across
unchanged.

| Option | What it does |
| --- | --- |
| Find | Text to look for. Literal unless "Regular expression" is on. |
| Replace with | Replacement. In regex mode `$1`, `$2` insert capture groups; empty deletes the match. |
| Regular expression | Treat Find as a JavaScript (ECMAScript) regex. |
| Case sensitive | Default on — G-code is conventionally upper case. |
| Whole word only | Requires a word boundary, so `M10` does not match inside `M104`. |
| Replace every occurrence | Off replaces only the first match on each line. |
| From / To layer | Restrict to a layer range. `-1` means unbounded. |

**One difference from PrusaSlicer:** it applies substitutions to a whole layer block, so a regex
there can span lines. This applies them per line. Everything single-line behaves identically; a
multi-line pattern will not match.

### Map a command

Rewrites one command as another and moves its parameters properly. This is the step to use when a
plain find and replace would produce something that *looks* right and does not run:

`M900 K0.05` → find/replace gives `M572 K0.05`, which RepRapFirmware rejects. Mapping gives
`M572 S0.05 D0`, which is what was meant.

| Option | Example |
| --- | --- |
| Replace command | `M900` |
| With command | `M572` |
| Rename parameters | `K=S` (comma-separate several: `K=S, T=P`) |
| Add parameters | `D0` |
| Drop parameters | `T` |
| Only when this parameter is present | `T` — lines without it are left completely alone |
| Keep the original as a comment | Appends `; was: M900 K0.05` so the change is auditable in the file |

"Only when this parameter is present" matters for commands whose meaning changes depending on
whether a parameter is there at all. In Marlin, `M104 S200 T1` sets *tool 1's* temperature, but a
bare `M104 S200` means the current tool — the same as in RepRapFirmware. Mapping every `M104`
unconditionally would give a bare one a `P` parameter it never needed; setting this to `T` maps
only the tool-scoped form (to `M568 P1 S200`) and leaves the rest untouched.

### Insert G-code

Puts lines somewhere. The anchor decides where:

- **Start / end of file**
- **At the first layer change** — after the slicer's start block, before anything is printed
- **At a specific layer**, **at every layer change** (with an interval and a starting layer)
- **At a Z height** (with a tolerance), fired once
- **At a tool change**, optionally only for one tool
- **At the start of each object** (`M486`)
- **At a percentage through the file** — by size, not by time
- **Wherever a pattern matches**, optionally only the first time

Inserted text may use `{layer}`, `{z}`, `{tool}`, `{line}`, `{file}`, `{feedrate}`, `{object}` and
`{meta.<key>}` — a value from the file's own slicer metadata, e.g. `{meta.totalLayers}` for one of
the handful of fields this plugin already understands by name, or `{meta.layer_height}` for anything
else, read straight from the file's own `key = value` block with spaces collapsed to underscores
(exactly how the "Slicer settings found" panel in the inspector lists it — copy the key from there).
A `{meta.*}` whose key the file does not state is left in the output exactly as written, not silently
dropped, so a mistyped or absent key is visible in the diff rather than producing a command missing
a value it needed.

### Delete or disable lines

Matches lines and either comments them out (the default — reversible, and obvious in a diff) or
deletes them.

### Extract a layer range

Keeps only a range of layers, discarding everything else — including the original start block
(homing, bed levelling, initial temperatures), which sits before layer 0 and is not part of any
layer range. A generated comment explains what the file is and that it is not runnable
start-to-finish: prepare the machine manually before running it, or use "Restart from layer" instead
if you want a file that reconstructs machine state for you.

Splitting a file at a layer is just two extractions with adjoining ranges — layers 0–N in one recipe
run, N+1 onward in another.

- **From layer / To layer** — -1 means unbounded on that side. Default: the whole file.

Warns rather than crashing if the range matches nothing, and warns (but still extracts) if the file
has no layer-change markers of its own — layer numbers are then inferred from Z rises and may not
exactly match what the slicer would call each layer.

### Restart from layer

Rebuilds a runnable file starting at a chosen layer, for recovering from a failure — a jam, a power
cut, a knocked part that recovered — without reprinting from scratch. Reconstructs machine state at
that layer from everything before it in the file: the active tool, bed and tool temperatures, fan
speed, extrusion and move mode, and the absolute extrusion position. Then lifts clear of the part,
travels in XY, and only then descends to the resumed layer's own height — never travelling across
the part at its own Z.

- **Resume from layer** — 0 is the first layer. Everything before it, including the original start
  block, is replaced by the generated preamble.
- **Re-home Z (G28 Z)** — off by default, and this matters: a machine that homes Z by probing would
  probe the part already on the bed, not the bed itself, and set Z wrong by the part's own height.
  Only turn this on if this machine's Z axis homes to a fixed endstop.
- **Lift height**, **lift/travel/descend feedrates** — control the final reposition. The descend
  feedrate defaults slower than the others, since that move ends at the part.

This does **not** attempt any first-layer adhesion trickery (no re-purge, no extra brim) — there is
no single right answer for a bed that already has a part on it, and the preamble restores state
accurately rather than guessing. If the resumed print needs help sticking, that is a physical
decision to make at the printer, not a setting here.

Needs this file to have layer markers or a usable geometric fallback, the same as any other
layer-anchored step. If the cut lands inside an `M486`-labelled object, the label is restored too, so
DWC's cancel-object UI does not attribute the rest of the print to the wrong object.

### Rewrite a parameter

Scale, offset, set or clamp a numeric parameter on chosen commands. Everything else about the line
— spacing, other parameters, the trailing comment — is preserved byte for byte, so the diff stays
readable. A parameter holding an expression (`F{var.speed}`) is left alone.

### Vary a value up the print (calibration tower)

Emits a command with a value that steps from one number to another as the print gets taller. This
turns a tower you already sliced into a pressure-advance, temperature, retraction or speed
calibration without going back to the slicer.

Give it a command containing `{value}` (for example `M572 D0 S{value}`), a range, and either a
number of bands or "every layer". Optionally it also emits a message per band so the finished part
can be read off against the values.

### Fan speed by feature

Overrides the part-cooling fan speed for chosen features — bridges, overhangs, external
perimeters, and so on — without the slicer's own fan commands undoing it two lines later. This is
more than a find-and-replace: while an override is in force, the slicer's own `M106`/`M107` lines
for that region are suppressed (commented out by default, or deleted), and the speed that was in
force before the override is restored explicitly once the region ends — either at the next feature
or at a layer change, whichever comes first.

List overrides one per line (or comma-separated) as `feature=speed`:

```
bridge=255
overhang=255
externalPerimeter=180
```

The recognised features are `externalPerimeter`, `internalPerimeter`, `overhang`, `bridge`,
`solidInfill`, `topSolidInfill`, `sparseInfill`, `support`, `skirtBrim`, `ironing` and `custom`.
Choose whether your speeds are **0–255** or **0–1** — check the Fan speeds table on the Inspect tab
to see which one this file already uses — and optionally set a first-layer speed, which takes
priority over any feature override on layer 0.

### Rewrite print time (M73)

A slicer's `M73 P<percent> R<minutes>` markers are computed for the machine it thinks it is
slicing for — on a Duet with different acceleration, jerk or speed limits, DWC's own progress bar
and remaining-time (which just reads those markers back) can be badly wrong. This step recomputes
every existing marker from this machine's own limits (`M201`/`M203`/`M204`/`M566`), so `P` reflects
percent complete **by time**, not by bytes, and `R` is the real minutes remaining.

It rewrites markers in place only — a file with no `M73` markers at all is left untouched (nothing
is inserted at a fixed cadence) and the run report notes that nothing was found. No fields to
configure: it reads the machine's limits automatically at apply time.

### Predictive pre-heat

On a toolchanger, an idle tool sits at its standby temperature and only starts heating to its active
temperature when it is selected — so either the print waits for it, or nothing waits and the first
extrusion comes out cold. This step estimates how long each tool's heaters actually take to make that
climb, using the machine's own tuned `M307` model (the same numbers `M303` auto-tuning measured), and
inserts `M568 P<n> A2` that far ahead of each tool change so the tool is already at temperature when
it is needed.

Reads two things it cannot get from the file itself:

- **Room temperature** — the object model has no live ambient reading, so this is a step setting
  (default 20°C). Get it roughly right; the estimate is not sensitive to being a few degrees off.
- **This machine's motion limits and tool/heater configuration** — read automatically from the
  connected machine at apply time, the same way the move-time model (above) does.

**Return the previous tool to standby** (on by default) also inserts `M568 P<m> A1` for the tool
being left, once its replacement is on its way, so it stops holding filament at printing temperature
for the rest of the job.

A tool with no heater (a laser, a pen) is skipped silently. A tool with no standby temperature set
below its active one, or whose heater has no tuned `M307` model, has nothing pre-heated for it and is
named in the run report instead. A change too close to the point where the tool's own temperatures
are first known — an `M568`/`G10` setting them, or otherwise the tool's own first selection — gets
its pre-heat clamped to that earliest legitimate point rather than to line 0, or dropped entirely
with a report line if even that leaves no real lead: activating a tool before anything has said what
temperature "active" even means would just apply whatever was left over from the previous job. If two
changes would both clamp to the exact same instant, only the one needed soonest gets a pre-heat; the
rest are dropped, also named in the report. A profile that already emits its own early `M568 A2` for
a tool is left alone rather than getting a second, redundant one. A file that only ever uses one tool
is left untouched entirely.

### Weld curves into arcs

A slicer approximates every curve with hundreds of short straight `G1` moves. RepRapFirmware executes
true arcs natively, so this step collapses a run of moves that trace a circle back into a single
`G2`/`G3` — typically removing 50–80% of the lines in a curved file and handing the motion planner a
smooth path instead of a polyline.

The algorithm is a clean-room reimplementation of the one in
[ArcWelderLib](https://github.com/FormerLurker/ArcWelderLib) (see `docs/attribution.md`), so its
settings use the same names and defaults as that tool:

- **Resolution** (default 0.05mm) — how far the fitted arc may deviate from the original path.
- **Path tolerance** (default 5%) — how much the arc's own length may differ from the straight-line
  path it replaces; this is what stops an arc that is geometrically plausible but goes the long way
  round a circle.
- **Maximum radius** (default 9999mm) — rejects a near-straight run rather than letting floating-point
  noise turn it into an enormous arc.
- **Minimum segments** (default 3) — fewest source moves worth replacing with one arc.
- **Allow 3D arcs** — off by default; turn on for vase-mode prints where Z climbs steadily through a
  curve (a helix), not just in the XY plane.
- **Extrusion rate variance** (default 5%) — aborts a run if the filament-per-mm-of-travel changes too
  much partway through, which would mean the line width was supposed to change and welding it into
  one arc would flatten that out.

A run breaks — ending whatever arc is in progress — on anything that is not a plain `G0`/`G1`, a
change between extruding/retracting/travelling, a layer or slicer feature-type boundary, a zero-length
move, or (unless allowed) a change in Z. A run shorter than the minimum segment count, or one whose
rounded coordinates cannot be made to satisfy the firmware's own arc-radius check at any reasonable
precision, is left as the original moves rather than dropped.

**Put this step last.** It changes both line counts and coordinates, so anything after it that
targets `G1` — a find/replace, a rule — will not see a welded arc, and anything that inserts lines
(pre-heat) needs to run before this step sees the file, not after. The same goes for "Extract a
layer range" and "Restart from layer" below — both reason about per-line coordinates and layer
boundaries that a welded arc would hide, so they need to run before this step too.

**Two caveats worth knowing before turning this on:**

- Most G-code *viewers* — including the slicer's own preview — render `G2`/`G3` badly or not at all.
  The print is unaffected; the preview will look wrong.
- Firmware that does not support arcs will either reject the file or silently skip the arc commands,
  printing nothing where the curve was. This is written for RepRapFirmware, which executes them
  natively.

### Clamp feedrate to machine limits

Rewrites a commanded `F` down to this machine's own speed limit for the axes actually involved, the
same model the inspector already uses to estimate print time — this step is what closes the gap
between "the inspector said clamping would add 14 minutes" and the file actually taking that long.
An X-only move is checked against X's own limit, not the tighter of X and Y; a Z-only move (a lift)
and an E-only move (a retraction or wipe) are checked against their own limits the same way; a move
already within limits is left byte-identical. `G92` is tracked correctly regardless of extrusion mode,
so an absolute-extrusion file's constant `G92 E0` does not hide real printing moves from it.

- **Apply to** — printing moves, travel moves, or both (default). A move counts as "printing" when
  it extrudes.
- **Also clamp M204 acceleration** — off by default. When on, an `M204 P`/`T` asking for more than
  this machine's own configured printing/travel acceleration is rewritten down to it.

Needs this machine's motion limits, the same as "Rewrite print time" and "Predictive pre-heat" —
without them the step does nothing and says so in the report.

### Enforce a minimum layer time

A layer that prints in a few seconds has not had time to cool before the next one lands on top of
it. This step measures each layer's clamped duration (the same model "Rewrite print time" and "Clamp
feedrate" use) and, on a layer that comes out shorter than the target, either slows it down or
inserts a pause.

- **Minimum layer time (s)** — a layer clamped shorter than this is remedied. Default: 10.
- **When a layer is too fast** — **Slow the layer** (default) scales every feedrate on that layer down
  by the same factor, so it takes the target time instead; **Dwell away from the part** instead parks
  at a chosen position and waits out the shortfall, so the nozzle is not left stationary and hot over
  the print.
- **Never slow below (mm/min)** — a floor on the slowed feedrate. A layer that cannot reach the target
  without going below it is slowed as far as the floor allows and reported, not forced further —
  oozing at a crawl is worse than a layer a few seconds too fast.
- **Park X / Park Y** — where to move to before dwelling, in dwell mode.

The scaling is an approximation, the same kind "Rewrite print time" is built on — real acceleration
does not scale perfectly linearly with the target, so a very short, sharply accelerated move may land
a little off target. It gets closer the longer the layer's moves are.

Needs this machine's motion limits — without them the step does nothing and says so in the report.

### Convert Klipper object markers to M486

Klipper's `EXCLUDE_OBJECT_DEFINE`/`EXCLUDE_OBJECT_START`/`EXCLUDE_OBJECT_END` do the same job as
RepRapFirmware's `M486`, but a file sliced for Klipper carries the former, and DWC's cancel-object UI
understands only the latter. This step converts one to the other: `EXCLUDE_OBJECT_START NAME=foo`
becomes `M486 S<n> A"foo"` (the same object name always gets the same index, even across a file's
several visits to it), `EXCLUDE_OBJECT_END` becomes `M486 S-1`, and `EXCLUDE_OBJECT_DEFINE` is
dropped — RRF's `M486` has no separate "declare an object" step, so nothing is lost, but nothing
converts to either.

Nothing to configure. A file that already uses `M486` is left completely untouched, with a warning —
converting anyway could assign a Klipper-derived index that collides with one the slicer already
used itself.

### Timelapse on each object's top layer

The "Timelapse trigger every layer" preset fires a macro at every layer change — simple, and enough
for a single-object print. On a plate of many objects that fires far more often than anyone wants
frames for. This step instead needs the file to already carry `M486` object labels (pair it with
"Convert Klipper object markers to M486" first if it does not have them), works out the highest layer
each object actually extrudes on, and calls the macro once per object, right after that object's own
last layer finishes — once, not once per object, when several objects happen to finish on the same
layer. A file with no object labels at all is left untouched, with a warning, rather than silently
falling back to firing on every layer.

- **Macro to call** — via `M98`. Default: `0:/macros/timelapse.g`.

### Renumber tools

Remaps tool numbers for a file sliced against a different tool assignment — trivial to want on a
toolchanger, and a plain find-and-replace on "T0" gets it wrong in two ways: it also rewrites T0
inside a comment or an `M117` message, and it does nothing sensible with `M568 P0`. This step operates
on parsed parameters instead, and rewrites the tool number wherever RepRapFirmware's own G-code
dictionary confirms one actually appears: bare `T<n>` command lines, and the `P` parameter of
`M563`/`M567`/`M568`/`M116`. It deliberately leaves `M106`/`M107`'s `P` alone (that is a **fan**
index) and `M585`'s `P` alone (a **Z probe** number) — both reuse the same letter for something else
entirely. It also leaves `G10` tool offsets alone: `G10`'s own `P` means a tool number in one form and
a workplace coordinate system number in another, and reliably telling them apart needs more than this
step attempts.

- **Mapping** — comma-separated `old->new` pairs, e.g. `0->2, 1->0`. Every pair is resolved against
  the file's *original* tool numbers at once, so `0->1, 1->0` is a genuine swap rather than every T0
  becoming T1 and then, on the very next rule, turning straight back into T0. A tool number not
  listed is left completely alone.

### Z-hop on long travels

Lifts the nozzle before a travel move longer than a threshold and lowers it again after, for a file
sliced without a hop that is knocking over a tall or fragile part. Skips a travel that already has an
explicit Z-rise on the line immediately before it (a slicer-emitted hop of its own), and skips the
rest of the file entirely once it sees `G10`/`G11` — RepRapFirmware's own firmware retraction, which
already performs whatever hop this machine's `M207` is configured with, invisible from the file's own
text and not this plugin's to second-guess. Both kinds of skip are counted and reported, so "nothing
changed" is distinguishable from "nothing needed to".

- **Travel length threshold (mm)** — only travels at least this long get a hop. Default: 5.
- **Hop height (mm)** — how far to lift, and lower again. Default: 0.4.

Run this **before** "Weld curves into arcs" in the recipe — arc-welding changes line counts and
coordinates outright, and this step needs to see the file's own original travel moves.

### Ooze control on long travels

The same travel-detection as "Z-hop", used to retract (and optionally cool) before a long travel
instead of lifting for one — for a file sliced without any protection that is stringing across long
travels. Skips a travel already preceded by a retraction on the line immediately before it, and skips
the rest of the file once it sees `G10`/`G11`, for the same reason "Z-hop" does.

- **Travel length threshold (mm)** — only travels at least this long get a retraction. Default: 5.
- **Retraction length (mm)** — pulled back before the travel, pushed back after. This is on top of
  anything the file already does elsewhere, not a replacement for it. Default: 0.4.
- **Also drop temperature** — off by default. When on, lowers the hot end for the duration of the
  travel and restores it afterwards — but only when the file has already commanded a temperature
  earlier to restore to; without one, it still retracts but leaves temperature alone rather than
  guessing at a value.
- **Temperature drop (°C)** — Default: 10.

Also run this **before** "Weld curves into arcs", for the same reason as "Z-hop".

### Rules — scripting without code

A declarative when/then list in JSON. It covers most of what post-processing scripts actually do,
and because it is data rather than code it is diffable, shareable and cannot do anything unexpected.

```json
[
  {
    "name": "Slow the first two layers by half",
    "when": [
      { "type": "command", "codes": ["G1"] },
      { "type": "layer", "to": 1 }
    ],
    "then": [
      { "type": "scaleParam", "letter": "F", "factor": 0.5, "decimals": 0 }
    ]
  }
]
```

**Conditions:** `matches` (pattern, regex, caseSensitive, negate) · `command` (codes) ·
`layer` (from, to) · `tool` · `z` (from, to) · `param` (letter, op: present/absent/gt/lt/eq, value) ·
`comment` · `object` (name) · `feature` (name, from the slicer's `;TYPE:` comment) · `expr`
(expression — a computed condition, true when the result is non-zero/`true`).

**Actions:** `replace` (pattern, replacement) · `replaceLine` (text) · `setParam` · `scaleParam` ·
`offsetParam` · `setParamExpr` (letter, expression, decimals) · `removeParam` · `insertBefore` ·
`insertAfter` · `appendComment` · `commentOut` · `drop`.

All conditions in a rule must hold. Rules are evaluated in order and all matching rules apply,
unless one sets `"stop": true`.

#### Computed values with `expr` and `setParamExpr`

For arithmetic a fixed factor or offset can't express — "slow proportionally to how many layers
are left", "scale F but never below a floor" — without dropping to the JavaScript step. Both use
the same safe expression evaluator (`+ - * / %`, comparisons, `&&`/`||`, parentheses, and functions
like `abs`/`min`/`max`/`round` — no loops, no function calls back into your own code, nothing that
touches the file or the network):

```json
[
  {
    "name": "Slow proportionally as the print nears the end",
    "when": [
      { "type": "command", "codes": ["G1"] },
      { "type": "expr", "expression": "layer > totalLayers * 0.8" }
    ],
    "then": [
      { "type": "setParamExpr", "letter": "F", "expression": "value * 0.9", "decimals": 0 }
    ]
  }
]
```

The expression sees, as plain flat names (never `meta.totalLayers` — there is no member access):
the current line's own parameters exactly as written (`F`, `X`, `Y`, `Z`, `E`, ...), `layer`, `tool`,
`z`, `feedrate`, the handful of slicer metadata fields already available elsewhere in this plugin
(`totalLayers`, `layerHeight`, `filamentMm`, `printTimeSeconds`) when the slicer states them, and —
in `setParamExpr` only — `value`, the parameter's own current numeric value on this line (so
`"value * 0.9"` means "90% of whatever F already is here", the same idea `scaleParam`'s `factor`
already expresses without needing an expression at all).

A malformed expression is rejected immediately when you save the recipe, with the parse error shown
inline — never a silent no-op discovered later. A variable the current line doesn't have (asking
for `F` on a line with no F, say) makes that one line fail gracefully: the `expr` condition is just
false for that line, and `setParamExpr` leaves that line unchanged — the same "can't act on this
line, so don't" behaviour `scaleParam`/`offsetParam` already have when their own target parameter is
missing.

### JavaScript

For everything the rules cannot express. Your code runs once per line:

```js
// Slow every extruding move on the first two layers
if (ctx.layer <= 1 && gcode.isExtrusion(line, ctx.relativeE)) {
	return gcode.scale(line, "F", 0.5, 0);
}
return line;
```

Return a string to replace the line, `null` to drop it, or nothing to leave it alone.

**Available to a script:**

| Name | What it is |
| --- | --- |
| `line` | The current line, as the previous step left it |
| `ctx` | `lineNo`, `layer`, `z`, `tool`, `feedrate`, `relativeE`, `relativeMoves`, `object`, `featureType`, `layerChanged`, `meta`, `totalLayers`, `progress` |
| `emit(text)` / `emitBefore(text)` | Add lines after / before this one |
| `drop()` | Drop this line |
| `state` | A scratch object that persists for the whole run |
| `log(message)` | Records a note in the run report |
| `gcode` | `parse`, `num`, `str`, `has`, `set`, `scale`, `offset`, `remove`, `isMove`, `isExtrusion`, `setComment`, `format`, `command` |

Use `gcode.*` rather than your own regular expressions. It is the same tokeniser the rest of the
plugin uses, and it handles the cases that catch hand-written parsers out — a `;` inside a quoted
`M291` string, expression parameters, line numbers and checksums.

#### Two engines: Fast and Sandboxed

The **Engine** field picks how your script actually runs. Existing recipes with no `Engine` set keep
using **Fast** — nothing already saved changes behaviour.

- **Fast** (default): compiles your code directly and runs it once per line. Quick, no download, but
  only a guardrail against accidents (see below) — not a real sandbox.
- **Sandboxed**: runs your code inside a real embedded JavaScript engine (QuickJS) that has no
  network or browser globals *at all* — not shadowed, genuinely absent. Two trade-offs: a roughly
  1 MB one-time download the first time a recipe using it runs in a given browser tab, and **around
  15–20× the per-line cost of the Fast engine** (measured at 17× on a 20,000-line file carrying
  typical slicer metadata — roughly 40 seconds on a million-line file, against about 2 on Fast).
  That is the real price of a genuine boundary rather than a shadowed one; it is why Fast is still
  the default, and why it is worth picking Sandboxed deliberately rather than by habit.
  Lines are still processed strictly one at a time, in order, exactly like the Fast engine — nothing
  about `state`, `emit`/`emitBefore`, or a later step in the same recipe behaves any differently.

  The `gcode.*`/`state`/`emit`/`emitBefore`/`drop`/`log` API is identical on both engines, as are all
  the `ctx` fields listed in the table above — so in practice a script moves between them unchanged.
  The one difference: `ctx.meta.values` is a plain object in the Sandbox rather than a `Map` (use
  `ctx.meta.values.layer_height`, not `.get("layer_height")`), and three rarely-used extras —
  `ctx.token`, `ctx.sawLayerMarker`, `ctx.geometricFallback` — are not carried across the boundary at
  all and read as `undefined`.

#### About script safety — read this

A script step will not run until you tick **"Trust scripts in this recipe"**, which is per browser
session and never saved or imported. That is deliberate, and applies to both engines:

**On the Fast engine, a script runs with the same privileges as the DWC page.** The network and
storage globals (`fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, …) are shadowed so calling
them fails, but this is a guardrail against accidents, not a sandbox — determined code can get around
it. Read any script you did not write before trusting it, exactly as you would a macro someone sent
you. **On the Sandboxed engine, that global object simply is not there to reach** — it is a real,
separate JavaScript engine with nothing but the `gcode`/`ctx`/`state`/`emit`/`log` API you are handed.
The trust checkbox still gates both, since a script's *correctness* (an infinite loop, a mistake that
corrupts your file) is a real concern independent of network isolation.

A watchdog aborts the run if the script takes too long — a running average per line on both engines,
plus a hard per-line wall-clock backstop underneath it on Sandboxed (enforced by the engine's own
interrupt hook, checked during execution rather than polled, and something the Fast engine's
averaging genuinely cannot offer) — so an accidental infinite loop stops the run rather than hanging
the browser either way.

See [scripting-engines.md](scripting-engines.md) for the design behind the Sandboxed engine, and for
the (separate, not yet built) plan to support actual Python.

---

## Bundled recipes

From **⋮ → Add a bundled preset**:

| Recipe | What it does |
| --- | --- |
| Marlin to RepRapFirmware | Maps `M900`→`M572`, `M205`→`M566`, `M420`→`G29 S1`, tool-scoped `M104`/`M109 …T`→`M568`, and comments out `M501`/`M502`/`M851`. Curated, not a general translator — check the result. |
| Pause at a layer | `M400` + `M25` before a chosen layer, for an insert or a colour change |
| Timelapse trigger every layer | Calls a macro at each layer change |
| Pressure advance tower | Sweeps `M572` up the Z height in bands |
| Slow the first layers | Halves the feedrate for layers 0–1 |
| Strip thumbnails and comments | Can halve the file size, which matters on a slow SD card |
| Hand the start sequence to the printer | Calls your own `print_start.g` at the first layer change |
| Boost bridge cooling | Runs bridges and overhangs at full fan speed; everything else untouched |
| Weld curves into arcs | Collapses runs of straight moves that trace a circle back into `G2`/`G3`, with ArcWelder's own default settings |
| Timelapse trigger per object | Calls a macro once per `M486` object, right after that object's own top layer — not once per layer for the whole plate |
| Per-layer Z-offset | Nudges Z by a small amount from a chosen layer onward — first-layer squish after the fact, or a correction partway up a print |
| Bed-temperature ramp | Drops the bed temperature after a chosen layer, via `M140` (never `M190`, which would stall the print waiting for it) |
| Eject sequence (template) | A starting point for an end-of-print ejection routine — every move is commented out; edit the coordinates for your own machine before using it |
| Confirmation gate at a layer | Pauses and waits for the user before a chosen layer, via a genuinely blocking `M291` — verified against both the wiki and the RepRapFirmware source, no `M25` needed |

---

## Inspecting a file

The **Inspect** tab reads the file once, without writing anything, and reports:

- A one-paragraph, plain-English summary — slicer, layer count and height, tools, the print-time
  estimate and which source it came from, filament length, peak flow, labelled objects — built
  entirely from the same facts as the rest of the panel below, so it never says anything the numbers
  do not already back up
- Slicer and version, print time (the slicer's own figure **and** an estimate for this specific
  machine, computed from its real speed/acceleration/jerk limits, plus which of the two sources it
  used — see "Rewrite print time" below), filament, layer height and count
- When this machine's limits are known and complete: how much time this machine's own limits add to
  the file, and how many moves ask for more than it can do — see "Clamp feedrate to machine limits"
  below
- Line count, size, layer count, tools, temperatures, maximum feedrate, extrusion mode, `M486` objects
- Motion extents in X, Y and Z
- Detected **flavour** — RepRapFirmware, Marlin or Klipper — and what the evidence was
- A **command histogram**: every G/M code and how often it appears
- A **fan speeds table**: every distinct fan speed used, how often, and under which features —
  including which scale (0–255 or 0–1) the file uses, so a "Fan speed by feature" step can match it
- **Time and filament by feature** — which feature (external perimeter, infill, support, …) the print
  spends its time and filament on. Time needs this machine's motion limits; filament does not, and
  shows either way
- **Time and filament by object**, when the file uses `M486` (directly, or converted from Klipper's
  `EXCLUDE_OBJECT` by that step)
- **Retractions by tool** — count and total distance, a proxy for oozing and for wear. A retraction is
  counted as its own event regardless of which E mode (`M82`/`M83`) the file uses, and a `G92 E0` reset
  is never mistaken for one
- Every slicer setting found in the header and footer
- Whether the file has already been post-processed, by which recipe and when

### Preflight checks

Most run against the machine's live object model:

| Check | Level |
| --- | --- |
| Commands RepRapFirmware does not implement (`M900`, `M205`, `M420`, `M851`, `M501`, `M502`, `M108`, `M413`) | Error |
| Moves outside the axis limits from `M208` | Error |
| Tools the file selects that are not configured | Error |
| Temperatures above the `M143` heater limits | Error |
| A macro the file calls (`M98`) that is not on the SD card | Error |
| Extrusion before anything waits for the hot end to reach temperature | Error, or Warning if some heating command exists |
| Fans the file drives that do not exist | Warning |
| No homing command anywhere in the file | Warning |
| The file's peak volumetric flow exceeds the slicer's own stated `max_volumetric_speed` | Warning |
| Heaters, the part fan or the motors never turned off at the end | Information |
| No tool selected, no layer markers, slicer not recognised | Information |
| Peak volumetric flow, when the slicer states a filament diameter | Information |

Nothing machine-specific is checked while disconnected — a check that invents failures is worse
than no check. The macro and cold-extrusion checks do not depend on the machine at all, so they
still run offline; the macro check specifically needs the SD card, so it appears a moment after the
rest of the inspection rather than holding it up. The flow checks are also machine-independent —
they never assume a filament diameter the slicer did not state, and never invent a flow ceiling the
slicer did not state either.

### Simulating on this machine

**Inspect this file** first, then **Simulate on this machine** sends `M37` and reads back
RepRapFirmware's own time estimate — the most accurate figure available, since it comes from the
exact firmware that will run the print, not a model of it. This is the one action in this plugin that
talks to the printer rather than only reading or writing files.

Simulation briefly shows as "Simulating" to anyone else watching the machine, but does not move
anything and does not take anywhere near the length of the real print — RepRapFirmware runs it as
fast as it can compute the file, not in real time. It is refused outright (nothing is sent) if the
machine is already printing, simulating, resuming or pausing.

The result is shown next to this plugin's own estimate; the comparison is the point, not a silent
rewrite. It is not currently possible to write the simulated figure into the file's own `M73`
markers — "Rewrite M73 print time" always recomputes from this machine's own motion limits, not
from a simulated total, so re-running it after a simulation produces the same model-based estimate
as before, not the simulated one.

### Comparing two files

The **Compare** tab answers "what actually changed" between two files as facts, not as a wall of
G-code — pick any two files (neither has to be the one selected on the left) and analyse each one to
see their time, filament, temperatures and limits side by side, with the rows that actually differ
highlighted. Useful for checking what a recipe changed at a glance without reading the line diff, or
for comparing two slicer profiles of the same model.

This is a comparison of each file's own analysis, not a line-by-line text diff — a file with every
line renumbered but the same geometry compares as identical here, which is the point.

---

## Where the output goes

| Mode | Result |
| --- | --- |
| **As a new file next to the original** (default) | `benchy.gcode` → `benchy.pp.gcode`. The suffix is editable. |
| **Into another folder** | Keeps the name, writes into a folder you choose |
| **Over the original** | Overwrites, after copying the original to `0:/postproc/backups/` with a timestamp |

Ticking **"Start printing immediately after"** in the Apply confirmation sends `M32` for the written
file once it is safely on the SD card — the same command DWC's own file browser uses to start a
print. Refused if the machine is already printing, simulating, resuming or pausing, both before
anything is applied and again right before the `M32` itself, since the machine's state can change in
between. Never available for a preview — only a real Apply writes a file worth starting.

### What protects you

- **Preview is the default.** Apply is a separate, deliberate action with a confirmation that lists
  every warning.
- **The printing file is off limits.** Processing it, or writing over it, is blocked outright.
- **Backups, and you can get them back.** Overwriting always copies the original first, into
  `0:/postproc/backups/`, and records where it came from in an index — see **Backups** below.
- **Atomic writes.** The output is uploaded to `<target>.pp.tmp` and then moved into place, so an
  interrupted upload never leaves a half-written print file — the original is untouched and there is
  a stray `.tmp` to delete.
- **Verification.** After the move, the file's size on the card is compared against what was sent.
  A mismatch is a loud error, and the backup is kept.
- **An identity stamp.** Every processed file gets a header line recording the recipe and a hash of
  its configuration. Running the same recipe on the same file again warns you first — this is what
  stops the classic "applied the 20% speed reduction three times" bug.

---

## Backups

The **Backups** tab lists every backup taken when overwriting a file in place: the file it came
from, when, its size, and which recipe was about to run. Up to 20 are kept; the oldest is dropped
once a 21st is taken.

Per backup:

- **Restore** — writes it back to the original path, using the same upload-to-a-temp-name-then-move
  approach as a normal write. Refused outright if that path is the file the printer is currently
  reading.
- **Download** — saves a copy through the browser, e.g. to keep one outside the printer entirely.
- **Delete** — removes the backup and its entry. Cannot be undone.

If restoring fails partway through — the original folder no longer exists, say — the backup file
itself is never touched; download it and copy it into place by hand instead.

---

## Large files

Files are read in 4 MB slices through a streaming decoder and the output is flushed as it goes, so
a 200 MB file is never held in memory as text. Processing yields to the browser between slices,
which keeps the interface responsive and **Cancel** live throughout.

It is still your browser doing the work. Above 250 MB you get a warning and a suggestion to leave
the tab open — shown as soon as you select the file, before you press Preview or Apply, not after.
Cancelling before the write phase leaves the SD card completely untouched.

A recipe that includes a step needing to know something about the whole file before it can act (for
example, "Rewrite M73 print time" needing the total time before it can give the first marker a
percentage) reads the file **twice** — once to gather that fact, once to apply the recipe — shown as
its own "Analysing" phase in the progress bar. A recipe without such a step is never slowed down by
this: the second read only happens when something actually needs it. Once applied, the run report
breaks the two out separately so the extra cost of a two-pass recipe is visible rather than folded
into one number.

---

## Troubleshooting

**"This recipe changes nothing in this file."**
The patterns did not match. Check case sensitivity (on by default), whether you meant regex mode,
and the layer range — `-1` means unbounded, `0` means only the first layer.

**Layer numbers look wrong.**
The inspector shows the layer count it derived. Layers come from the slicer's own marker comments
(`;LAYER_CHANGE`, `;LAYER:n`, Simplify3D's `; layer n,`). If a file has none, layer changes are
guessed from Z-only moves, which is less reliable — the inspector flags that case.

**A step did not fire where expected.**
Steps run in order and each sees the previous one's output. If an earlier step rewrote or deleted
the line, a later step matching the original text will not fire. Reorder, or disable steps one at a
time and preview.

**The apply button is disabled.**
The line under the buttons says why: not connected, no file, a recipe problem, an untrusted script,
or a blocking safety issue.

**An update failed to install.**
The About dialog offers a manual download. GitHub's CORS policy occasionally blocks the automatic
path.
