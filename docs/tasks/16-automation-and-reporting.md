# Task 16 — the automation phase: matching, auto-run, batch, history and reporting

**Read [README.md](README.md) first, then [CLAUDE.md](../../CLAUDE.md).** The four non-negotiables
there are binding.

Tasks 01–15 built the *transformation* half of this plugin and finished it. What is left is the half
that decides **which** file gets processed, **when**, and **what happened afterwards** — the
`D`-series in [FEATURES.md](../../FEATURES.md), plus the reporting rows that hang off it. Every part
here composes over `processFile` from the outside. **Nothing in this task changes `processFile`'s
signature, the `Transform` contract, the pipeline, or any step.**

| | Item | What it really is |
| --- | --- | --- |
| **A** | D4, recipe matching rules | Pure matching, plus a real pre-existing import bug in the same file |
| **B** | D8, run history | A second `backups.ts` — same shape, same tolerance, different index |
| **C** | F2, run report | One pure string builder; the data is already on `ProcessResult` |
| **D** | D5, auto-run on upload | An app-lifetime `fileUploaded` listener. **The riskiest part** |
| **E** | D6 + A2, batch processing and multi-select | A serial loop over `processFile` with per-file skip reasons |
| **F** | F4 diagnostics, F1's missing half, FEATURES.md corrections | Mostly wiring things that already exist |
| **G** | F6, touch and mobile | CSS and two structural swaps |
| **H** | E13, preflight as a gate | **A correction — see below.** The seam is already in the code, unused |

**Order: A and B first.** C, D, E and F all consume one or both. C, F, G and H are independent of
each other and can be done in any order after B. **D and E both need A and B finished.**

## A correction to what the user was told

The user was told the whole E-series was built. **E1–E12 are; E13 is not.** `runChecks`
(`model/checks.ts:53`) is called from exactly one place — `FileInspector.vue:324` — and its results
are rendered and then dropped. Nothing gates Apply on them. The E8–E12 rows are also missing the
`· v1` tag their own top-of-file blurb already claims for them, which is what made the table read as
complete. Part H fixes the feature; Part F fixes the table. Both are in scope precisely because the
wrong answer was given out loud.

The same is true of **F1**, in the other direction: the widget ships (`index.ts:38`,
`components/PostProcessorWidget.vue`) but the row promises "plus recent runs", which does not exist.
It is ~15 lines once Part B lands. Do not tick that row before then.

## Process note, carried forward from tasks 14 and 15

**No figure in this document is a result.** Line numbers, file counts and the DWC facts quoted below
are facts about the current tree, verified by reading it. Anything this task *produces* — a batch
throughput, a "sensible" history cap, a breakpoint that "works well on the panel" — must be measured
or seen on the finished implementation before it goes into a doc, a tip, or a test bound.

---

## A — D4, recipe matching rules

**The gap is worse than "unbuilt".** `Recipe.match` (`model/recipe.ts:44`) exists, `matchesFilter`
(`model/recipe.ts:324`) exists and is tested, and `RecipeEditor.vue:60` renders a field for it
labelled *"Only files matching"* with the hint *"Used when picking a recipe automatically."*

**Nothing calls `matchesFilter` outside its own test.** Confirmed:

```
$ grep -rn "matchesFilter" src/
src/model/recipe.ts:324:export function matchesFilter(...)
src/__tests__/recipe.test.ts: (its own tests)
```

So today a user can fill in a field that promises automatic selection and does literally nothing.
That is worse than the feature being absent, and it is why D4 goes first.

D4 asks for three axes: **filename glob, folder, detected slicer.**

### Design decisions already made

- **Keep `match` exactly as it is.** It is already persisted in users' settings bags. Add
  `matchFolder?: string` and `matchSlicer?: string` alongside it on `Recipe`. Do not restructure into
  a `matchRules` object — that is a migration for no gain.
- **`matchFolder`** is a directory prefix, compared through `normalisePath`
  (`model/io/plan.ts:208`), matching that directory **or any directory below it**. Blank means any.
