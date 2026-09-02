# Task 14 — defect pass on the scripting engines (expr-eval and QuickJS)

**Read [README.md](README.md) first, then [CLAUDE.md](../../CLAUDE.md).** The four non-negotiables
there are binding.

This is a defect pass in the same spirit as [07](07-audit-defects.md) and [10](10-audit-defects.md),
on work that is **still uncommitted on the working tree and has not shipped**: the `expr`/
`setParamExpr` additions to the rules tier (`model/gcode/exprEval.ts`) and the QuickJS sandboxed
script engine (`model/steps/quickjs/`). The defects were found by auditing that work against the rest
of the codebase after it was written; every one below has a reproduction that **fails on the current
working tree and must pass after the fix**.

The sandboxed engine is not shippable as written. Its own tests pass — 874 of them — because they
exercise `SandboxEngine` in isolation and never once drive it through a real `Pipeline` with a
downstream step, or with a file that carries real slicer metadata. Both omissions hide a critical
defect. That is the shape of the whole task: the unit tests were testing the wrong seam.

| Audit issue | Finding here |
| --- | --- |
| 1 — downstream steps bypassed | A1 |
| 2 — stale `LineContext` for buffered lines | A2 |
| 3 — dry-run diff and stats are wrong | A3 |
| 4 — per-line metadata serialisation, 239× slowdown | B |
| 5 — default time budget aborts a trivial script | B (symptom) |
| 6 — QuickJS runtime leaked on a cancelled run | C |
| 7 — `expr` recompiled once per line | D |
| 8 — sandboxed script never syntax-checked | E |

**Findings A and B share one fix and must be done together, first.** C, D and E are independent and
can be done in any order after.

---

## Finding A — chunked execution breaks the `Transform` contract *(critical)*

`createSandboxedTransform` (`src/model/steps/script.ts:129`) buffers up to `CHUNK_SIZE = 500`
(`script.ts:44`) lines, returning `null` for each, then flushes the whole batch as a `string[]` on the
line that closes the chunk — the pattern `arcWeld.ts` uses. `arcWeld` gets away with it because it
buffers a handful of lines and is documented to run last. At 500 lines it breaks three things.

### A1 — the trailing chunk bypasses every downstream step

`Pipeline.end()` (`src/model/pipeline.ts:146`) concatenates each transform's `onEnd` output straight
into the output. It never feeds it through the transforms ordered after it. Whatever is still
buffered when the file ends therefore **skips every later step in the recipe**.

On a file shorter than 500 lines that is *every* line, so every downstream step is skipped entirely.

```ts
it("applies a downstream step to every line, including the last partial chunk", async () => {
	const QuickJS = (await newQuickJSWASMModuleFromVariant(variant)) as unknown as QuickJsModuleLike;
	__setQuickJsLoadedForTests(QuickJS);
	const script = scriptStep.create({
		source: "return line;", maxMsPerLine: 1000, engine: "sandboxed",
	} as never, { scriptsTrusted: true });
	const downstream = findReplaceStep.create({
		find: "G1", replace: "MARKED", regex: false, caseSensitive: true,
		wholeWord: false, all: true, layerFrom: -1, layerTo: -1,
	} as never, { scriptsTrusted: true });

	const lines: Array<string> = [];
	for (let i = 0; i < 600; i++) lines.push(`G1 X${i}`);
	const { output } = runToString({ transforms: [script, downstream] }, lines.join("\n"));

	expect(output.split("\n").filter((l) => l.startsWith("G1"))).toHaveLength(0);
});
```

Currently **500 lines are marked and the last 100 are not** — silent, position-dependent corruption.
A three-line input leaves all three unmarked.

### A2 — buffered lines are handed the wrong `LineContext`

`applyToAll` (`pipeline.ts:242`) passes the *current* line's context to a downstream transform for
every element of a flushed array. All 500 lines in a chunk are therefore evaluated against the
context of whichever line happened to close it. Layer-anchored steps — a core feature of this plugin —
silently do the wrong thing.

