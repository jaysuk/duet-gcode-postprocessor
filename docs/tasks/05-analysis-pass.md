# Task 05 — two-pass processing, so a step can see what is coming

Self-contained. **Read [README.md](README.md) and [CLAUDE.md](../../CLAUDE.md) first.**
Do task 04 first: the time model is this task's first real consumer, and building the seam without
one would be designing against an imaginary requirement.

Design background: [feature-ideas.md](../feature-ideas.md) §0, final paragraph.

## The gap

[`Pipeline`](../../src/model/pipeline.ts) is a single forward pass: a step sees the current line and
everything before it, never anything after. That is the right default — it is what keeps a 200 MB
file to one read and one tokenise per line — but it makes a whole class of transformation impossible:

- pre-heating a tool a known number of seconds **before** the tool change (task 06);
- anything anchored to "N seconds before X";
- reporting totals in a header that is written before the totals are known.

The current `insertAt` "percentage through file" anchor is the honest symptom: it works on *byte*
position because byte position is the only forward-looking quantity available without lookahead.

## Why this is cheap

The whole file is **already downloaded as a Blob** before processing starts
([transfer.ts](../../src/model/io/transfer.ts)). A second pass costs a second decode, not a second
download, and reuses the same chunked reader. There is no buffering and no memory growth.

The cost is real but bounded: processing time roughly doubles for recipes that need it. So it must be
**opt-in per run** — taken only when some enabled step actually asks for it.

---

## The design — implement this, do not redesign it

### 1. Collectors

New `src/model/analysisPass.ts`:

```ts
/** Accumulates something from a first read of the file. Pure: no I/O, no DWC. */
export interface AnalysisCollector<T = unknown> {
	readonly id: string;
	onLine(ctx: LineContext, line: string): void;
	result(): T;
}
```

Same `LineContext` the transform pass uses, so the machine state, layer tracking and metadata all
come for free and behave identically in both passes.

### 2. Steps declare what they need

Extend `StepDefinition` in [steps/types.ts](../../src/model/steps/types.ts):

```ts
/** Collectors this step needs run over the file before it can be built. */
analysis?(config: C): Array<AnalysisCollector>;
```

And extend `RunContext` with the results:

```ts
/** Results from the analysis pass, keyed by collector id. Empty when no pass ran. */
readonly analysis: ReadonlyMap<string, unknown>;
```

A step reads them in `onStart`, where it already receives a `RunContext`. **A step must still work
when the map is empty** — a dry run from the widget, or a caller that skipped the pass, should
degrade to doing less, not to throwing.

### 3. The pass runs where the file is already open

In `processFile`, between the pre-scan and the transform pass:

1. Ask the recipe for its collectors (`recipe.ts` gains `collectorsFor(recipe)`, gathering from every
   enabled step's `analysis()`). **No collectors means no pass** — the common case must cost nothing.
2. Run the same chunked read, driving a `Pipeline`-shaped state machine and each collector's
   `onLine`. Same `yieldToUi` cadence, same cancellation checks.
3. Build the results map and pass it into the `Pipeline` for the transform pass.

Report progress as its own phase so the user is not looking at a bar that appears to run twice: add
`"analysing"` to `Phase` in transfer.ts and give it a label in `PostProcessorPage.vue`.

### 4. Extract the shared reader

Both passes now do the same chunked `blob.slice` → streaming `TextDecoder` → line-splitting walk.
That logic currently exists **three times**: in `processFile`, in `inspectFile`, and it would be a
fourth here. Factor it out first:

```ts
export async function forEachLine(
	blob: Blob,
	onLine: (line: string, byteOffset: number) => void,
	options: { chunkBytes?: number; signal?: AbortSignalLike; onProgress?: (fraction: number) => void },
): Promise<void>;
```

Do this as its own commit, before adding the second pass, and confirm the existing tests still pass
unchanged. The trailing-newline handling and the `stream: !lastChunk` decode flag are load-bearing —
two bugs have already been fixed in that loop, and having three copies of it is how the third one
gets fixed in only two of them.

---

## Tests

- `src/__tests__/analysisPass.test.ts`: a collector sees every line exactly once, in order, with the
  same `LineContext` values the transform pass reports for the same file.
- The pass is skipped entirely when no enabled step declares a collector (assert via a spy gateway or
  a counting collector that it never runs).
- A step whose collector produced no result still runs, and does something sensible.
- Cancellation during the analysis pass aborts before any transform work happens and writes nothing.
- `forEachLine` extraction: the existing `transfer.test.ts` chunk-boundary suite must pass unchanged.
  That suite is the regression net for this refactor — if it needs editing, the refactor is wrong.

Add a **timing note to the run report**: analysis seconds and transform seconds separately, so the
cost of a two-pass recipe is visible to the user rather than mysterious.

---

## Acceptance

- A recipe with no lookahead steps performs exactly as before, with no extra read.
- A recipe with one runs two passes, reports both phases, and can be cancelled during either.
- `forEachLine` is the only place the chunk-walking loop exists.
- All three gates pass; no golden file changes.

## Out of scope

- Any actual lookahead feature. This task builds the seam; task 06 is its first user.
- A third pass, or making the pass incremental. If something wants that, it is a design discussion,
  not an implementation detail.
- Caching analysis results between runs. Tempting, and a correctness trap the moment the file or the
  recipe changes.