- **`matchSlicer`** is a `SlicerName` (`model/gcode/metadata.ts:11`) or blank, compared
  case-insensitively against `meta.slicer`.
- **Matching splits into two tiers, and this is the structural decision the rest depends on:**
  - `matchesPath(recipe, path): boolean` — glob + folder only. Pure, needs nothing but the path,
    callable before anything is downloaded.
  - `matchesFile(recipe, path, meta): boolean` — the above **and** the slicer. Needs a prescan.

  A caller with no metadata in hand (the browser, the batch picker) uses tier 1 and treats a recipe
  with `matchSlicer` set as *possible*, not confirmed. A caller that has downloaded and prescanned
  (auto-run, batch) uses tier 2. Do not collapse these into one function with an optional `meta`
  argument — the difference between "might match" and "does match" is the whole point, and an
  optional argument hides it at every call site.
- **`pickRecipe(recipes, path, meta?)` returns `{ chosen, matches, ambiguous }`**, not a single
  recipe. `chosen` is the first match in the user's own recipe order; `matches` is all of them;
  `ambiguous` is `matches.length > 1`. A caller that must not guess (auto-run) can refuse when
  `ambiguous`; a caller that can offer a choice (the page) can show the list.
- **A recipe with all three rules blank is never a candidate for automatic selection.** This is the
  single most important call in Part A. `matchesFilter` returns `true` for a blank filter — correct
  for "does this filter exclude the file", catastrophic for "should this recipe run automatically",
  because it would make the first recipe in the list the auto-run recipe for every file the user ever
  uploads. Automatic selection is opt-in **per recipe**, by filling in at least one rule.
- **New module `src/model/recipeMatch.ts`.** `matchesFilter` stays where it is and is imported by the
  new module. Moving it would churn `recipe.test.ts` for nothing.

### A real pre-existing bug, in the same function you are editing

`importRecipe` (`model/recipe.ts:300–310`) rebuilds each step from the parsed JSON:

```ts
return {
    uid: ..., type: step.type, note: ..., enabled: step.enabled !== false,
    config: ...,
};
```

**`condition` is not copied.** `exportRecipe` (`:280`) stringifies the whole recipe, so conditions
*are* written out — and then silently thrown away on the way back in. Export a recipe whose steps are
gated on `filament_type`, re-import it, and every step now runs on every file. Fix it in the same
pass, and add `matchFolder`/`matchSlicer` to the recipe-level fields next to the existing `match`
while you are there.

### UI

`RecipeEditor.vue`'s name/match row (`:56–64`) becomes four fields: Name, "Only files matching"
(unchanged), "Only in folder", "Only when sliced by" (a select over `SlicerName`, with a blank
"any"). Same `patch({...})` pattern as the existing two.

### Tests

New `src/__tests__/recipeMatch.test.ts`:

- glob only; folder only; slicer only; all three ANDed
- **a folder rule matches a subdirectory but not a sibling sharing its prefix** — `0:/gcodes/petg`
  must match `0:/gcodes/petg/x.gcode` and must **not** match `0:/gcodes/petg-old/x.gcode`. A naive
  `startsWith` gets this wrong.
- volume-prefix leniency, via `normalisePath`: a rule written `/gcodes/petg` matches a path given as
  `0:/gcodes/petg/x.gcode`
- a recipe with no rules at all is never returned by `pickRecipe`
- two matching recipes → `ambiguous: true`, `chosen` is still the first in list order
- tier 1 vs tier 2: a recipe with `matchSlicer: "Cura"` is a candidate under `matchesPath` and is
  rejected by `matchesFile` when the metadata says PrusaSlicer

Extend `src/__tests__/recipe.test.ts`:

- **export → import preserves step conditions.** This fails before the fix above.
- export → import preserves all three match fields

---

## B — D8, run history

**The gap.** Nothing records what ran. `backups.json` records what was *replaced*, which is only the
in-place subset — a run that wrote alongside leaves no trace anywhere except the stamp inside the
output file.

### Design decisions already made