```ts
it("gives a downstream layer-gated step the right layer for every line", async () => {
	// 3 layers x 200 moves. Downstream rule fires only on layer 0.
	const downstream = rulesStep.create({
		rules: JSON.stringify([{
			when: [{ type: "command", codes: ["G1"] }, { type: "layer", from: 0, to: 0 }],
			then: [{ type: "appendComment", text: "L0" }],
		}]),
	} as never, { scriptsTrusted: true });
	// ... script step as above, transforms: [script, downstream] ...
	const tagged = output.split("\n").filter((l) => l.includes("L0"));
	expect(tagged).toHaveLength(200);
});
```

Currently tags **0 lines instead of 200**: the 500 flushed mid-file all carry line 500's context
(layer 2, so the `layer 0..0` gate never matches), and the remaining 103 bypass the step per A1.

### A3 — the dry-run diff and statistics are wrong

Every withheld line returns `null`, which `Pipeline.record()` (`pipeline.ts:162`) counts as a
deletion and records as a diff entry. The re-emitted batch is then counted as additions.

```ts
it("reports no changes for an identity sandboxed script", async () => {
	// ... script step, source "return line;" ...
	const { pipeline } = runToString({ transforms: [script] }, "G1 X1\nG1 X2\nG1 X3");
	expect(pipeline.stats.linesRemoved).toBe(0);
	expect(pipeline.stats.linesAdded).toBe(0);
	expect(pipeline.diff).toHaveLength(0);
});
```

Currently reports `linesRemoved: 3, linesAdded: 3` and three diff entries, each claiming the line was
deleted. On a real file the 2000-entry diff cap fills with bogus deletions and sets `diffTruncated`.
**This breaks the dry-run preview, which is non-negotiable #3.**

---

## Finding B — the whole slicer metadata block is re-serialised for every line *(critical)*

`serialiseLineContext` (`src/model/steps/quickjs/sandboxEngine.ts:49`) runs
`Object.fromEntries(ctx.meta.values)` (`:72`) per line, and the result is `JSON.stringify`d 500 times
per chunk. `meta` is identical for every line in the file.

Measured on a file whose metadata carries 300 keys — normal for PrusaSlicer/OrcaSlicer:

| | |
| --- | --- |
| Serialised context, per line | **17,568 bytes** |
| JSON per 500-line chunk | **8.5 MB** |
| 20,000 lines, sandboxed | **20,048 ms** |
| 20,000 lines, fast engine | 84 ms |
| Ratio | **239×** |
| Same 20,000 lines, *empty* metadata | 1,176 ms |

The empty-metadata row is the one the original benchmark measured, which is why it reported
~1.6 µs/line and why that figure was written into `docs/scripting-engines.md`. It was measuring a
context object with no metadata in it.

**Symptom (audit issue 5): the default configuration aborts on a real file.** With
`maxMsPerChunk` at its default 200 and an identity script, a 2000-line file carrying 300 metadata
keys fails with *"Sandboxed script exceeded its time budget (200 ms for a chunk of 500 lines)"*. The
feature does not work out of the box.

```ts
it("runs an identity script over a file with real slicer metadata, on default settings", async () => {
	const settings: Array<string> = [];
	for (let i = 0; i < 300; i++) settings.push(`; setting_key_number_${i} = value_${i}`);
	const meta = parseMetadata(["G1 X1", ...settings].join("\n"));
	const body: Array<string> = [];
	for (let i = 0; i < 2000; i++) body.push(`G1 X${i} Y${i} E${(i * 0.01).toFixed(4)} F1800`);
	// script step built from withDefaults(scriptStep, { engine: "sandboxed" }) — no hand-tuning
	expect(() => runToString({ transforms: [script], meta }, body.join("\n"))).not.toThrow();
});
```

---

## The fix for A and B — stop chunking, hoist the metadata

Both findings come from one decision. Reverse it: **call the VM once per line, and put `meta` inside
the VM once per run.** That makes the sandboxed step a drop-in for the fast one — same return values,
same context per line, same statistics — and removes A1, A2, A3 and B together.

The measured cost of a bare per-line VM round trip is ~6–8 µs/line. **Do not carry that figure into
the docs as the engine's real cost** — it is a bare `newString`/`callFunction`/`getString` with no
payload marshalling, and the actual per-line cost once `{line, ctx}` is JSON-marshalled in and the
result marshalled back out is ~40 µs/line, about 17× the fast engine. Quoting the bare figure as the
end-to-end cost is exactly the mistake that produced Finding B; **measure the finished implementation
on a fixture with real metadata and put that number in the docs.**

