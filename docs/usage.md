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

Inserted text may use `{layer}`, `{z}`, `{tool}`, `{line}`, `{file}`, `{feedrate}` and `{object}`.

### Delete or disable lines

Matches lines and either comments them out (the default — reversible, and obvious in a diff) or
deletes them.

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
`comment` · `object` (name) · `feature` (name, from the slicer's `;TYPE:` comment).

**Actions:** `replace` (pattern, replacement) · `replaceLine` (text) · `setParam` · `scaleParam` ·
`offsetParam` · `removeParam` · `insertBefore` · `insertAfter` · `appendComment` · `commentOut` ·
`drop`.

All conditions in a rule must hold. Rules are evaluated in order and all matching rules apply,
unless one sets `"stop": true`.

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

#### About script safety — read this

A script step will not run until you tick **"Trust scripts in this recipe"**, which is per browser
session and never saved or imported. That is deliberate:

**A script runs with the same privileges as the DWC page.** The network and storage globals
(`fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, …) are shadowed so calling them fails, but
this is a guardrail against accidents, not a sandbox — determined code can get around it. Read any
script you did not write before trusting it, exactly as you would a macro someone sent you.

A watchdog aborts the run if the script averages more than its time budget per line, so an
accidental infinite loop stops the run rather than hanging the browser.

See [scripting-engines.md](scripting-engines.md) for what would make this a real sandbox, and for
the plan to support actual Python.

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

---

## Inspecting a file

The **Inspect** tab reads the file once, without writing anything, and reports:

- Slicer and version, print time (the slicer's own figure **and** an estimate for this specific
  machine, computed from its real speed/acceleration/jerk limits, plus which of the two sources it
  used — see "Rewrite print time" below), filament, layer height and count
- Line count, size, layer count, tools, temperatures, maximum feedrate, extrusion mode, `M486` objects
- Motion extents in X, Y and Z
- Detected **flavour** — RepRapFirmware, Marlin or Klipper — and what the evidence was
- A **command histogram**: every G/M code and how often it appears
- A **fan speeds table**: every distinct fan speed used, how often, and under which features —
  including which scale (0–255 or 0–1) the file uses, so a "Fan speed by feature" step can match it
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
| Heaters, the part fan or the motors never turned off at the end | Information |
| No tool selected, no layer markers, slicer not recognised | Information |

Nothing machine-specific is checked while disconnected — a check that invents failures is worse
than no check. The macro and cold-extrusion checks do not depend on the machine at all, so they
still run offline; the macro check specifically needs the SD card, so it appears a moment after the
rest of the inspection rather than holding it up.

---

## Where the output goes

| Mode | Result |
| --- | --- |
| **As a new file next to the original** (default) | `benchy.gcode` → `benchy.pp.gcode`. The suffix is editable. |
| **Into another folder** | Keeps the name, writes into a folder you choose |
| **Over the original** | Overwrites, after copying the original to `0:/postproc/backups/` with a timestamp |

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
