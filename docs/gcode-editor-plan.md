# A custom G-code editor — replacing Monaco, package outline and plan

**Status: 2026-09-16. Discussion only — nothing built yet.** This document exists to turn a
conversation into a plan before any code, the same convention `gcode-core-plan.md` followed for
`dwc-gcode-core`. It is **cross-repo like that document was**: it will live here until (if) the new
package gets its own repo, but it directly concerns `Flexible-Layouts` and DWC core (read-only,
never modified directly) as well as this one.

## Why — the facts this rests on

- **Monaco's own model is incompatible with this plugin's core files.** Monaco's `createModel(value:
  string, …)` needs the *entire* document as one in-memory JS string; there is no streaming/virtualised
  backend. `duet-gcode-postprocessor`'s own `CLAUDE.md` non-negotiable #4 is "never load a 200 MB
  G-code file into a JS string" — Monaco was never going to scale to this plugin's actual files past
  small system configs (`config.g` etc., which is genuinely all DWC's own built-in editor is ever
  asked to open).
- **Monaco is measurably heavy in this exact codebase.** `Flexible-Layouts/src/widgets/ExplorerPanel.vue:23-25`,
  in its own words: *"Monaco is by far the heaviest thing this panel can mount (~3.8 MB of chunk plus
  per-instance model/DOM)"* — which is why that widget already goes out of its way to mount at most
  one live Monaco instance at a time (`v-if="tab.id === activeTab || tab.dirty"`, no `eager`). That
  file is real prior art for the workspace-shell layer (see below), not a hypothetical problem.
- **DWC's own Monaco editor component has no plugin extension point.** Checked directly:
  `DuetWebControl/src/components/editor/MonacoEditor.vue` exposes only `save`/`focus`
  (`defineExpose({ save, focus: focusEditor })`) to whatever mounts it; there is no action registry,
  injected-slot, or hook a plugin could use to add a button or a marker provider to DWC's *own*
  editor instance. This was already true before this document — it means there was never a lighter
  option of "just extend DWC's editor," for the checker/stepper features discussed earlier, or for
  this.
- **`@duet3d/monacotokens` is a real, substantial, separately-maintained investment** (2,150+ lines
  across `providers.js`/`monaco-gcode.js`/`register.js`/`monaco-menu.js`/`monaco-stm32.js`), giving
  DWC's Monaco instances syntax highlighting, hover, completion against the *live* object model, and
  deprecation warnings. It bundles its **own** 276-command G-code dictionary
  (`dist/gcodes/gcodes.json`, 195 KB) — checked directly, no RRF-source citations and no
  version-gating visible in it, unlike `dwc-gcode-core`'s 280-command dictionary (every fact cited to
  an RRF file/case, version-aware via `changesBetween`/`impactOf`). Replacing Monaco means either
  keeping this package around just for its data, or (the better outcome, see Decision 2) driving
  completion/hover from `dwc-gcode-core`'s own, more rigorous dictionary instead.
- **The workspace-shell problem (tabs, split panes) is already solved twice, independently, in this
  family** — good news, since it means that layer is de-risked, not a new idea:
  - `Flexible-Layouts/src/widgets/ExplorerPanel.vue` (118 lines): a flat `tabs` array, one active tab,
    on-demand Monaco mount, dirty tabs kept mounted when inactive so edits are never silently lost.
  - `Duet3D/DuetWebControl` PR **#517** (github.com/jaysuk, open, not yet merged): extends that same
    idea to two side-by-side panes — each tab gets a `groupId`, a draggable divider resizes the panes
    with a persisted ratio (`cacheStore.explorerSplitRatio`), tabs drag from one pane's strip to the
    other. Its own implementation notes name the exact gap a custom editor should close: *"MonacoEditor's
    unmount has no unsaved-content flush path — unmounting a dirty editor would silently lose the
    edits"* — the reason the non-focused pane collapses via CSS instead of unmounting.
- **`duet-gcode-postprocessor` has zero existing Monaco usage** (checked — no match for `monaco` under
  `src/`) — it is greenfield ground for the new package, in the same relationship it already has with
  `dwc-gcode-core`: a dependency, not something built inside this repo.

## Scope — what "replace Monaco, and more" actually means here

Agreed through discussion, not Monaco feature-parity. Table is the record of that discussion; treat a
later change of mind on any row as a plan update, not a reason to distrust the row.

| Area | Verdict | Why |
|---|---|---|
| Buffer, cursor, selection, undo/redo, clipboard | **Keep** | Table stakes for real editing. |
| Multi-cursor / column select | **Skip** | General-IDE convention; not used editing G-code line by line. |
| Virtualised rendering (visible lines only in the DOM) | **Keep, non-negotiable** | The entire reason to do this — see "Why" above. |
| Minimap | **Skip** | G-code is flat, not nested; a minimap over millions of lines is noise. |
| Code folding | **Skip** | Same reason — nothing to fold in a flat command stream. |
| Word wrap, indent guides, whitespace rendering | **Keep (cheap)** | Ordinary text-editor conveniences, low cost. |
| Syntax highlighting | **Keep, off `dwc-gcode-core`** | Already own the tokeniser (`lexLine`) this needs. |
| Hover / completion | **Keep, off `dwc-gcode-core`'s dictionary** | Better source of truth than `@duet3d/monacotokens`'s own (cited + version-gated vs. not). |
| Go-to-definition / rename / code lens / outline | **Skip** | No such concept in G-code. |
| Diagnostics (squiggles, hover message) | **Keep** | `diagnoseDocument`'s line/column spans map straight onto markers — this is the "check file for errors" feature from earlier in this conversation. |
| Auto-fix / code actions | **Skip for now** | Revisit if a specific one earns its keep. |
| Comment toggling (`;`) | **Keep (cheap)** | |
| Auto-close brackets for `{expression}` | **Keep (cheap)** | Real syntax in conditional G-code. |
| Document formatter | **Skip** | No agreed definition of "well-formatted G-code" to build against. |
| Diff / merge editor | **Skip** | The postprocessor already has a purpose-built diff (`Pipeline.diff`) for before/after recipe results — a better fit than a generic text diff for that job. |
| Multiple tabs | **Keep** | Already built twice in this family (see "Why") — port the *design*, not Monaco-specific code. |
| Split panes | **Keep** | PR #517's design — the newly-added requirement from this conversation. |
| Bidi/RTL, IME composition | **Skip** | G-code is ASCII command letters and numbers; solving this is most of what makes "just build a text editor" hard, for zero domain value. |
| Screen-reader / ARIA, keyboard nav, high-contrast theme | **Keep (basic)** | Cheap, real value, not the deep accessibility engineering IME/bidi would be. |
| Command palette, rebindable keymaps | **Skip** | No one remaps keys in a G-code viewer. |
| **G-code-native gutter**: per-line toolhead position/Z/layer/tool from `state.ts` | **Build — new** | Monaco has no concept of this; this is the actual "and more." |
| **Scrub bar / step-through** tied to machine state | **Build — new, offline first** | The "step through a file" feature from earlier; live single-step (sending real commands) is an explicitly separate, later phase — this plugin deliberately has no `sendCode` today (`docs/tasks/13-simulation-and-tail.md`'s own stop point). |
| Flush-before-unmount/hide contract | **Build — new** | Closes the exact gap PR #517 had to work around for Monaco. |

## Architecture

### Decision 1 — a new framework-free core package, not code embedded in either plugin

Same shape as `dwc-gcode-core`/`dwc-config-backup-core`: pure TypeScript, `types: []`, no Vue/DOM
assumptions baked into the model, consumed by thin wrapper components in each host. Proposed name
**`dwc-gcode-editor`** (parallel to `dwc-gcode-core`; bikeshed later, not load-bearing now). Building
it inside `Flexible-Layouts` directly, as raised in discussion, was rejected: it would make
`duet-gcode-postprocessor` depend on *another plugin* for its own inspector feature — backwards from
how every other shared capability in this family works.

**What the core owns:**
- A virtualised line/viewport model — given a scroll position and viewport height, which lines to
  materialise, in a shape a thin renderer can paint without knowing the file is potentially huge.
- Highlight spans per visible line, from `dwc-gcode-core`'s `lexLine` (already allocation-light,
  already the hot path this needs).
- Diagnostics-to-marker mapping, from `dwc-gcode-core`'s `diagnoseDocument` (line/start/end already
  shaped for this).
- Completion/hover data, from `dwc-gcode-core`'s dictionary (`dictionary/commands.ts`) — a new,
  smaller adapter than `@duet3d/monacotokens`'s `providers.js`, since it does not need that package's
  Monaco-specific decoration/action-attachment machinery.
- Edit operations routed through `dwc-gcode-core`'s `edit.ts` (line-level `setParam`/insert) rather
  than modelling arbitrary keystroke-level text mutation as the source of truth — see Decision 3.
- A `flush(): Promise<void>` (or sync, TBD by stop point 2) contract every host must call before
  unmounting or hiding an editor instance — the fix for PR #517's documented gap.
- The workspace-shell *data model* (tabs, groups, active/focused tracking) as pure state — ported
  from `ExplorerPanel.vue`'s flat-array-plus-`groupId` design and PR #517's two-group extension —
  with each host's own Vuetify `v-tabs`/`v-window` (or equivalent) as the thin rendering layer over
  it, the same split already used for `Pipeline`/`AnalysisRunner` vs. their Vue callers elsewhere in
  this family.

**What each host's thin wrapper owns:** DOM/canvas painting, keyboard/mouse/IME event wiring, the
actual `v-tabs`/split-pane chrome, and the G-code-native panels wired to plugin-specific state —
`duet-gcode-postprocessor`'s `state.ts`/`analysis.ts` feed the position/step gutter there; whatever
`Flexible-Layouts` wants feeds its own copy.

### Decision 2 — drive language intelligence from `dwc-gcode-core`, not `@duet3d/monacotokens`

Already argued above: the dictionary is more rigorous (cited, version-gated) and already owned.
`@duet3d/monacotokens`'s object-model-aware completion (axis letters following the connected
machine's *actual configured axes* — `providers.js`'s `expandAxisParameter`) is a genuinely good
feature worth reproducing, not copying wholesale — it needs the live object model, which the new
core's completion adapter would take as an input the same way `dwc-gcode-core`'s own
`diagnoseDocument` already takes a `firmwareVersion`.

### Decision 3 — edits are structured operations first, free-form text second (open, see stop point 1)

Leaning: model edits primarily as calls into `dwc-gcode-core`'s `edit.ts` (`setParam`, insert/remove
line) plus plain line-level text replacement, rather than an arbitrary-position keystroke stream as
the primary API. This sidesteps most of what makes "build a text editor" a deep well (arbitrary
mid-token insertion, multi-cursor consistency) for a domain that is overwhelmingly "change this
parameter" or "add/remove this line," not prose editing. **This is a real, unresolved design
question, not a settled decision** — free-form typing has to work for hand-editing a macro
regardless of how completion/diagnostics are modelled, so stop point 1 below has to answer *how much*
of real character-by-character editing still needs its own, non-structured path.

### Decision 4 (stop point) — build the text-editing primitives on CodeMirror 6, not from scratch

**Recommendation, not yet verified — see stop point 2.** "Our own custom version, customise as much
as we like" does not require reinventing cursor/selection/undo/IME/clipboard from zero. CodeMirror 6
(MIT, `@codemirror/state` + `@codemirror/view` + `@codemirror/commands`, pulled in à la carte) is
built specifically to be extended rather than used as a monolith the way Monaco is — a G-code
language mode, our own gutter widgets, our own linting source, and our own completion source are all
first-class CM6 extension points, not workarounds. It has real large-document support Monaco lacks
(though "real" needs to be measured, not assumed — stop point 2). This gets 100% of the
customisability the user asked for while not spending months re-solving IME composition and undo-tree
correctness, which add zero value for G-code and are exactly the kind of subtle-bug-prone problem
worth not re-inventing. If stop point 2 shows CM6 cannot handle a real multi-hundred-thousand-line
fixture acceptably, the fallback is a fully bespoke buffer — strictly more work, kept as the fallback
rather than the default plan.

## Stop points — resolve these before deep implementation

Per this family's own convention (`docs/tasks/13-simulation-and-tail.md`'s pattern): a genuinely open
question gets a first step that resolves it empirically, not a guess baked into the design.

1. **How much of real editing needs free-form, non-structured text mutation?** Sit down with the
   actual expected use (hand-tweaking a macro/start-gcode block vs. purely viewing+diagnosing a huge
   sliced file) and decide whether Decision 3's "structured operations first" holds, or whether full
   free-form editing is required everywhere from day one. This changes how much CM6's own
   transaction/change model needs to be exposed vs. wrapped.
2. **Verify CM6's real behaviour on a large fixture before committing to Decision 4.** Build a throwaway
   prototype: load one of the golden-file fixtures' larger siblings (or a synthetically large one) into
   a bare CM6 instance with a custom G-code `StreamLanguage`, and measure scroll/typing responsiveness.
   Confirm it does NOT require the whole file as one in-memory string in the same way Monaco does (CM6's
   `Text` type is a rope, not a flat string — verify this claim against CM6's own docs/source rather
   than trusting general knowledge of it, matching this family's own standing rule).
3. **How does a plugin ship a ~heavy dependency without bloating the always-loaded bundle?**
   `duet-tool-align`'s lazy-fetched `opencv.bin` asset and `duet-gcode-postprocessor`'s own QuickJS
   asset (`scripts/build-quickjs-asset.mjs`, task 14/15) are the established pattern in this family —
   confirm CM6's real bundled size (likely far smaller than Monaco's ~3.8 MB, but measure, don't
   assume) and decide whether it even needs the lazy-asset treatment or can just ship in the normal
   bundle.
4. **Does the workspace-shell's flat single-array of tabs (both prior-art files, and PR #517's
   `groupId` extension) still work once tabs live in a Flexible-Layouts *widget* (a grid tile, not a
   full page)?** A widget's available space is much smaller than a page — confirm split-panes still
   make sense there at all, or whether split view is page/full-screen-only in that host, with the
   widget staying single-pane (`ExplorerPanel.vue`'s existing shape, just re-pointed at the new core).

## Explicitly out of scope for this round

- Live single-step execution against real hardware (sending each line, pausing, inspecting real
  state) — a separate, later, higher-risk phase per the earlier conversation; needs its own safety
  design (`sendCode`, never the file currently printing, motion-limit awareness) once the offline
  scrub/stepper UI exists to build on.
- Anything from the "Skip" column of the scope table above, unless a concrete need surfaces later.
- Upstreaming any of this into DWC core itself, or coordinating it with PR #517 — that PR stands on
  its own, still Monaco-based, unaffected by this plan.
- Replacing `@duet3d/monacotokens`'s object-model-aware axis-letter expansion feature set wholesale —
  Decision 2 reproduces the useful part, not a line-by-line port.

## Sequencing

1. Stop points 1–3 (the CM6-viability and editing-model questions) — these can invalidate Decision 4
   if the answers differ from what's assumed here; report and reconsider rather than building through
   them.
2. The new package's core: virtualised viewport model, `dwc-gcode-core`-driven highlighting and
   diagnostics, the `flush()` contract, the workspace-shell data model. Framework-free, fully unit
   tested (this family's standing rule: every test has teeth, verified via revert-and-rerun).
3. One host settles the UI — `duet-gcode-postprocessor`, since it is greenfield here and already owns
   the state-tracking (`state.ts`/`analysis.ts`) the G-code-native gutter needs, and it is where the
   "check for errors" + offline stepper features were originally scoped.
4. Port to `Flexible-Layouts`: swap `ExplorerPanel.vue`'s `resolveComponent("MonacoEditor")` for the
   new core's wrapper, add stop point 4's split-pane answer once known.

## Verification

- All three gates in each consuming repo, matching this family's non-negotiable process.
- The new package's own tests must have teeth (a bug injected, watch the relevant test fail) — same
  standard `dwc-gcode-core` holds itself to.
- Before calling any phase done: manually exercise it against a real, large slicer-output fixture
  (not just the existing small golden-file fixtures) for scroll/typing responsiveness, and against a
  file with real diagnostics to confirm markers land at the right line/column — the same "verify the
  claim, don't assume the API existing is enough" standard used throughout this family.
