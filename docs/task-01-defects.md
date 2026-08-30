# Task 01 — pre-hardware defect pass

A self-contained work order. Everything needed to do this is in this file plus the repo; there is no
conversation history to recover.

**Read [CLAUDE.md](../CLAUDE.md) first** — particularly the four non-negotiables and the "Known
gotchas" section. They are binding here, not background.

## Why this task exists

v0.1.0 is built and green, but has never run against a real Duet. Three defects are visible from
code review, and all three are cheap to fix. Fixing them before the plugin meets a printer means the
first hardware session tests the interesting things rather than tripping over these.

Do them in order. Tasks 1 and 3 are small. Task 2 is the substantial one and contains a design
decision that has to be made properly, not worked around.

---

## Task 1 — the large-file warning fires too late

### The defect

`checkSafety` raises a `largeFile` warning above `LARGE_FILE_WARN_BYTES` (250 MB,
[constants.ts:36](../src/model/constants.ts)). The point of that warning is *"this will take a while,
leave the tab open"* — advice that is only useful **before** you start.

[`PostProcessorPage.vue:272`](../src/components/PostProcessorPage.vue) feeds it from
`lastRun.value?.bytesIn`, which does not exist until a run has finished. So the warning can only
appear after the user has already sat through the thing it was warning about.

Two compounding problems:

1. The size is never known up front, even though it is free — the directory listing already carries
   it, and `FileGateway.sizeOf()` already exists and is already being called in this component for
   the `targetExists` check.
2. Warnings are only rendered inside the Apply confirmation dialog. **Preview costs the same
   download and the same processing time as Apply**, so a warning that only appears on the Apply
   path is in the wrong place regardless of when it is computed.

### What to change

**a. Look up the source size when a file is selected.**

`PostProcessorPage.vue` already has a watcher that resolves `targetExists` by calling
`createGateway().sizeOf(target)`. Add a `sourceSize` ref alongside `targetExists` and populate it the
same way, from `selectedPath`. Keep the same defensive shape as the existing watcher:

- reset to `null` before the lookup, so a stale size never describes a newly selected file;
- guard on `machineStore.isConnected`;
- swallow the error (a failed listing is not evidence of anything) — do not surface it;
- **check the path has not changed again before assigning the result.** The existing watcher does
  this (`if (plannedTarget.value === target)`) and it matters: clicking through a folder quickly
  fires several overlapping lookups, and without the guard a slow earlier one lands last and wins.

**b. Prefer the measured size once a run has happened:**

```ts
sizeBytes: lastRun.value?.bytesIn ?? sourceSize.value,
```

**c. Surface warn-level issues before the run, not only in the dialog.**

In the action area at the bottom of the page (near the Preview/Apply buttons, above the existing
`blockedReason` line), render the `warnings` computed as compact alerts. The confirmation dialog
keeps its copy — seeing it twice on the Apply path is correct, because the dialog is the last
chance to stop.

Do not make warnings block anything. `blocking()` issues already gate Apply; warnings inform.

### Tests

In `src/__tests__/plan.test.ts` (`checkSafety` describe block) — the safety rules themselves are
already covered, so the new coverage belongs on the wiring:

- Extend `test/component.test.ts`: mount `PostProcessorPage` and assert that a warn-level safety
  issue is rendered in the page body, not only behind the dialog. The test kit's `setFiles` helper
  can seed a directory listing; check what shape it wants before assuming.
- If mounting with a large file proves awkward through the test kit, cover it by asserting the
  template renders `warnings` at all (e.g. with a mounted component whose `targetExists` warning
  fires) rather than skipping it. A rendering path with no test is how this defect got in.

### Acceptance

- Selecting a >250 MB file shows the size warning **before** either button is pressed.
- Selecting a small file shows no warning.
- Switching quickly between files never shows one file's warning against another's name.

---

## Task 2 — backups are in the wrong place and cannot be restored

### The defect

Two problems, one of which is a design gap rather than a bug.

**Location.** `WORK_DIR = "0:/gcodes/.postproc"` ([constants.ts:23](../src/model/constants.ts)).
Anything under `0:/gcodes` appears in DWC's Jobs list, so the plugin currently adds a folder to the
user's print list. The leading dot is not a hiding mechanism on FAT and DWC does not treat it as
one.