- **Storage: `0:/postproc/history.json` on the SD card**, in exactly the shape and with exactly the
  tolerance of `model/io/backups.ts` — parsing never throws, a malformed entry is dropped rather than
  discarding the file, newest first, pruned at a cap. Read that module's header comment before
  writing this one; the reasoning transfers wholesale.

  **Not the plugin settings bag.** Recipes live there because they are small and hand-edited; history
  grows on every run and would bloat DWC's own settings file, which is written back to the board.
- **Only applied runs are recorded. Never dry runs.** A preview is cheap and frequent; an SD write
  per preview is not, and the Preview tab already shows the current one.
- `HistoryEntry`: `at`, `sourcePath`, `targetPath`, `recipeName`, `recipeHash`, `linesChanged`,
  `linesAdded`, `linesRemoved`, `bytesIn`, `bytesOut`, `durationMs`, `backupPath: string | null`,
  `warnings: Array<string>`, `origin`, `ok`, `error?`.
  - **`origin: "page" | "widget" | "auto" | "batch"`** is what makes *"did the auto-runner do this?"*
    answerable, which is the one question a run history exists to answer once Part D ships.
  - `recipeHash` (`model/recipe.ts:241`) joins an entry to the stamp already written into the file.
- `MAX_HISTORY = 100` in `model/constants.ts`, next to `MAX_BACKUPS` (`:193`).
- **`src/model/io/history.ts`** carries the pure half (`parseHistory`, `addRun`, `pruneHistory`,
  `serialiseHistory` — mirror `backups.ts` one for one) **plus** `recordRun(gateway, entry)`, which is
  impure but gateway-injected, exactly as `updateBackupIndex` (`model/io/transfer.ts:463`) is.
  `recordRun` **never throws**: a failed history write must not fail a run that already succeeded.
  Same rule, same reason, as `transfer.ts:399–409`.
- **`processFile` is not changed.** It takes no history option and knows nothing about this. It is the
  tested core, and `origin` is a fact about the caller, not about the run.
- Call sites: every caller that runs with `dryRun: false` — `PostProcessorPage.run()` (`:437`), and
  the new auto-run and batch paths from Parts D and E.
- UI: new `src/components/RunHistory.vue`, added as a sixth tab (`PostProcessorPage.vue:86–93`).
  Newest first, each row expandable to its warnings, plus a "Clear history" action that writes an
  empty index.

### Traps

- **Do not record a cancelled run.** `CancelledError` propagates out of `processFile`, and `run()`'s
  catch (`PostProcessorPage.vue:474`) already treats it as "not an error". Record a failure entry for
  a real error only — a cancel is a user decision, not an outcome worth keeping.
- `recordRun` downloads the existing index first, and the gateway **rejects** for a file that does not
  exist. `test/component.test.ts:27` documents this behaviour deliberately. Treat the rejection as
  "no history yet", the way `updateBackupIndex` does at `transfer.ts:465–469`.

### Tests

New `src/__tests__/history.test.ts`, using the in-memory fake gateway
`src/__tests__/transfer.test.ts` already builds:

- parse tolerance: empty string, not JSON, JSON that is not an array, one malformed entry among good
  ones (the good ones survive)
- newest-first ordering, and pruning at the cap
- `recordRun` writes an index where none existed (the download rejects)
- `recordRun` appends to an existing index
- **`recordRun` resolves rather than throwing when the upload fails**

---

## C — F2, run report

**The gap.** `DiffPreview.downloadDiff` (`components/DiffPreview.vue:157`) writes the changed lines
and nothing else: no recipe, no per-step counts, no warnings, no timings, no skipped-by-condition
lines. F2 asks for the *report*, of which the diff is one section.

### Design decisions already made

- **New pure `src/model/runReport.ts`**: `buildRunReport({ result, recipe, sourcePath }): string`,
  Markdown. Everything it needs is already on `ProcessResult` (`model/io/transfer.ts:168`) and
  `RunStats` (`model/pipeline.ts:26`). String in, string out, no I/O — non-negotiable 1.
- **Extract the per-step label mapping.** `DiffPreview.vue:143–155` builds step labels from
  `effectiveSteps` + `getStepDefinition`, including a `Step N` fallback for a step whose type is no
  longer in the registry. Move that into `runReport.ts` and have `DiffPreview` import it. Do not write
  a second copy — that is exactly how `forEachLine` came to exist three times with the bug fixed in
  two of them (see `transfer.ts:50–62`).
