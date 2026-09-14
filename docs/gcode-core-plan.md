# `dwc-gcode-core` — package outline, migration plan, and what to feed back upstream

**Status: 2026-09-14. Phases 0, 1 and 2 are all done.** `dwc-gcode-core` is a real public repo,
`github.com/jaysuk/dwc-gcode-core`, at `v0.2.0` (tagged and released; not on npm yet — every consumer
uses a `github:` dependency). It holds `lex`/`params`/`edit`/`commands/g10`/`commands/toolParams`,
extracted from the post-processor (Phase 1) and the two `gcodeEdit` copies merged from resonance-lab
and duet-calibration-wizard (Phase 2) — command-number scanning fully verified against RRF source
(Decisions #4), 383 of the package's own tests, all its own gates green. **All three consuming repos
are migrated**: duet-gcode-postprocessor (~30 call sites, 1,089 tests), resonance-lab (`accelWiring.ts`/
`machineConfig.ts`, 264 tests, plus a DWC-3.6-build vendoring fix), duet-calibration-wizard
(`configFile.ts`, 92 tests) — each with zero golden-diff/regression, both DWC-checkout gates green,
and a by-hand `vue-tsc` replica confirming zero errors in that plugin's own files including tests.
Each migration is **committed locally, not pushed** (pushing wasn't asked for). **Not started:**
`meta`, `firmware`, and Phase 3's consumer-side work (resonance-lab/calibration swapping their
`unsafe` heuristic, dwc-config-backup-core's own migration) — including publishing `dwc-gcode-core`
to npm proper, which stays a `github:` reference until that's separately decided. It follows
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
   - **Don't build `firmware.ts` from scratch — a real, battle-tested implementation already exists,
     twice, and has already diverged once** (found 2026-09-14, while looking into the file-stamping
     feature below): `resonance-lab/src/config/firmwareVersion.ts` and
     `duet-calibration-wizard/src/model/firmwareVersion.ts` (a copy of it, per that repo's own file
     header). Both parse `parseFirmwareVersion`/compare `compareFirmwareVersions`/gate
     `firmwareAtLeast`, and both already handle real RRF quirks worth not re-discovering: the STM32
     port's parenthesised suffix (`3.7.0-rc.1(CAN0)`, with a *space* before the paren despite RRF's
     own header comment claiming otherwise) must be stripped before parsing, or every STM32H7 board —
     the main phase-stepping platform — reports an unparseable version and a fail-closed gate hides
     the feature from exactly the hardware it targets. **The divergence**: resonance-lab's copy later
     grew a `ParsedVersion.build` field and a matching tiebreaker step in `compareFirmwareVersions`,
     for RRF's `+N` suffix (`"3.7.0-rc.1+1"`) — real semver build metadata, which semver itself defines
     as precedence-*neutral*, but which Duet3D is using as a genuine sequential counter within one
     prerelease tag instead (confirmed by diffing `Version.h` across two consecutive firmware commits,
     both bumping only that number). calibration-wizard's copy never got this back-ported, so it
     silently treats `"3.7.0-rc.1"` and `"3.7.0-rc.1+1"` as equal — latent today (it doesn't currently
     gate on anything at that resolution), exactly the same shape of bug as `setParam`'s colon-list gap
     in Phase 2's merge. **Merge this into `dwc-gcode-core/firmware` the same way**: resonance-lab's
     version is the base (it's the superset), characterisation tests ported from
     `resonance-lab/test/firmwareVersion.test.ts` first, then both consumers migrated.
   - **A future feature needs this to be a real range comparator, not just a single-version
     boolean gate** — see "File-stamp diffing" below. `compareFirmwareVersions` already returns a
     full three-way result (`-1`/`0`/`1`), which is the right shape for this (a boolean
     `firmwareAtLeast` alone would not be); the `FEATURES` table itself is the part that needs a
     new query, not just `supports(version, id)`, to answer "everything that changed between A and
     B" rather than "does version V have feature X".

### File-stamp diffing — a concrete future consumer of `firmware`, not yet designed in detail

The user's own words (2026-09-14): each G-code/macro/filament file gets stamped with the RRF version
it was last checked against (a header comment, most likely — the exact stamp format is not decided
yet). When the firmware changes — **upgrade or downgrade**, both must work — re-checking a stamped
file diffs the stamped version against the board's current one and reports what's relevant to *that*
file: which commands/parameters in it started being interpreted differently, stopped existing, or
started existing, between those two versions.

**Constraints already given, to hold onto rather than rediscover:**
- **Floor: RRF 3.6.3.** Nothing older is supported for this feature. `compareFirmwareVersions` already
  parses and compares a plain `"3.6.3"` (no prerelease) with no special-casing needed — the floor is a
  product decision (where to stop rather than bothering with older lines), not a parser limitation.
- **Bidirectional.** A user can move to a newer firmware or roll back to an older one (a bad update,
  a hardware-specific regression) and must get a correct answer either way. This is why the plan above
  insists on a real three-way comparator as the foundation, not a `since`-only "is this new enough"
  check — the same `FEATURES` table has to answer the question run as `min(stamped, current)` to
  `max(stamped, current)` regardless of which one is actually newer.
- **Per-file, not per-machine.** The stamp lives in the file itself, so the check is "what in *this
  specific file's own content* is affected", not a blanket "what changed in this firmware release" —
  which means the real query is closer to *"of the commands/parameters this file actually uses, which
  ones have a `FEATURES`/semantic-table entry whose `since` falls in (min, max]"* than a global diff.
  This is squarely why the semantic table (Decision #4) and the parser's syntax coverage (also
  Decision #4) both need to be as complete as practical **before** this feature is worth building —
  a diff against a table that only covers 5 commands would silently miss almost everything.

**Not yet designed:** the stamp's exact format and where it's read/written from (a job for the
consuming plugin, likely `duet-gcode-postprocessor`, not this package); the shape of the "what changed
for this file" query itself (`changesAffecting(fileTokens, from, to): Array<FeatureChange>`, or
similar — a real API design pass, not sketched here); whether "downgrade" ever needs to *warn* about a
feature the file uses that the *older* firmware doesn't have (almost certainly yes — that is in fact
the more dangerous direction, silently sending a command the rolled-back firmware doesn't understand).
Tracked here so Phase 4's `FEATURES` table is built with this consumer in mind rather than redesigned
again once it exists — every entry should already be planning to answer "since when", which a
`supports()`-only design does not encourage as clearly.

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
| `firmware` | `parseFirmwareVersion`, `compareFirmwareVersions`, `firmwareAtLeast`, `ParsedVersion`, plus **new** `FEATURES`/`supports` | resonance-lab's `firmwareVersion.ts` (the newer of two diverged copies — see Decisions #7) |

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
- **Rewrite the call sites directly — done.** No re-export shim. 30 files touched in the end, not the
  originally-guessed 25 (the extra ones are files inside `model/gcode/` itself — `exprEval.ts`,
  `state.ts`, `timeModel.ts` — that imported via a bare `"./tokenise"`, one directory level different
  from the `"../gcode/tokenise"` pattern everything outside `model/gcode/` used, and so needed a
  second pass after a bulk find-and-replace missed them). Also moved `TOOL_PARAM_COMMANDS` out of
  `toolRenumber.ts` (where it was actually defined, not `toolTemperature.ts` as first assumed) into
  the package's `commands/toolParams.ts`, and deleted `src/__tests__/tokenise.test.ts` and
  `toolTemperature.test.ts` outright rather than keep them as now-duplicate local copies of what
  `dwc-gcode-core`'s own suite already tests.
- **Dependency: `github:jaysuk/dwc-gcode-core#v0.1.0`, not npm yet.** The package has no npm publish;
  the post-processor consumes it as a `dependencies` entry pointing at the GitHub tag directly (the
  same pattern `dwc-plugin-runtime`/`dwc-config-backup-core` used before they were on npm — see this
  repo's own `CLAUDE.md`). `github.com/jaysuk/dwc-gcode-core` is now a real public repo with `v0.1.0`
  tagged and released (CI and Release workflows both green).
- **Acceptance — all met:**
  - 1,089 tests pass (1,140 minus the 51 in the two deleted duplicate test files — `tokenise.test.ts`
    had 31, `toolTemperature.test.ts` had 20 — exactly accounted for by moving to `dwc-gcode-core`'s
    own suite, not lost);
  - zero golden diff;
  - all three gates green (`npm test`, `dwc-plugin-typecheck`, `dwc-plugin-verify-build`), plus the
    `vue-tsc` replica from `docs/tasks/README.md` run by hand — zero errors reference this plugin's
    files, test files included (the one class of bug the other two gates can miss on Windows).
  - Bundle size **not** A/B-compared byte-for-byte against the pre-migration build (would have needed
    a git-stash round-trip across a change that includes file deletions) — the current build is
    336.34 kB / 98.91 kB gzipped, and since this phase moves existing logic rather than adding any,
    no material change was expected or observed to be a concern.
- **Trap — hit and resolved once:** the DWC checkout needs `dwc-gcode-core` installed too
  (`SPECS=… && npm install --no-save $SPECS` into `../DuetWebControl`, per the memory note) before
  either DWC-checkout gate resolves it — done as part of verifying this phase.

### Phase 2 — merge the two `gcodeEdit`s — done, `dwc-gcode-core@0.2.0`

- **Characterisation tests already existed in both repos** — resonance-lab's own
  `test/gcodeEdit.test.ts`, and calibration-wizard's "config.g line editor"/"config.g M98 includes"
  describes inside `retraction-speed-config.test.ts` (it never had a dedicated file of its own).
  Ported both into `dwc-gcode-core`'s `test/edit.test.ts` directly rather than rewritten — 383 tests.
- **Built `edit.ts` from calibration-wizard's superset**, settling `setParam` as decided: the
  colon-list-aware regex, fixing a real (if latent — nothing in resonance-lab happened to call it on
  a colon-list value yet) bug in resonance-lab's own copy. The `{ line, refused }` return-shape
  sketched in the Decisions section above did **not** survive contact with the real code: neither
  original implementation had it — the safety gate already lived one level up, in
  `planDirectiveEditAcrossFiles` checking `line.unsafe` before calling `editLine` at all — so
  `setParam` keeps its existing plain-string return in both consuming repos unchanged.
- **Considered and reverted:** routing `edit.ts`'s comment-splitting through `lex.ts`'s `""`-escape-
  aware `findCommentIndex`, on the assumption the original naive quote-toggle mis-locates a comment
  after a doubled quote. Traced both by hand before committing to it: an escaped `""` pair is always
  two characters, which is parity-neutral under a naive per-character toggle regardless of whether
  the toggle understands the escape, so the two are provably equivalent for this purpose — not a real
  bug. `edit.ts` stayed fully self-contained rather than claim an unproven fix.
- **`edit` is a subpath-only export** (`dwc-gcode-core/edit`), deliberately not re-exported from the
  root barrel: its own `setParam` (rewrites a parameter on a raw config.g *line*) collides by name
  with the root's existing `setParam` (rewrites a parameter on an already-tokenised command *body*).
  `test/package.test.ts` proves the root still resolves to the tokenised-body one.
- **Migrated calibration-wizard**: `src/dwc/configFile.ts`'s import, its own `src/model/gcodeEdit.ts`
  deleted, the two now-duplicate describe blocks in `retraction-speed-config.test.ts` removed (their
  coverage lives upstream now). 92 tests pass.
- **Migrated resonance-lab**: `accelWiring.ts`/`machineConfig.ts`'s imports, its own
  `src/config/gcodeEdit.ts` and `test/gcodeEdit.test.ts` deleted. 264 tests pass. **A real trap this
  repo's dual-DWC-generation build hit and needed fixing**: `scripts/stage-dwc36.mjs`'s `VENDOR` list
  (`chart.js`, `dwc-plugin-runtime`) needed `dwc-gcode-core` added too, since `config/` — where the
  new import lives — is shared with the DWC 3.6 build, which has never heard of this package either.
  Confirmed by actually running `build36.bat` against a real DWC 3.6 checkout: it failed with a
  webpack resolution error before the fix, built cleanly after.
- **Acceptance, all three repos**: local tests pass, both DWC-checkout gates green, and — since
  those two gates are individually known to miss test-file type errors on this machine (Windows) —
  a by-hand `vue-tsc` run against the same generated tsconfig CI uses, confirming zero errors
  reference each plugin's own files, test files included.
- **Not pushed.** Both migrations are committed locally on `main` in their own repos, same as the
  post-processor's own Phase 1 migration commit — pushing wasn't asked for.

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

- **Merge `firmware.ts` from resonance-lab's/calibration-wizard's diverged `firmwareVersion.ts`
  copies** (Decisions #7 above has the full detail: adopt resonance-lab's newer, `+N`-aware version;
  port its characterisation tests first).
- Land the cited semantic entries and the `FEATURES` table.
- The post-processor reads `boards[0].firmwareVersion` so that, for example, `restartFrom` warns before
  emitting `M568` for a board older than 3.3.
- Keep the file-stamp diffing feature (its own section above) in mind while shaping `FEATURES`: every
  entry should carry a real `since`, cited, from the start — not bolted on once that feature is
  actually being built.

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