**Restoring is impossible.** `planOutput` names a backup `<stem>.<timestamp><ext>`
([plan.ts](../src/model/io/plan.ts)) and drops it in a flat directory. **The original path is never
recorded anywhere.** Given `benchy.20260830-112233.gcode` there is no way to know it came from
`0:/gcodes/prints/benchy.gcode` rather than `0:/gcodes/old/benchy.gcode`. A backup you cannot put
back is half a safety feature, and the half that is missing is the half that matters.

### What to change

**a. Move the working directory.**

```ts
export const WORK_DIR = "0:/postproc";
export const BACKUP_DIR = `${WORK_DIR}/backups`;
export const BACKUP_INDEX = `${WORK_DIR}/backups.json`;
```

A top-level directory on the volume: out of the Jobs list, and out of `0:/sys`, which belongs to the
machine configuration rather than to a plugin's working files. It is visible in DWC's Explorer, which
is where someone would go looking for it. Create it on demand — `makeDirectory` is already called
before the first backup upload and already tolerates "exists".

**Do not migrate existing backups** — anyone who has a `0:/gcodes/.postproc` from a dev build can
move or delete it themselves. Note the change in `docs/usage.md`.

Leave `tempPath` where it is (`<target>.pp.tmp`, next to the target). It has to be on the same
volume and directory for the temp-then-move to be a rename rather than a copy, and it exists for
seconds. Add a one-line comment in `plan.ts` saying so, so nobody "tidies" it into the work
directory later and silently turns every write into a full copy.

**b. Add a backup index (pure, in `model/`).**

New module `src/model/io/backups.ts`. This is the design decision: the index is what makes a backup
restorable, so it holds the original path.

```ts
export interface BackupEntry {
	/** File name within BACKUP_DIR. */
	file: string;
	/** Full path the backup was taken from — what Restore writes back to. */
	originalPath: string;
	/** ISO timestamp. */
	at: string;
	/** Size in bytes at the time of backup. */
	bytes: number;
	/** Recipe that was about to be applied, for the UI. */
	recipe: string;
}
```

Pure functions, all unit-tested directly:

- `parseIndex(json: string): Array<BackupEntry>` — tolerant. A missing, empty, truncated or
  malformed index must return `[]`, never throw. This file lives on an SD card that can be pulled
  mid-write; treat corruption as normal.
- `addEntry(index, entry): Array<BackupEntry>` — newest first.
- `pruneIndex(index, max): { keep: Array<BackupEntry>; drop: Array<BackupEntry> }` — keep the
  newest `max`, report the rest so the caller can delete their files. Add
  `export const MAX_BACKUPS = 20;` to `constants.ts`.
- `serialiseIndex(index): string`.

**c. Write the index when a backup is taken (impure, in `transfer.ts`).**

At [transfer.ts:240–244](../src/model/io/transfer.ts), where the backup is currently uploaded:
after the successful backup upload, read the index (`gateway.download(BACKUP_INDEX)`, catching the
"not found" throw and treating it as empty), add the entry, prune, upload the new index, and delete
the pruned backup files.

Rules for this — get them right, they are the point:

- **Failing to write the index must not fail the run.** The backup itself is already safely on the
  card. Catch, and record a warning through the existing `stats.warnings` channel so it surfaces in
  the report.
- **Delete pruned files only after the new index uploads successfully.** Losing the index and the
  files together is much worse than leaving orphaned files behind.
- Deleting a pruned file that has already gone is not an error.

**d. Add a restore UI.**

New `src/components/BackupManager.vue`, reachable from a new **Backups** tab on the page (next to
Recipe / Inspect / Preview). It lists the index — original path, when, size, recipe — and offers per
entry:

- **Restore** — writes the backup back to `originalPath`. This is a destructive write to a G-code
  file, so it goes through the *same* safety rules as everything else: confirmation dialog naming
  both paths, and **refuse if `originalPath` is the file currently printing** (reuse `samePath` and
  the job-file lookup in `dwc/machineSnapshot.ts` — do not write a second, weaker check). Restoring
  over a file that exists is the entire point, so "target exists" is not a blocker here.
- **Download** — hand the user the backup via `downloadBlob` from `dwc-plugin-runtime/download`.
- **Delete** — removes the file and its index entry.

Restore uses the same temp-then-move discipline as `processFile`: upload to `<target>.pp.tmp`, then
`move` onto the target. Do not shortcut it because the payload came from a backup.