- Sections, in order: header (file, recipe name, `recipeHash`, when, applied-or-dry-run), totals,
  per-step counts, warnings, timings (`durationMs` / `analysisMs` / `transformMs`), then the diff,
  capped, keeping the existing "the list was capped" note (`DiffPreview.vue:166–168`).
  `stats.warnings` already contains the skipped-by-condition lines, pushed at `transfer.ts:314` — so
  "which steps were skipped and why" comes out for free and must appear in the report.
- Wiring: `DiffPreview`'s download button becomes "Download the run report"; the applied-success alert
  (`PostProcessorPage.vue:132–145`) gains the same button. Both use `downloadBlob` from
  `dwc-plugin-runtime/download`, already imported at `DiffPreview.vue:105`.

### Tests

New `src/__tests__/runReport.test.ts`, from a hand-built `ProcessResult` (no I/O):

- the report contains the recipe name, its hash, and every step's label with its count
- every entry in `stats.warnings` appears, including a skipped-by-condition line
- `diffTruncated: true` produces the truncation note; `false` does not
- a dry run says so in the header; an applied run names the target and the backup
- a step whose type is not in the registry renders as `Step N` rather than throwing

---

## D — D5, auto-run on upload

**The riskiest part in this task.** It writes to files without being asked, from a listener with no
page open. Every decision below is about making that safe.

### Verified facts — do not re-derive these

Read from the DWC checkout at `/c/Users/live/Documents/Github/DuetWebControl`:

- **`fileUploaded` exists**, declared at `src/utils/events.ts:131` with payload
  `{ filename, content, startTime, num, count, showProgress, showSuccess, showError }`, and emitted at
  `src/stores/machine.ts:748` — **inside the per-file loop, after the bytes are on the card.**
- **It fires for every upload made through this DWC session, including this plugin's own.**
- **It does not fire for an upload made outside this tab.** A slicer uploading straight to the Duet
  never passes through `machineStore.upload`. FEATURES.md's "Works while a DWC tab is open" is correct
  and is narrower than it sounds: it means *this* tab.
- **`showConfirmDialog`** (`@/composables/useConfirmDialog`) pushes into a module-level reactive queue
  rendered by `<ConfirmDialogQueue />` in DWC's `src/App.vue:13` — **app-global, not route-scoped**, so
  it works with no page of ours mounted. The test kit stubs it and it **auto-resolves `false`**.

### Design decisions already made

- **`src/dwc/autoRun.ts`**, installed from `index.ts` next to `installErrorCapture()` (`:54`) and torn
  down in `onPluginUnloaded` (`:59`). App lifetime, so it keeps working with the plugin loaded and the
  page closed — which is the entire point of the feature.
- **Off by default**, per browser (`localStorage`, `LS_AUTORUN_ENABLED` in `model/constants.ts`), with
  a **separate second opt-in** `LS_AUTORUN_SILENT` for the no-confirmation mode. Enabling auto-run must
  not enable silent mode. Per-browser rather than per-board because it is a property of "this tab is
  watching", not of the machine.