**`vmStdlib.ts`:**

- Replace `runChunk` with `runLine(inputJson)`. It takes `{ line, ctx }` where `ctx` is the per-line
  state only, reattaches the hoisted metadata as `ctx.meta`, calls `__userTransform`, and returns
  `JSON.stringify({ line: <string|null>, before: [], after: [], logs: [] })`.
- Add `setMeta(metaJson)`, which parses and stores the metadata object in a VM-level variable.
  Initialise that variable to an empty-but-well-formed shape (`{ values: {}, totalLayers: null, … }`)
  so a caller that never calls `setMeta` still sees `ctx.meta.values` as an object, not `undefined`.
- `state` and the log buffer keep working exactly as now — they already live inside the VM.

**`sandboxEngine.ts`:**

- Split `SerialisedLineContext` (`:23`) into `SerialisedMeta` (hoisted once) and a per-line
  `SerialisedLineState` carrying only `lineNo, layer, z, tool, feedrate, relativeMoves, relativeE,
  object, featureType, layerChanged, totalLayers, progress`. Nothing derived from `meta`.
- Add `setMeta(meta: SlicerMetadata): void`, which serialises once and calls the VM's `setMeta`.
- Replace `runChunk` (`:146`) with `runLine(line: string, state: SerialisedLineState)` returning
  `{ line: string | null; before: Array<string>; after: Array<string>; logs: Array<string> }`.
- Install the interrupt handler **once, in the constructor**, closing over a mutable deadline field,
  instead of calling `setInterruptHandler` per call (`:150`). Set the deadline from `runLine` with
  `performance.now()`, not `Date.now()` — `Date.now()`'s 1 ms resolution cannot express a sub-
  millisecond budget, and the handler currently compares against one that often has already passed.

**`script.ts`:**

- Delete `CHUNK_SIZE` (`:44`) and the buffering in `createSandboxedTransform` (`:129`). `onLine`
  calls `engine.runLine(...)` and returns immediately.
- Return `undefined` when the script returned the line unchanged and emitted nothing — mirror the
  fast engine's own line (`script.ts:312`: `return replaced === line ? undefined : replaced;`). This
  is what keeps A3 fixed and preserves the pipeline's no-allocation fast path; returning the string
  every time would report every line as changed.
- Call `engine.setMeta(ctx.meta)` from `onStart(ctx: RunContext)`. `RunContext` carries `meta`, and
  `Pipeline.begin()` always runs before any `line()`, including for the analysis prefix pipelines.
- Surface `log()` output per line into the same `logs` array `onEnd` already reports through
  `ctx.warn`.

**Time budget — collapse the two fields into one.** Delete `maxMsPerChunk` from `ScriptConfig`
(`:36`), from `DEFAULT_MAX_MS_PER_CHUNK` (`sandboxEngine.ts:89`) and from `fields` (`:235`), and
remove the `showWhen` on `maxMsPerLine` (`:228`) so it applies to both engines with its existing
meaning. The sandboxed engine then enforces it two ways:

1. the same averaged watchdog the fast engine already has (`script.ts:299–307`) — reuse that logic
   and its message rather than writing a second copy;
2. a hard per-line interrupt backstop at a fixed `INTERRUPT_BACKSTOP_MS = 1000`, exported so tests
   can reference it. A single line running for over a second is pathological whatever the average
   budget is, and this is the thing the fast engine genuinely cannot do.

Give the two a distinguishable message — the averaged one already says "over N lines"; the backstop
should say a single line ran too long.

**Traps:**

- A recipe saved while `maxMsPerChunk` existed keeps a stray key in its stored config. `withDefaults`
  only copies keys declared in `fields`, so it is inert — do not write a migration for it.
- Do not reintroduce batching as an optimisation without measuring first, and measure with a fixture
  that has real metadata. That mistake is the entire content of Finding B.
- `SandboxAbortError` and `ScriptAbortError` are two names for one concept and neither is caught by
  type anywhere in `src/` (checked). Delete `SandboxAbortError` and throw `ScriptAbortError` from
  both engines, so the UI has one thing to recognise later.

