# `dwc-gcode-core` — package outline, migration plan, and what to feed back upstream

**Status: 2026-09-14.** Phase 0 (scaffold) is done, and within Phase 1: `lex`/`params`/
`commands/g10`/`commands/toolParams` are extracted from the post-processor, their command-number
scanning is now fully verified against RRF source (bare letter, negative sign, single-digit fraction,
`T{expr}` — see Decisions #4), and the full-dictionary corpus test (3a) is in place — 343 tests, all
three of the package's own gates green. All of this is in a **local-only repo** at
`C:\Users\live\Documents\Github\dwc-gcode-core` — no GitHub remote, nothing published to npm. **Not
started:** rewriting the post-processor's ~25 call sites to use the package (the rest of Phase 1),
`meta`, `edit`, `firmware`, and every later phase. It follows
the exploration of whether one shared G-code parsing core, kept faithful to RepRapFirmware and tagged
at RRF releases, should replace the parsers the plugins in this family have each grown. The answer was
yes, with limits, and this document turns it into a plan.

## Why — the facts this rests on

Everything below was verified against the current checkouts on 2026-09-11. The meta-command keyword
list, its recognition rule, the indentation rule, and the command-number scanning gaps under
Decisions #4 (bare letter, negative sign, single-digit fraction, `T{expr}`) were verified directly
against RRF 3.7.0-rc.1 source on 2026-09-14, and the latter are fixed and tested in the package.

- **Four G-code readers, three behaviours for the same operation.** `setParam` exists three times:
  - **duet-gcode-postprocessor** `src/model/gcode/tokenise.ts` replaces *any* value form, on a body
    whose comment has already been split off.
  - **resonance-lab** `src/config/gcodeEdit.ts` (229 lines) matches only a plain number
    (`-?[0-9]*\.?[0-9]+`), so it silently *appends a duplicate* when the existing value is a colon
    list or an expression.
  - **duet-calibration-wizard** `src/model/gcodeEdit.ts` (321 lines) matches numeric colon lists.

  The two `gcodeEdit.ts` files are a copy that diverged: 89 identical lines and the same ten exports,
  with calibration adding five more.
- **dwc-config-backup-core** `src/sanitise.ts` recognises `set global.` and `var` assignments with its
  own regexes (`LEADING_CODE_RE`, `ASSIGNMENT_RE`, `IS_GLOBAL_RE`) — a fourth partial reader.
- **Both gcodeEdit copies refuse any line containing `{…}` or flow control** ("unsafe"). That is
  correct as a safety rule, but it comes from a heuristic, not from a model of RRF syntax.
- **The same class of semantic bug appeared three times in one repo.** In the post-processor, `G10`'s
  three forms (retract, tool settings, workplace offsets) were misread independently in
  `analysis.ts`, `travel.ts`, `toolRenumber.ts` and `preheat.ts`, until one shared reader
  (`toolTemperature.ts` → `g10Form`, `readToolTemperatureSetting`) fixed them all. That is the argument
  for the core in miniature.
- **RRF's own parser is large, but its syntax changes slowly.**
  - Sizes: `StringParser.cpp` is 2,110 lines and `ExpressionParser.cpp` 2,443 lines.
  - Every release touches `src/GCodes/GCodeBuffer/`, but between 3.6.3 and 3.7.0-rc.1 only two
    commits changed syntax: `^` array concatenation, and string expressions for IP/MAC addresses.
  - Tags are plain (`3.6.3`, `3.7.0-rc.1`).

## Decisions already made (and why)

1. **A separate npm package, `dwc-gcode-core`, not a subpath of `dwc-plugin-runtime`.**
   - Its release cadence follows RRF tags; the runtime's follows DWC.
   - Most of the runtime's 13 dependants never parse G-code.
   - `dwc-config-backup-core` sets the precedent for a sibling core package.
2. **Bundled into each plugin, not shared at runtime.**
   - A DWC plugin is a single IIFE; the only way to share one instance is for DWC to externalise it
     through `window.DWC` (see the feedback section).
   - Until then each plugin carries its own copy, at the version it was tested against. For a pure
     parser that is a feature, not a flaw.
3. **Pure TypeScript, zero runtime dependencies, no Vue, no `@/…` imports.**
   - It builds with plain `tsc` to ESM with `"sideEffects": false`, so a plugin that uses only the
     lexer carries only the lexer.
4. **Parity means two different things, handled differently — and "syntax" itself splits in two.**
   - **G/M/T command syntax** — recognising *that* a line is a command, and splitting it into letter,
     number and parameters — must cover **every** G/M/T command RRF accepts, current and future, not
     a curated subset. This is achievable in full because RRF's line grammar is command-agnostic
     (`StringParser`'s tokeniser doesn't special-case which command it just read), and it is proven,
     not assumed: every one of `@duet3d/monacotokens`' 276 dictionary entries has a corpus test
     asserting `tokenise()` extracts its letter and number correctly (see Test strategy). **Done**,
     in the scaffolded package — this caught three real gaps, all fixed by reading RRF's actual
     command-number scan (`StringParser::ParseInternal`, RRF 3.7.0-rc.1) instead of assuming from the
     dispatch tables or the wiki:
     - A command letter with **no digits at all is still a command**, not "not a command" — `tokenise`
       used to return `code: null` for a bare `T`, but `T` alone is real and documented
       (`Duet3D/wiki-content`'s `## T: Select Tool`: "report the current tool number").
     - **A leading `-` is read for any of G, M or T**, not just T — this was the original finding
       (`T-1`, "deselect all tools"), but source shows the scan itself doesn't special-case which
       letter it follows; no current RRF command number is negative besides `T-1`, but the grammar
       doesn't know that, and neither should the tokeniser.
     - RRF reads **at most one fractional digit** (`commandFraction` is a single digit, not a decimal
       scan) — `G38.2` is 38 + fraction 2; a hand-edited `G38.25` is read by the firmware as `G38.2`
       with a stray `5` left over, not as the number 38.25. No current command has a two-digit
       fraction, but the fix matches the firmware instead of guessing.
     - One more, found as a consequence of the first fix, not separately: **`T{expr}` is a special
       case in source** — read as if it were `T T{expr}`, i.e. the bare `T` command with the brace
       expression as a `T` *parameter*. This is exactly the wiki's own example
       (`T T{state.currentTool + 1}`), and `parseParams`'s existing command-skip logic already
       produced this reading by construction once the bare-letter fix was in place — confirmed with
       a test, not assumed.
   - **Conditional G-code (`meta`)** — RRF's `if`/`var`/`set`/… keywords — is also full syntactic
     coverage, not curated: all twelve keywords RRF's parser recognises, not a subset. See the `meta`
     module below.
   - **Command *semantics*** — what `G10 P1 S200` *does* — is the one place a curated table is right:
     one entry per command form, **each entry citing the RRF source and the wiki**. Nobody tries to
     mirror all 276 commands' behaviour, only what a consuming plugin actually needs to act on.
5. **No expression evaluation.**
   - The core recognises `{…}` spans, including nesting and strings inside them, and preserves them
     byte-for-byte. It does not evaluate them: that needs the live object model and RRF's
     `ExpressionParser`, and a wrong answer is worse than "this line has an expression".
6. **Not compiling RRF's C++ to WASM.**
   - The parser is tangled with `GCodeBuffer` state, the object model and platform code. Extracting it
     would be a fork to maintain forever.
7. **Firmware-version gating is data, not branches.**
   - A feature table records `{ id, since, source }`, and callers ask `supports(version, "m568")`.
   - The version comes from `boards[0].firmwareVersion`.
   - Known entries:
     - expressions — 3.01;
     - `M568` — 3.3;
     - lowercase axis letters — 3.4;
     - `^` concatenation — 3.7.

## Package outline

```
dwc-gcode-core/
├── src/
│   ├── index.ts            re-exports the stable surface
│   ├── lex.ts              line → spans; no allocation beyond the result
│   ├── params.ts           parameter parsing, reading and rewriting on a command body
│   ├── meta.ts             RRF meta-commands and assignments
│   ├── edit.ts             line-preserving edits to config files (the merged gcodeEdit)
│   ├── commands/
│   │   ├── g10.ts          g10Form, readToolTemperatureSetting (moved from the post-processor)
│   │   ├── toolParams.ts   which commands' P/T are tool numbers (TOOL_PARAM_COMMANDS, moved)
│   │   └── axes.ts         axis letters, M584 extra axes, lowercase quoting
│   ├── firmware.ts         parseFirmwareVersion, compareRrf, FEATURES, supports()
│   └── rrf.ts              RRF_BASELINE = "3.7.0-rc.1" and the citation format
├── dictionary/             OPTIONAL subpath over @duet3d/monacotokens' gcodes.json (195 KB, 23 KB gz)
├── test/
│   ├── corpus/             real config.g, macros and slicer headers from the plugins in this family
│   └── *.test.ts
├── scripts/rrf-triage.mjs
└── docs/rrf-triage/        one reviewed checklist per RRF tag pair
```

### Module surface

| Module | Exports | Comes from |
| --- | --- | --- |
| `lex` | `Tokenised`, `tokenise`, `findCommentIndex`, plus **new** span data for `N…` line numbers, `*` checksums, quoted strings (with `""` escapes) and `{…}` expressions | post-processor `tokenise.ts` (273 lines, allocation-light — moved, not rewritten) |
| `params` | `ParsedParam` (gains `kind: "number" \| "list" \| "string" \| "expression" \| "bare"`), `parseParams`, `paramNumber`, `paramNumberList`, `findParam`, `setParam`, `removeParam`, `withBody`, `formatNumber`, `unquoteString`, `axisLetter` | post-processor `tokenise.ts`; `axisLetter` matches DWC's `axisGCodeLetter` |
| `meta` | `classifyLine` → `{ kind: "command" \| "meta" \| "comment" \| "blank"; meta?: MetaKeyword; indent }`, `MetaKeyword`, `parseAssignment` | **new**; replaces config-backup-core's three regexes and gcodeEdit's `unsafe` heuristic |
| `edit` | `GcodeLine`, `detectEol`, `parseLines`, `serializeLines`, `findDirectives`, `setParam`, `setIndexedParam`, `replaceDirective`, `appendDirective`, `replaceLine`, `diffLines`, `planDirectiveEdit`, `findIncludes`, `resolveIncludePath`, `planDirectiveEditAcrossFiles` | calibration-wizard's superset of resonance-lab's |
| `commands/*` | `g10Form`, `G10Form`, `readToolTemperatureSetting`, `ToolTemperatureSetting`, `TOOL_PARAM_COMMANDS`, `AXIS_LETTERS` | post-processor `toolTemperature.ts` (115 lines), `toolRenumber.ts` |
| `firmware` | `parseFirmwareVersion`, `compareRrf`, `FEATURES`, `supports` | **new** |

**Staying in the post-processor:** `state.ts`, `metadata.ts`, `dialect.ts`, `features.ts`,
`timeModel.ts`, `arcFit.ts`, `voids.ts`, `exprEval.ts`. They model slicer output and motion, not RRF
syntax, and moving them would tie the core's releases to one plugin.

### One behaviour to settle before merging: `setParam`

The three implementations differ on purpose, so the merge must keep each property rather than pick a
winner:

- **Body level (`params.setParam`)** stays value-agnostic, as the post-processor needs. It rewrites
  whatever value is there.
- **Line level (`edit.setParam`)** returns `{ line, refused?: "expression" | "meta" | "string" }`.
  - It refuses a line classified as `meta`, and refuses an existing value whose `kind` is
    `"expression"`.
  - It otherwise replaces numbers *and* colon lists, which fixes resonance-lab's duplicate-append case.
  - Callers that treated a refusal as "unsafe" keep doing so.

**Characterisation tests come first.** Record each current implementation's output on the same input
table, then write the merged one. Any row whose result changes must be a deliberate, listed change,
never a surprise.

### Versioning and RRF tracking

- **Package semver is independent.** Breaking API changes bump the major. A new RRF baseline is a minor
  when it only adds recognition, and a major when an existing classification changes.
- **Two tag families on the same repo:**
  - `vX.Y.Z` — npm releases;
  - `rrf-<tag>` (e.g. `rrf-3.7.0-rc.1`) — points at the commit whose parity review covers that RRF tag.
  - `RRF_BASELINE` and `package.json` `"rrf": { "baseline": "3.7.0-rc.1" }` state the same thing in code.
- **`scripts/rrf-triage.mjs <from> <to>`:**
  - calls `gh api repos/Duet3D/RepRapFirmware/compare/<from>...<to>`;
  - keeps only commits that touch `src/GCodes/GCodeBuffer/` or `src/GCodes/GCodes*.cpp`;
  - writes `docs/rrf-triage/<from>..<to>.md` as a checklist.

  Each item is closed as one of: *no effect on syntax*, *feature added (FEATURES entry + test)*, or
  *semantic table updated (entry + citation + test)*. Only a fully closed checklist earns the `rrf-`
  tag.
- **A weekly scheduled workflow** checks for RRF tags newer than the baseline and opens an issue
  carrying the triage output. Nobody has to remember to look.
- **Citations have one format:** `RRF 3.6.3 src/GCodes/GCodes2.cpp case 10`, plus the wiki anchor. A
  semantic entry without one fails a lint test.

### Test strategy

1. **Port what exists:**
   - the post-processor's tokeniser and toolTemperature tests;
   - resonance-lab's `test/gcodeEdit.test.ts`;
   - calibration-wizard's `retraction-speed-config.test.ts`. calibration has no unit test of its own
     gcodeEdit, so its five extra exports get tests during the move.
2. **Corpus round-trip:** `serializeLines(parseLines(x)) === x` byte-for-byte, CRLF included, for every
   file in `test/corpus/`. Start from the fixtures the plugins already carry: the post-processor's six
   slicer files, and the sample configs in the calibration and resonance repos.
3. **Lexer properties:**
   - fuzz lines with random quotes, doubled quotes, braces and semicolons;
   - assert a comment never starts inside a string or an expression;
   - assert spans always tile the line.
3a. **Full-dictionary command-recognition corpus — this is what "covers all G/M/T commands" means in
   practice, not an aspiration. Done.** `test/corpus/rrf-command-codes.json` snapshots every `code`
   from `@duet3d/monacotokens`' `gcodes.json` (276 entries; refresh instructions live next to it), and
   `test/dictionary.test.ts` asserts `tokenise()` reads each one's letter/number correctly, bare and
   with parameters attached — not `null`. Re-run (and refresh the snapshot) every time `RRF_BASELINE`
   moves, so a future RRF command with a syntax this tokeniser can't yet see fails loudly instead of
   silently returning `code: null`. This test is what caught the three gaps under Decisions #4 above;
   `test/commandNumber.test.ts` holds the targeted regression tests for each (bare letter, negative
   sign on any of G/M/T, single-digit fraction, the `T{expr}` redirect).
4. **Teeth checks,** this repo's rule: every test for a behaviour must fail when that behaviour is
   broken.
5. **Downstream acceptance:** each migrating plugin's own suite passes unchanged. The post-processor's
   golden files are the strongest net — **zero golden diff** is the bar for phase 1.

## Migration plan

The phases are ordered so each move lands under the heaviest test net available.

### Phase 0 — scaffold (no consumer changes)

- Create `jaysuk/dwc-gcode-core` shaped like `dwc-config-backup-core`:
  - `tsc -p tsconfig.json` build and a `prepare` script;
  - an `exports` map per module, and `files: ["dist", "src", …]`;
  - `test.yml`, plus a `release.yml` like `dwc-plugin-runtime`'s.
- Publish `0.1.0` to npm when phase 1's code is in.

### Phase 1 — extract from the post-processor (it moves first because it has golden files)

- **Move into the package:** `tokenise.ts` → `lex` + `params`; `toolTemperature.ts` → `commands/g10`;
  `TOOL_PARAM_COMMANDS` → `commands/toolParams`. Done in the local-only scaffold — see Status.
- **The three command-number gaps under Decisions #4 — done.** `lex.ts` and `params.ts`'s command-skip
  logic both now match `StringParser::ParseInternal` exactly (bare letter, negative sign on any of
  G/M/T, single fractional digit, the `T{expr}` redirect), proven by the 3a corpus test plus targeted
  regressions in `test/commandNumber.test.ts`. This also fixed two stale assertions in the tests moved
  from the post-processor (`tokenise.test.ts`'s "does not treat a bare letter as a command" and
  "reads a tool change" both encoded the old, wrong behaviour — `tokenise("T-1").code` was asserted to
  be `null` with the comment "the minus is not a digit"). 343 tests pass; all three of this package's
  gates (`npm test`, `npm run typecheck`, `npm run build`) are green.
- **Rewrite the call sites directly:** 20 imports of `tokenise`, 5 of `toolTemperature`. No re-export
  shim, which would hide which code is where. Not started.
- **Acceptance:**
  - all 1,140 tests pass;
  - zero golden diff;
  - all three gates green, plus the vue-tsc replica described in `docs/tasks/README.md`;
  - the bundle size recorded before and after.
- **Trap:**
  - `dwc-gcode-core` must be a `dependencies` entry.
  - CI's shared workflow (`dwc-plugin-ci.yml` line 83) and `release.yml` install `dependencies` into
    the DWC checkout, so CI resolves it.
  - Locally it has to be installed there by hand, the same as `expr-eval-fork` — see the memory note's
    `SPECS=…` line.

### Phase 2 — merge the two `gcodeEdit`s

- First, add characterisation tests in both repos against their current code.
- Build `edit` from calibration-wizard's superset, then settle `setParam` as above.
- Migrate calibration-wizard: `src/dwc/configFile.ts` and the retraction-speed test.
- Migrate resonance-lab: `accelWiring.ts`, `machineConfig.ts` and `test/gcodeEdit.test.ts`.
- Delete both local copies.

### Phase 3 — meta-commands (conditional G-code) and expressions

RRF's macro/config-file language — `if`/`var`/`while`/… — is a second grammar layered on top of
G/M/T commands, handled by a completely different code path in the firmware
(`StringParser::ProcessConditionalGCode`, checked directly against RRF 3.7.0-rc.1 source rather than
inferred from the wiki, which doesn't document the recognition rule at this level of precision). This
matters most for exactly the files a `dwc-gcode-core` consumer is most likely to open outside a
slicer's own output: `config.g`, homing macros, tool-change macros — `/sys` and `/macros` content is
disproportionately meta-commands, not motion commands.

**The complete, source-verified keyword list — all twelve, not a curated subset:**
`if`, `var`, `set`, `echo`, `skip`, `else`, `elif`, `while`, `break`, `abort`, `global`, `continue`.
(`skip` is recognised and consumed but does nothing — `ProcessConditionalGCode`'s `case 4` returns
`true` for it with no further action. `classifyLine` must still report it as `meta`, not `command` or
unrecognised, or a caller building on top of it will treat a no-op keyword as garbage.) There is no
`return` keyword — RRF's conditional G-code has no such thing; don't invent one.

**The exact recognition rule** (`ProcessConditionalGCode`, RRF 3.7.0-rc.1): count leading **lowercase**
`a`–`z` characters (max 8 — "all command words are less than 9 characters long"), then check the
following character is line-end, space, tab, `{`, `"` or `(`. Two consequences worth stating plainly:
- **Case-sensitive.** `If`/`IF`/`VAR` are not meta-commands — unlike G/M/T commands, which RRF reads
  case-insensitively. A line starting `If sensors...` is not conditional G-code to RRF; `classifyLine`
  must agree, not "helpfully" normalise case.
- **Word-length dispatch, not a regex alternation** — the firmware switches on the counted length
  (2/3/4/5/6/8) before comparing text, which is why `if`+`var`+`set` (2/3/3) and `while`+`break`+
  `abort` (5/5/5) group the way they do in source. `classifyLine` doesn't need to replicate the
  `switch`, just the outcome: the twelve words above, nothing else, case-sensitive, properly
  terminated.

**Indentation is meaningful and its counting rule is exact**, computed *before* the command word
starts (`StringParser`'s `parseNotStarted` state, same RRF source): each leading space adds 1 to
`commandIndent`; each leading tab rounds it up to the next multiple of 4
(`commandIndent = (commandIndent + 4) & ~3`). `classifyLine`'s `indent` field must use this exact rule,
not "count characters" or "count only spaces" — a macro mixing tabs and spaces (which RRF itself warns
about, `CheckForMixedSpacesAndTabs`) would otherwise misreport nesting depth.

**Work:**
- Land `meta` (`classifyLine`, `MetaKeyword`, `parseAssignment`) and the `lex` expression spans.
- **Corpus test:** every real `config.g`/homing macro already sitting in this repo's and the sibling
  repos' fixtures, asserting `classifyLine` never reports a real meta line as `command` and never
  reports a real G/M/T line as `meta`.
- resonance-lab and calibration swap the `unsafe` heuristic for `classifyLine`. They still refuse
  meta lines and expression values, but now for the precise reason, which the UI can show.
- `dwc-config-backup-core` replaces its three regexes with `parseAssignment`. It is a library, so
  `dwc-gcode-core` becomes its dependency, and Flexible-Layouts and duet-config-backup-plugin pick it
  up through it.

### Phase 4 — semantic table and firmware gating

- Land `firmware` and the cited semantic entries.
- The post-processor reads `boards[0].firmwareVersion` so that, for example, `restartFrom` warns before
  emitting `M568` for a board older than 3.3.

### Not migrating

- **tool-align and ClosedLoop** only call `sendCode`.
- **Flexible-Layouts** parses heightmap CSV, not G-code.
- **gcodeviewer**'s Rust/WASM line processor is optimised for rendering moves. Learn from its G0/G1
  fast path; do not share code with it.

## What to feed back upstream

These are ranked by what they cost everyone now, not by who owns the repo. Items 1–3 are bugs; the
rest remove workarounds.

### Bugs — cheap to fix, and they bite silently

1. **DWC `scripts/build-plugin.js` never type-checks on Windows, and reports success anyway.**
   - Line 498 launches `node_modules/.bin/vue-tsc` with a bare `spawnSync` (lines 498–499). On Windows
     that is `ENOENT`, and `result.error` is never checked.
   - Empty output means no plugin errors, so the script prints "Type check passed". Verified with
     planted errors; this is how the v1.2.0 release build broke in CI after every local gate passed.
   - **Fix (two lines):** launch `process.execPath` with vue-tsc's JS entry — portable, and no shell
     quoting to get wrong — and treat `result.error` or `result.status === null` as a failure.
   - This is a PR to Duet3D/DuetWebControl through the `jaysuk/DuetWebControl` fork. It helps every
     Windows plugin author.
2. **`dwc-plugin-test-kit` `bin/typecheck.mjs` leaks its temporary copy into the DWC checkout.**
   - It copies the plugin to `src/plugins/_typecheck_<ts>` and removes it in `finally`, which does not
     run when the process is killed (Ctrl-C, a tool timeout, `taskkill`).
   - There are two such directories in the checkout right now: `_typecheck_mtwrdbwb` (2.4 MB, 09:33,
     another plugin) and `_typecheck_mtwyti9x` (841 KB, 13:01, this one). Git does not ignore them.
   - They sit inside DWC's `src/**`, so **every later type check compiles them as well** — noise at
     best, and stale copies of old code at worst.
   - **Fix:**
     - on start, sweep `_typecheck_*` directories older than an hour;
     - add `SIGINT`/`SIGTERM` handlers that remove the copy.
3. **`dwc-plugin-typecheck` skips test files** (`isTest`, `typecheck.mjs` line 37), so locally nothing
   type-checks `test/` or `src/__tests__/`, while CI's verify-build does. Either include tests by
   default or add `--include-tests`, and say which in the kit's README.

### The test kit — remove the workarounds every plugin repeats

4. **Let `MountDwcOptions` pass through `@vue/test-utils` mount options** (`attachTo`, `shallow`,
   `stubs`…), for example `Omit<MountingOptions<…>, "props" | "slots" | "global">`, forwarded to
   `mount()`. Today, lines 21–26 accept only `props`/`slots`/`global`, so `attachTo` is a silent no-op
   at runtime and TS2353 in CI.
5. **Stubs for what DWC really exposes:**
   - `settingsStore.registerPluginData`/`setPluginData` — the settings stub has neither, so plugins
     seed a fake `dwc.settings.plugins` bag in every mount test;
   - `@/composables/useLargeButtons`;
   - `registerEmbeddableComponent`/`unregisterEmbeddableComponent` in the `@/plugins` stub.
6. **A working `localStorage` in `setup.ts`.** Under happy-dom it is non-functional, and several
   plugins fall back to it for settings.
7. **Resolve the plugin's own bundled dependencies in `typecheck` and `verify-build`.** At least, run
   the same `npm install --no-save $SPECS` into the DWC checkout that CI does, and say it did so.
   Today, any unrelated `npm install` in the checkout prunes them, and the next typecheck fails with
   `Cannot find module` for reasons that have nothing to do with the plugin.

### DWC — small API asks that help every plugin

8. **Say who started an upload in `fileUploaded`.**
   - The payload (`src/utils/events.ts:131`, emitted at `src/stores/machine.ts:754`) carries
     `filename`, `content`, `num`, `count` and display flags, but not the initiator.
   - Add `origin?: string` (a plugin id, or absent for the user) and let the upload call accept it.
   - The post-processor's auto-run currently excludes its own uploads by path. Config-backup's nudges
     have the same problem.
9. **Externalise `dwc-gcode-core` once it has proven itself.** If DWC takes the package as a
   dependency and exposes it through `PLUGIN_GLOBALS` (for example, growing `@/utils/gcode` →
   `DWC.Gcode`, which today holds only `axisGCodeLetter`), plugins get one instance, versioned with the
   DWC release they run on. That is the only route to a genuinely shared runtime parser, and it is
   worth proposing only after phases 1–3 have shipped.
10. **Already done, for the record:** `@/utils/monaco` is now externalised as `DWC.Monaco`
    (`build-plugin.js` line 82). It was on this list and has landed. That unblocks the post-processor's
    Monaco-based editor ideas (H5, the command palette); check the exported API before building on it.

### `@duet3d/monacotokens` — make the dictionary machine-usable

11. **Add version and parameter-kind fields to `gcodes.json`.**
    - Add `since`/`until` firmware versions per command and per parameter; today only 5 of the 276
      entries mention a version, and only in prose.
    - Add a parameter `kind`: tool number, heater, fan index, colon list, expression allowed.
    - DWC's own editor could then flag a command the connected board doesn't support, and
      `dwc-gcode-core`'s `dictionary` subpath would need no hand-kept duplicate. Offer the
      `rrf-triage` output as the source for keeping it current.

### RRF (a long shot)

12. **Label syntax changes in RRF release notes.** A consistent marker on commits or notes that change
    what the G-code parser accepts would turn triage from reading diffs into reading a list. The two
    3.7 changes (`^` concatenation, string expressions for IP/MAC) are the examples to point to.