- Flow on each `fileUploaded`:
  1. Ignore unless enabled.
  2. **Ignore anything under `WORK_DIR` and anything ending `.pp.tmp`.** This is what stops the plugin
     triggering itself, and it is *sufficient*, provably: `processFile` only ever uploads to
     `plan.tempPath` (`${targetPath}.pp.tmp`, `model/io/plan.ts:85`), to a backup under `BACKUP_DIR`
     (`transfer.ts:393`), and to `BACKUP_INDEX` (`:473`). The final target arrives by `move` (`:418`),
     which emits `fileOrDirectoryMoved`, **not** `fileUploaded`. Part B's `history.json` is under
     `WORK_DIR` and is therefore already covered.
  3. Ignore anything that is not a G-code file. The extension test already exists at
     `GcodeBrowser.vue:153` — **lift it into `model/io/plan.ts` as `isGcodePath` and have the browser
     import it.** Do not copy it.
  4. Tier-1 match (Part A) over the saved recipes. No candidate → stop, silently. `ambiguous` → stop
     and notify once; auto-run must not guess between two recipes.
  5. Download and `prescan` (`transfer.ts:191` — at most 96 KiB from each end, not the whole file),
     then tier-2 match.
  6. **Refuse a recipe that uses scripts** (`usesScripts`, `model/recipe.ts:116`). Trust is
     per-session and deliberately never persisted (`dwc/recipeStore.ts:12–15`); there is nobody
     present to grant it. Notify once and stop — do not retry, and do not treat a persisted
     `scriptsTrusted` as trust, because `sanitise` (`recipeStore.ts:51`) clears it on every read.
  7. `checkSafety` (`model/io/plan.ts:143`) with the same inputs `PostProcessorPage`'s `safety`
     computed uses (`:295–307`). Any `block` → refuse and notify.
  8. Unless silent mode is on, `showConfirmDialog` naming the file, the recipe **and the target
     path**. Declined → stop.
  9. `processFile` with `dryRun: false`; `recordRun` with `origin: "auto"`; notify.
- **One at a time, queued.** A multi-file upload emits `fileUploaded` once per file, so several full
  pipelines would otherwise run concurrently on the main thread and make the tab unusable. A simple
  serial queue, capped — drop with one notification past the cap rather than growing without bound.
- **Never auto-run against the file currently printing** — already covered by `checkSafety`'s
  `sourceIsJob` block, so this needs no new code, but **assert it in a test**, because it is the
  failure that matters most.

### Traps

- **Register from `index.ts`, not from a component.** A listener installed by a mounted component
  stops working the moment the user navigates away, which is precisely when auto-run is supposed to be
  doing its job.
- **`Events.off` needs the same function reference** in the unload handler. A plugin restart otherwise
  stacks a second listener and every uploaded file is processed twice.
- **Do not call `useMachineStore()` / `useSettingsStore()` at module top level in `index.ts`.** Pinia
  is not ready when the plugin module is evaluated. Call them inside the handler.
- **The test kit's `showConfirmDialog` stub resolves `false`.** A test expecting a run to happen must
  override it; a test expecting nothing to happen will pass for the wrong reason unless it also
  asserts *why* nothing happened.

### Tests

New `src/__tests__/autoRun.test.ts` for the decision logic (pure, against a fake gateway and a
hand-driven event), plus wiring coverage in `test/component.test.ts`:

- the plugin's own uploads are ignored — one case each for `0:/gcodes/x.gcode.pp.tmp`,
  `0:/postproc/backups/x.gcode`, and `0:/postproc/history.json`
- a non-G-code upload does nothing
- no matching recipe → nothing happens
- two matching recipes → nothing happens, and a notification says why
- a matching recipe containing a script step → refused, notified, **`processFile` never called**
- the uploaded file is the current print job → refused by `checkSafety`
- confirmation declined → nothing written
- confirmation accepted → one write, one history entry with `origin: "auto"`
- two uploads in quick succession → two runs, **serially**, not two concurrent pipelines

---

## E — D6 + A2, batch processing and multi-select

**The gap.** One file at a time. A2 (multi-select) is the enabler and is also unbuilt.

### Design decisions already made

- **`GcodeBrowser` gains an opt-in selection mode** — a checkbox per row and "select all in this
  folder" — emitting `update:selection` **alongside** the existing single-file `v-model`, which stays
  the primary contract. The page's entire safety layer is built on one `selectedPath`
  (`PostProcessorPage.vue:286–332`); turning that into an array would touch every computed on the
  page. Selection is a second, additive model, not a replacement.
- **`src/model/io/batch.ts`**: `runBatch({ gateway, paths, recipe, planFor, onProgress, signal, ... })`
  — serial, cancellable at every file boundary *and* inside each file (it passes the same `signal`
  object down to `processFile`).