If the index is empty or missing, say so plainly ("No backups yet — one is taken automatically
whenever you overwrite a file in place"), not with an error.

### Tests

- `src/__tests__/backups.test.ts` — every pure function. Explicitly: malformed JSON returns `[]`;
  a truncated file returns `[]`; pruning at the boundary (exactly `max` entries drops nothing);
  ordering is newest-first after `addEntry`.
- Extend `src/__tests__/transfer.test.ts` using the existing `FakeGateway`:
  - a successful in-place run writes both the backup file and an index entry naming the original path;
  - a run whose index upload fails still leaves the backup file present, still completes, and records a warning;
  - pruning past `MAX_BACKUPS` deletes the oldest files **and** only after the index write succeeded
    (make the fake fail the index upload and assert nothing was deleted).
- `test/component.test.ts` — `BackupManager` mounts with an empty index and shows the empty state.

### Acceptance

- Nothing the plugin creates appears in the Jobs list.
- Overwriting a file in place produces a backup **and** an index entry with the correct original path.
- The Backups tab lists them and Restore puts one back to where it came from.
- Restoring over the file currently printing is refused.
- After 21 in-place runs there are 20 backups and 20 index entries.

---

## Task 3 — the widget stamps a fake plugin version

[`PostProcessorWidget.vue:122`](../src/components/PostProcessorWidget.vue) passes
`pluginVersion: "0.0.0"`. It is harmless today because the widget only ever dry-runs and a dry run
writes no stamp — but it is a trap for whoever wires Apply into the widget later, and it would
produce files stamped with a version that never existed.

`PostProcessorPage.vue` has the correct implementation at `installedVersion()`
([line 434](../src/components/PostProcessorPage.vue)). Move it to `src/dwc/machineSnapshot.ts`
(which already owns object-model narrowing) as `installedPluginVersion(model): string`, and use it
in both components. Add a unit test: it returns `"0.0.0"` for a model with no plugins map, and the
version when one is present.

---

## Task 4 — PLAN.md's architecture section describes files that do not exist

§3 of [PLAN.md](../PLAN.md) still lists the *planned* layout: `components/RunReport.vue`,
`components/StepForms/*.vue`, `worker/processor.ts` and `model/steps/checks.ts`. None exist —
the run report folded into the page's result alert, one generic `StepFields.vue` replaced the
per-step forms, there is no worker (see the Status section, which is accurate), and the checks live
in `model/checks.ts`.

Update the tree to match `src/` as it actually is. Do not change the Status section or the
deviations list — those are correct. This is a five-minute fix that stops the next person trusting a
stale map.

---

## Out of scope — do not start these

Named explicitly because they are tempting while in these files:

- **The Web Worker.** Exploratory (does Vite's `?worker&inline` survive DWC's rolldown lib build?)
  and needs a judgement call about when to abandon. Separate task.
- **expr-eval, quickjs-emscripten, Pyodide.** See `docs/scripting-engines.md`. New dependencies,
  separate decisions.
- **Auto-run on upload, batch processing, block-mode find/replace.** Features, not defects.
- **Anything on real hardware.** Cannot be done from here.

---

## Working rules

**Verify with all three gates before committing.** The unit tests alone do not catch the failures
that matter:

```bash
npm test
DWC_DIR=/path/to/DuetWebControl npx dwc-plugin-typecheck
DWC_DIR=/path/to/DuetWebControl npx dwc-plugin-verify-build
```

On this machine `DWC_DIR=/c/Users/live/Documents/Github/DuetWebControl`. All three pass on `main`
today, so any failure is from this task.

**Golden files.** `test/golden/*.gcode` are committed expectations. If a change alters them,
`npx vitest run -u` regenerates — but **read the resulting diff line by line before committing it**.
A golden diff is either a bug you just introduced or a fix you can explain. None of the four tasks
above should change a single golden file; if one does, stop and work out why.

**House style.** Tabs, double quotes, `Array<T>` over `T[]`. Match the density of the surrounding
comments: explain *why*, never restate the code. Keep transformation logic pure and in `model/`;
`.vue` files render and delegate.

**Commits.** One per task, imperative subject, body explaining the failure being fixed rather than
the code being added. End with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

**If a task turns out to be wrong.** These were identified by reading the code, not by running it.
If Task 1's `sizeOf` turns out not to work through the store for a reason that is not obvious, or
Task 2's index design collides with something, say so and stop rather than building a workaround —
a wrong fix in the safety layer is worse than the defect.
