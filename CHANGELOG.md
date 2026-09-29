# Changelog

Release notes for each version. The GitHub Release body for a version is taken from its section
here (see `scripts/changelog-section.mjs`), so write the section before tagging. Versions before
1.3.0 are documented on the [Releases page](https://github.com/jaysuk/duet-gcode-postprocessor/releases).

## [1.3.0] - 2026-09-29

The headline: the plugin now has a **real G-code editor** (an *Edit* tab) with an **offline file
stepper** for testing macros without a printer, and a new **Adaptive bed mesh** step.

### ✨ New: Edit tab — a G-code editor built for G-code
Replaces the general-purpose code editor with one written for G-code (CodeMirror 6, about 40x
smaller than Monaco and built to cope with very large files).

- **Edit tab** on the main page; open a file from the browser, or right-click a G-code file in the
  Jobs page or Explorer and choose **Edit in G-code Post-Processor**.
- **Multi-file tabs and split panes.** Drag a tab between panes, drag the divider to resize
  (the ratio is remembered). Editors keep their undo history and scroll position when you split or
  move them.
- **Live error checking.** The file is checked as soon as it loads (skipped over 5 MB) and lines are
  re-checked as you type; the toolbar issue count follows. Checks use your connected board's firmware
  version, and object-model paths are validated against that version when it is a tracked one.
- **Completion** for commands and their parameters, driven by the G-code dictionary; the **F4**
  quick-picker for codes and `{ }` expressions.
- **Per-line gutter** showing layer, Z and tool at every line, computed only for the visible lines
  so it stays fast on huge files.
- Toolbar: search, jump to the docs for the code under the cursor, align comments, revert, comment
  toggle, bracket closing, word wrap, whitespace/indent guides, a high-contrast theme, and a
  keyboard-shortcuts button (**F1**).
- **Editor colours** dialog: ten independently settable colours, separate light and dark schemes,
  live preview. Saved to the SD card, so it is shared with Flexible Layouts and applies to every open
  tab at once.
- Follows DWC's light/dark theme live without losing undo history.
- The editor never sends anything to the printer and never saves a file by itself.

### ✨ New: Step through a file offline
A scrub bar and step buttons walk a file line by line and show what the machine state would be —
turning the editor into a macro-testing tool.

- Reads out the source line **and the line as evaluated** (`G1 X{param.X}` shown with its value),
  per-axis position cards with deltas, and a variable watch.
- **Follows real execution order**: `if`/`elif`/`else`, `while`, `break`, `continue` and `abort` are
  honoured, not just top-to-bottom.
- **Scenario panel.** Anything the file reads that an offline walk cannot know — object-model values,
  `param.*`, `global.*` — becomes a field to fill in. The walk pauses and asks when it reaches one.
  Values are saved per file, can be cleared individually or all at once, and the walk re-runs as you
  edit.
- **Blocking `M291` message boxes are simulated** as the real dialog (OK, OK/Cancel, choice lists,
  and validated number/text entry). Boxes written with `{ }` expressions show their evaluated text.
- **Named scenarios**: keep several sets of answers per file (new / duplicate / rename / delete).
- **Start line and starting position**: begin at any line or at the cursor; variables declared above
  the start line become inputs. Starting axes, tool, feedrate, extruder and `G91`/`M83` modes are
  settable. `G1 H1` homing moves have a per-axis endstop model.
- Homed state follows `G28`; last commanded X/Y/Z and current tool are answered without asking.
- The panel is compact enough for a 1920x1080 screen: only the scenario list scrolls, so the file
  never gets pushed off screen.

### ✨ New: Adaptive bed mesh step
Shrinks the `G29` probing grid to the area the print actually covers, so a small part on a big bed
does not wait for the whole bed to be probed.

- Rewrites `M557` to the print's footprint plus a margin, at a chosen density: probe **spacing**
  (`S`) or **points** per axis (`P`).
- Uses the first layer only by default and ignores purge/prime lines so they do not stretch the mesh.
- Replaces an existing `M557`, otherwise inserts one just before the first probing `G29`. If the file
  has neither, it is left unchanged and says so, unless you choose to insert at the top.
- Optional probeable-area clamp (the probe is offset from the nozzle), a two-point minimum per axis,
  and a warning above 441 points (a limit on some boards). See [docs/usage.md](docs/usage.md#adaptive-bed-mesh).

### ✨ Improvements
- **Files are now stamped by `dwc-gcode-core`** as well as this plugin's own marker: a
  `; dwc-gcode-core: checked rrf=… plugin=…` line records the firmware version, plugin version and
  time. Written only on a real run (never a dry run), only when the firmware version is known, and
  never to a height-map or probe-points file, where an extra first line stops RRF loading it.
- The code-analysis engine (parsing, expression evaluation, stepping, diagnostics, firmware version
  handling) now comes from the shared `dwc-gcode-core` package, and its command dictionary is fully
  reviewed (280 commands).

### 🐛 Bug fixes
- **Lines holding more than one command** (for example `G90 G1 Z5` or `M83 G92 E0`, common in
  hand-written start/end macros) lost everything after the first command. The second command was
  invisible to layer/Z/feedrate tracking, to anything anchored on those, and to command counts,
  time estimates and flow tracking. Every command on a line is now applied in order. A line no step
  changes is still written back byte-identical.

### 🔧 Under the hood
- Dependencies: `dwc-gcode-core` 1.29, `dwc-gcode-editor` 0.13.1, Vuetify 4.2, Vitest 5,
  `@vitejs/plugin-vue` 6.
- Test suite grew substantially (new editor, stepper and adaptive-mesh coverage); logic that moved to
  `dwc-gcode-core` is tested there.
- `CLAUDE.md` records the gotchas found this cycle.