- **It does not stop on the first failure.** It records a per-file outcome and carries on. Stopping
  halfway through 40 files leaves the user with no idea which ones were done, which is worse than
  finishing and reporting. `BatchResult` is `Array<{ path; outcome: "done" | "skipped" | "failed";
  result?; error?; reason? }>`.
- **Per-file safety, per file.** `checkSafety` for each; a file with a `block` is **skipped with a
  reason**, never failed and never silently dropped. The confirmation happens **once, up front, for
  the whole batch, and must list what will be skipped before the user agrees.**
- **One recipe and one output mode for the whole batch.** Per-file recipe selection via Part A is a
  separate, later idea — say so in the module comment and do not build it.
- History: one entry per file, `origin: "batch"`.
- UI: a "Batch" action in the page toolbar opening a dialog — the selected files, the recipe, the
  output mode, the skip list, a per-file progress row, and Cancel.

### Traps

- **Cancel must abort the batch, not just the current file.** One `signal` object shared by every
  `processFile` call, checked between files as well as inside them.
- **In-place mode over a large selection silently destroys backups.** `planOutput` per file with
  `mode: "inPlace"` produces N backups, and the index prunes at `MAX_BACKUPS = 20`
  (`model/constants.ts:193`) — so a batch of 40 in-place files drops the first 20 backups as it goes.
  **The confirmation must warn about this explicitly** when the mode overwrites and
  `paths.length > MAX_BACKUPS`. This is a real data-loss-shaped edge that the single-file path has
  never had to face; it is the reason this trap is written down rather than discovered.
- **Do not retain every file's diff.** A 2000-entry diff (`DEFAULT_MAX_DIFF`, `pipeline.ts:56`) per
  file across 40 files is a lot of held strings. Keep `stats` for every file and drop `diff`.

### Tests

New `src/__tests__/batch.test.ts`, against the in-memory fake gateway from `transfer.test.ts`:

- three files, all processed, three results, in order
- one file throws → the other two still run, and the failure is recorded against the right path
- a file that is the current print job → `outcome: "skipped"` with a reason, not `"failed"`
- cancel after the first file → the second and third are never started
- the over-`MAX_BACKUPS` in-place condition is reported by the pure predicate (test the predicate, not
  the dialog)

---

## F — F4 diagnostics, F1's missing half, and the FEATURES.md corrections

### F4 — diagnostics report

`installErrorCapture()` is already installed (`index.ts:54`), so errors are already being buffered.
**Nothing surfaces them.** Everything needed exists:

- `dwc-plugin-runtime/diagnostics` (installed version 0.8.8) exports `buildReport`, `downloadReport`,
  `copyReport`, `recordError`, `sanitizeModel`.
- `AboutDialog` already accepts `extraActions: Array<AboutExtraAction>`
  (`{ label; icon?; color?; disabled?; onClick }`).

So: pass two extra actions from `PostProcessorPage.vue:210`'s `<AboutDialog>` — "Download
diagnostics" and "Copy diagnostics" — each building
`buildReport({ pluginId: PLUGIN_MANIFEST_ID, model: machineStore.model, state })`.

**`state` carries** the active recipe (with `scriptsTrusted` stripped — reuse the same sanitising
`recipeStore.ts:51` does), the selected path, the last run's `stats`, and the last error. **It must
not carry the diff**: that is the user's file content, and it is large.

**Label the buttons honestly.** `sanitizeModel` redacts G-code filenames from the *model*; putting the
selected path into `state` puts one back. That is correct — F4's own promise is a report "replayable
directly into a regression test", which needs it — but the button must say so rather than surprising
the user after the fact. Wording along the lines of "Download diagnostics (includes your recipe and
the selected file's name)".

Also add `recordError("run", e)` at `PostProcessorPage.vue:474`, where a failed run currently goes
into a string and nowhere else — so a run failure is actually in the buffer the report reads.

### F1 — the missing half

Once Part B lands, `PostProcessorWidget.vue` shows the last three history entries under its Preview
button. Then, and only then, tick F1.

### FEATURES.md corrections

- **F1**'s Phase cell says `7`; the v1.0.0 blurb at the top of the file already lists "the
  Flexible-Layouts widget (F1)" as delivered.