---

## Finding C — the QuickJS runtime is never disposed when a run is cancelled *(moderate)*

`processFile` awaits `forEachLine` at `src/model/io/transfer.ts:329` with no `try`/`finally`, and
`pipeline.end()` — the only path to the engine's `dispose()` — is the line after, at `:342`. A
cancel (`CancelledError`) or any transform throwing skips it, stranding a QuickJS runtime and its
WASM heap (a 64 MB limit each) for the life of the page. Repeated cancels accumulate.

**The fix.** Add an optional `dispose?(): void` to `Transform` (`src/model/steps/types.ts:49`), give
`Pipeline` a `dispose()` that calls it on every transform inside a `try`/`catch`, and wrap both the
main pass and each analysis prefix pipeline (`transfer.ts:261`, ending `:286`) in `try`/`finally`
calling it. Move the sandboxed transform's disposal out of `onEnd` (`script.ts:173`) into `dispose()`,
and make `SandboxEngine.dispose()` idempotent with an explicit flag rather than relying on the
current `try`/`catch`. Have `runToString` dispose in a `finally` too, so the test suite stops
stranding runtimes.

**Reproduction:** drive a pipeline whose second transform throws partway, assert the script step's
`dispose()` ran. Note that a transform throwing from `onLine` is *not* enough to reproduce this on
the current code, because the sandboxed step returns `null` for buffered lines and `pipeline.line()`
breaks out of the transform loop at `pipeline.ts:133` before reaching the thrower — an artefact of
Finding A. Write this test **after** A is fixed, or drive the cancel from the reader instead.

---

## Finding D — an `expr` condition recompiles its expression on every line *(moderate)*

`src/model/steps/rules.ts:165` calls `compileExpr(cond.expression).evaluate(...)` inside the per-line
path, and `:234` does the same for `setParamExpr`. The expression is re-parsed for every line in the
file, which is exactly what returning a `CompiledExpr` was meant to avoid.

Measured over 20,000 lines: an `expr` condition takes **171 ms against 38 ms** for the equivalent
`param` condition — 4.6×, or 43 s against 9 s extrapolated to a 5 M-line file.

**The fix.** Memoise in `src/model/gcode/exprEval.ts`: a module-level `Map<string, CompiledExpr>`
consulted at the top of `compileExpr` (`:44`). Cache successes only — a malformed expression throws
and is already rejected at `parseRules` time. Bound it (clear the map past ~256 entries); rule
configs hold a handful of distinct expressions, so this only guards against a pathological caller.

Keeping the memo inside `exprEval.ts` means `testCondition` and `applyAction` stay the pure,
`Condition`-keyed functions they are today — do not thread a compiled-expression cache through their
signatures.

**Reproduction:** assert the `expr` rule runs within, say, 2× the `param` rule over 20,000 lines.
Keep the threshold loose enough not to be flaky on a loaded machine; the defect is a 4.6× gap, so
even a generous bound catches it.

---

## Finding E — a sandboxed script is never syntax-checked *(minor)*

`scriptStep.validate` returns `[]` for `engine: "sandboxed"` (`src/model/steps/script.ts:331`), so a
typo is not reported when the recipe is saved — it surfaces only when a run starts. The fast engine
reports it immediately, so the two engines behave inconsistently for the same mistake.

**The fix.** Run `compileScript(config.source)` as a syntax gate for the sandboxed engine too and
return its message. Comment that it is a *syntax* check only: the two engines agree on the grammar,
not on the host globals, so this must not be presented as a guarantee the script will run.

---

## Not a defect — the `Aborted(Assertion failed: list_empty(...))` line in test output

A `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c,2036,JS_FreeRuntime)` line
appears on stderr in some QuickJS test runs. **It is a vitest artefact, not a leak.** It appears only
when an assertion *fails* in a test that also holds QuickJS objects: identical code with a passing
assertion produces none, and a failing assertion in a test with no QuickJS produces none. It was
chased once already. Do not chase it again, and do not "fix" it by adding handle disposal that the
API does not require.

---

## The tests to write

The regression tests matter more than the fixes here, because the existing suite passes with all of
the above present. Put them in `src/__tests__/quickjsEngine.test.ts` unless noted.