- **E8–E12** say `6`; the same blurb already lists "the preflight checks (E8–E12)".

Fix all six cells to the `· v1` form with their module paths, the way G1–G14 are recorded, and update
the blurb's "Still outstanding" list as each part of this task lands.

### Tests

`test/component.test.ts`: the About dialog renders both diagnostics actions; clicking Download calls
through (mock `dwc-plugin-runtime/diagnostics`); the built `state` contains the recipe and the path
and **does not contain the diff**.

---

## G — F6, touch and mobile

**The gap.** Two media queries exist in the whole plugin: `PostProcessorPage.vue:39` (960px) and
`CompareFiles.vue:8` (760px). The target hardware is the 4.3" panel at 800×480 and the 7" at
1024×600.

### Verified fact

`useDisplay` is a root export of `vuetify` 4.1.10, and `vuetify` is externalised to `DWC.Vuetify` by
DWC's `scripts/build-plugin.js` (`PLUGIN_GLOBALS`), so importing it works in the built bundle. DWC's
own components do exactly this — `FileList.vue:721`, `MacroList.vue:143`.

### Trap, named

**Do not import `@/composables/useLargeButtons`.** It is externalised at build time, but the test kit
has no stub for it — `node_modules/dwc-plugin-test-kit/src/aliases.mjs` lists every stubbed composable
and it is not among them — so importing it breaks every mount test. Read
`useSettingsStore().largeButtons` directly and **defensively**:
`(store as { largeButtons?: boolean }).largeButtons === true`. The real store has it (default `true`,
`DuetWebControl/src/stores/settings.ts:391`); the test kit's settings stub is an untyped bag and will
not, so the code must behave correctly when it is `undefined`.

### The work, in the order the screen actually fails

1. **`PostProcessorPage` at 800×480.** The browser pane is a hard `flex: 0 0 22rem` and the breakpoint
   is 960px, so it correctly stacks — and then the file list and the work pane split 480px of height
   and both scroll. Cap the stacked browser's height and make the work pane the one that grows.
2. **Five `v-tab`s plus a badge overflow at 800px.** Vuetify scrolls them, which hides the last two.
   Swap to a `v-select` below `mobile`, **or** add `show-arrows` — pick one and apply it. Do not leave
   both in.
3. **The toolbar's Preview / Apply / Cancel** carry text labels. Below `xs` make them icon-only with a
   `title`. **Never remove them** — a control that vanishes on a small screen is a bug, not a layout.
4. **`FileInspector`'s tables** (feature stats, objects, retractions, metadata) are the widest thing in
   the plugin. Each needs its own `overflow-x: auto` wrapper: the page body must never scroll sideways.
5. **`DiffPreview`** already has `overflow-x: auto` (`:6`) — leave it. Its line-number gutter is
   `min-width: 4.5rem` (`:16`), a quarter of a 480px column; reduce it below `sm`.
6. **Touch targets.** `density="compact"` throughout is right for a mouse and wrong for a finger. Where
   `largeButtons` is on *and* the breakpoint is small, relax to `default` — the same rule DWC's own
   `useLargeButtons` applies.

### Stop point

**Before writing six tests against it, find out whether `useDisplay`'s breakpoint can be driven under
the harness.** First step: one throwaway test mounting a trivial component that calls `useDisplay()`,
asserting `mobile.value` flips when the viewport changes. The test kit polyfills `matchMedia`
(CLAUDE.md lists it among the setup polyfills), but polyfilled is not the same as drivable.

**If it cannot be driven, do not mock Vuetify's internals to force it.** Restructure so the breakpoint
decision lives in a pure helper tested directly, cover the rest by CSS, and write that outcome into the
module comment. **Stop and report** if this changes the shape of Part G.

---

## H — E13, preflight as a gate

**The gap, and the correction.** See "A correction to what the user was told" above. `runChecks`
(`model/checks.ts:53`) runs in one place, `FileInspector.vue:324`, and its results are rendered and
dropped.