1. **Cross-engine parity — the centrepiece.** A helper that runs the *same* script source over the
   *same* input through both `engine: "fast"` and `engine: "sandboxed"` and asserts identical output
   **and** identical `linesChanged`/`linesAdded`/`linesRemoved`/`diff.length`. Cover: identity, a
   replacement, a drop via `null`, a drop via `drop()`, `emit`/`emitBefore`, `state` across lines,
   and `gcode.*` helpers. This single test catches A1, A2 and A3 at once, and would have caught all
   three when they were written.
2. **Pipeline-level, with a downstream step** — A1's reproduction above, at both 3 lines and 600
   lines, so the trailing-partial-chunk case and the whole-file case are both covered.
3. **Downstream context** — A2's reproduction above.
4. **Statistics and diff** — A3's reproduction above.
5. **Real metadata** — B's reproduction above, plus an assertion that the sandboxed engine stays
   within a stated factor of the fast engine on a 300-key-metadata fixture. Pick the factor from a
   measurement, not from hope, and keep it loose enough not to be flaky (the defect is 239×).
6. **Disposal** — Finding C's reproduction, written after A is fixed.
7. **`expr` throughput** — Finding D's reproduction, in `src/__tests__/exprEval.test.ts`.
8. **Sandboxed validate** — Finding E: `scriptStep.validate({ engine: "sandboxed", source: "this is
   not javascript", … })` returns a non-empty array.
9. Update `quickjsStdlibParity.test.ts` and `quickjsLoaderIntegration.test.ts` for the `runLine` API.
   The parity test's value is unchanged — keep its battery of lines exactly as it is.

**No golden file should change.** No bundled preset uses the script step (checked), so any golden
diff means something in the shared pipeline moved and you should stop and work out why.

## Docs and text to correct

The chunking design was written up as fact in several places. All of it needs revising once A and B
are fixed, and the performance numbers must come from a fresh measurement on a fixture with real
metadata, not from the superseded ones:

- `docs/scripting-engines.md` — the "Shape" bullet (the 7.8 µs/1.6 µs comparison and the whole
  chunk-at-a-time rationale) and the "chunked (~500 lines/call)" cell in the "What ships today" table.
- `docs/usage.md` — "lines are processed in batches of a few hundred internally" in the two-engines
  section, and the per-batch wording in the watchdog paragraph.
- `src/model/steps/script.ts` — the step `tip` ("lines are processed in batches rather than strictly
  one at a time"), the `engine` field help, and the module comment.
- `FEATURES.md` C2 — "chunked".
- `src/model/steps/quickjs/sandboxEngine.ts` — the module comment's opening paragraph.

## Acceptance criteria

- Every reproduction above fails before the fix and passes after it.
- The cross-engine parity test passes for all listed script shapes.
- An identity sandboxed script on a 2000-line file with 300 metadata keys completes on default
  settings, and reports zero changes and an empty diff.
- A `while (true) {}` script still aborts the run rather than hanging — the existing infinite-loop
  test keeps passing against the new interrupt backstop (allow it up to ~5 s).
- No golden file changes.
- All three gates pass: `npm test`, `dwc-plugin-typecheck`, `dwc-plugin-verify-build`, with
  `DWC_DIR=/c/Users/live/Documents/Github/DuetWebControl`.
- The built ZIP still contains `dwc/GCodePostProcessor/quickjs.bin` and the main bundle still
  contains no `import(`.

## Out of scope

- Pyodide, MicroPython, CodeMirror, jsdiff — everything else in `docs/scripting-engines.md`.
- Changing the fast engine's behaviour in any way. It is shipped and tested; the parity test exists
  to pull the sandboxed engine towards it, not the reverse.
- Reworking `Pipeline.end()` so that a transform's `onEnd` output flows through later transforms.
  It is a real limitation and `arcWeld` shares it, but the fix for Finding A is to stop relying on
  it, not to redesign the pipeline. If you think otherwise, **stop and report** rather than changing
  the contract every step in the recipe depends on.
- Re-litigating `expr-eval-fork` versus `expr-eval`. The fork is used deliberately; the reasoning is
  in `exprEval.ts`'s module comment and `docs/scripting-engines.md`.