**The seam is already in the code and unused.** `FileInspector` declares
`defineEmits<{ analysed: [analysis: FileAnalysis] }>()` (`:274`) and emits it (`:463`) — and
`PostProcessorPage.vue:110` renders `<FileInspector v-if="tab === 'inspect'" :path="selectedPath" />`
**with no listener**. Somebody left the hook and never hung anything on it.

### Design decisions already made

- The page holds `lastPreflight: { path; checks } | null`, filled from `@analysed` and cleared by the
  existing `watch(selectedPath, ...)` at `:347` that already clears `lastRun` and `applied`.
- **`v-if` → `v-if="hasOpenedInspect" v-show="tab === 'inspect'"`.** A plain `v-show` would mount the
  inspector at startup for a user who never opens the tab; a plain `v-if` throws away the analysis on
  every tab switch. The guarded form does neither.
- **The gate is a setting, off by default.** Off because the checks are heuristic and a false positive
  that blocks a legitimate job is worse than a warning the user reads and overrides. Per-board (the
  recipe settings bag, `dwc/recipeStore.ts`'s pattern), not per-browser — it is a policy about this
  machine.
- When the gate is on and `checks` contains an `error`, `canApply` (`:320`) is false and
  `blockedReason` (`:322`) names the first one.
- **A file that has never been inspected does not block.** An un-run check is not a failed check. Say
  so in the UI ("not checked yet") rather than silently passing — the difference matters to someone
  relying on the gate.

### Tests

`test/component.test.ts`:

- gate on + an `analysed` payload containing an error-level check → Apply is disabled and the reason
  names the check
- the same payload with the gate off → Apply is unaffected
- gate on, file never inspected → Apply is not blocked, and the UI says it has not been checked
- switching files clears the previous file's preflight result (the same trap `lastRun` already has)

---

## Out of scope

- **H1 (hole detection), H5 (command palette), H6 (warp-risk notes), H16 (DWC's viewer).** Unchanged
  from task 15's out-of-scope list, for the same reasons. H1's stop point already ran and its answer
  was no. **Do not revive any of them here.**
- **Per-file recipe selection inside a batch.** One recipe per batch, deliberately (Part E).
- **Auto-run reacting to uploads made outside this browser tab.** `fileUploaded` is emitted by DWC's
  own store; a slicer uploading straight to the Duet never passes through it. The only alternative is
  polling `getFileList`, which is not worth the request traffic. **If this seems necessary, stop and
  report** rather than building a poller.
- **Dry-run history entries** (Part B).
- **Changing `processFile`'s signature, the `Transform` contract, the pipeline, or any step.** Every
  part here composes over `processFile` from outside. If a part seems to need one of these, **stop and
  report.**
- C4/C5/C6, B9–B15, A8 — still backlog, not this task.

## Acceptance criteria

- Each part's listed tests pass, and each **fails before its own change**.
- **No golden file changes anywhere in this task.** Nothing here adds a step, adds a preset, or touches
  a transform, so no golden can legitimately move. If one does, **stop and find out why** — that is the
  suite doing its job.
- All three gates, with `DWC_DIR=/c/Users/live/Documents/Github/DuetWebControl`:
  `npm test`, `npx dwc-plugin-typecheck`, `npx dwc-plugin-verify-build`.
- Part A's export→import regression test fails on the current tree and passes after.
- Part D's "the plugin's own uploads are ignored" tests pass for all three paths, and the script-step
  refusal test asserts `processFile` was **never called**, not merely that nothing was written.
- Part G's stop point is resolved before its tests are written, and its outcome recorded in the module
  comment.
- `docs/usage.md` gains sections for automatic recipe selection, auto-run on upload — **with the "this
  browser tab only" limitation stated plainly in the section body, not buried in a footnote** — batch
  processing, run history, the run report, and the preflight gate.
- `FEATURES.md`: A2, D4, D5, D6, D8, E13, F1, F2, F4 and F6 ticked with their module paths, matching
  how G1–G14 are recorded; **E8–E12 and F1's Phase cells corrected**; the top blurb's "Still
  outstanding" list updated.
- `docs/tasks/README.md`'s queue table gains a row for this task, with its stop point noted the way
  tasks 11–13 and 15 are.
