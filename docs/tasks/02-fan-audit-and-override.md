# Task 02 — fan-speed audit and per-feature override

Self-contained. **Read [README.md](README.md) and [CLAUDE.md](../../CLAUDE.md) first.**

Design background (not required reading): [feature-ideas.md](../feature-ideas.md) §2.

## The gap

Part cooling is set by the slicer for a generic machine and a generic material. The two things
people actually want to change afterwards — "blast the bridges", "ease off on external perimeters" —
require editing hundreds of scattered `M106` lines by hand, and you cannot even see what the current
speeds *are* without reading the whole file.

Nothing in the plugin surfaces fan speeds today. `Analyser` records which fan *indices* are used
([analysis.ts:184](../../src/model/analysis.ts)) and nothing about their speeds.

## Scope

Two deliverables:

1. **Audit** — every distinct fan speed in the file, how often it occurs, and under which feature.
2. **Override** — a new step type that sets fan speed per feature.

Both need slicer feature names normalised first, which is the third deliverable and the only part
with any real subtlety.

---

## Part 1 — feature normalisation

New pure module `src/model/gcode/features.ts`.

Every slicer names features differently in its `;TYPE:` comments. The state machine already captures
the raw string as `state.featureType` ([state.ts](../../src/model/gcode/state.ts)); this maps it onto
a canonical set.

```ts
export type Feature =
	| "externalPerimeter" | "internalPerimeter" | "overhang" | "bridge"
	| "solidInfill" | "topSolidInfill" | "sparseInfill" | "support"
	| "skirtBrim" | "ironing" | "custom" | "unknown";

export function normaliseFeature(raw: string | null): Feature;
export function featureLabel(feature: Feature): string;
```

Known mappings — verify against the fixtures in `test/fixtures/` and add any that turn up:

| Canonical | PrusaSlicer / SuperSlicer / Orca | Cura |
| --- | --- | --- |
| `externalPerimeter` | `External perimeter` | `WALL-OUTER` |
| `internalPerimeter` | `Perimeter`, `Internal perimeter` | `WALL-INNER` |
| `overhang` | `Overhang perimeter` | — |
| `bridge` | `Bridge infill`, `Overhang bridge` | `BRIDGE` |
| `solidInfill` | `Solid infill` | `SKIN` |
| `topSolidInfill` | `Top solid infill` | `TOP-SURFACE` |
| `sparseInfill` | `Internal infill`, `Sparse infill` | `FILL` |
| `support` | `Support material`, `Support material interface` | `SUPPORT`, `SUPPORT-INTERFACE` |
| `skirtBrim` | `Skirt`, `Skirt/Brim`, `Brim` | `SKIRT` |
| `ironing` | `Ironing` | — |
| `custom` | `Custom` | — |

Match case-insensitively, trim, and **never throw on an unrecognised value** — return `unknown` and
keep the raw string available so the UI can show it. A slicer version that invents a new name must
degrade to "we do not know what this is", not to a crash or a silent mis-mapping.

**Tests** (`src/__tests__/features.test.ts`): each mapping; case and whitespace insensitivity;
`null` and `""` return `unknown`; an invented name returns `unknown`.

---

## Part 2 — the audit

Extend `FileAnalysis` in [analysis.ts](../../src/model/analysis.ts) with:

```ts
/** Distinct fan settings seen, most frequent first. */
fanSettings: Array<{
	/** Fan index from M106 P, or 0 when the command omits it. */
	fan: number;
	/** Speed as written in S. RRF accepts 0–255 or 0–1; record what was written. */
	speed: number;
	count: number;
	/** Features this setting was seen under, most frequent first. */
	features: Array<{ feature: Feature; count: number }>;
}>;
```

Collect it in `Analyser.applyM` where `M106` is already handled, and record `M107` as speed 0.

**Watch the scale.** RRF accepts `M106 S255` and `M106 S1.0` and `M106 S0.5` — 0–255 and 0–1 both.
Do **not** normalise them into one scale in the analysis; record what the file says and let the UI
label it (`S255` / `S0.5`). Guessing wrong turns "half speed" into "off". Note in the inspector which
convention the file uses, decided by whether any recorded speed exceeds 1.

Surface it in `FileInspector.vue` as a table: fan, speed, count, and the features it appears under.

**Tests** (extend `src/__tests__/analysis.test.ts`): counts aggregate correctly; `M107` lands as
speed 0; a setting seen under two features lists both; a file with no `M106` produces an empty array.

---

## Part 3 — the override step

New step `src/model/steps/fanByFeature.ts`, registered in
[registry.ts](../../src/model/steps/registry.ts). Follow the shape of an existing step —
`paramRewrite.ts` is the closest — and remember the schema drives the form, so **no new `.vue` file
is needed or wanted**.

Config: a speed per feature, each optionally unset (meaning "leave alone"), plus the scale to write
in (`0-255` or `0-1`, default matching what the file uses) and a first-layer override.

### The trap — read before writing any code

Setting the fan when a region starts is **not enough**. The slicer re-emits `M106` constantly,
including inside the region you are overriding, so its next line undoes your override. The step must:

1. On entering an overridden feature: emit the override, and remember the speed that was in force.
2. **While inside an overridden region: drop the slicer's own `M106`/`M107` lines** (or comment them
   out — match the `deleteLines` step's convention and make it a config option).
3. On leaving the region — which is the next `;TYPE:` marker, or a layer change — restore the
   remembered speed by emitting it explicitly.

Step 3 is the one that gets forgotten, and forgetting it means the whole print continues at the
bridge fan speed.

**This does not need lookahead.** A region's end is observable at the transition into the next one,
so it works in the existing single forward pass. (An earlier draft of the roadmap claimed this needed
the two-pass analysis of task 05. It does not — do not wait for it.)

Also handle:
- **First layer.** Slicers usually force the fan off for layer 0. An override that ignores that will
  ruin adhesion, so first-layer behaviour is its own explicit setting, defaulting to "leave alone".
- **The file ending inside a region** — restore is not needed, but do not emit a dangling command.
- **A feature with no override configured** — pass everything through untouched, including the
  slicer's `M106`.

**Tests** (`src/__tests__/fanByFeature.test.ts`), using `runStep` from `src/__tests__/helpers.ts`:

- entering an overridden feature emits the override;
- a slicer `M106` inside an overridden region is suppressed;
- leaving the region restores the previous speed, exactly once;
- a feature with no override configured is byte-identical, including its `M106` lines;
- the first-layer setting is honoured independently of the per-feature settings;
- a file that ends mid-region does not emit a trailing restore;
- 0–255 and 0–1 scales both round-trip.

Add a golden-file case: a new preset **"Boost bridge cooling"** (bridges and overhangs at maximum,
everything else untouched), which gives the three fixtures a committed expectation.

---

## Acceptance

- The inspector lists every fan speed in a file with counts and features.
- A recipe can set bridges to 100% without the slicer's own `M106` undoing it two lines later.
- Leaving a bridge restores the speed that was in force before it.
- A file with no overrides configured comes out byte-identical.

## Out of scope

- Fan scaling, minimum-speed clamping and spin-up kick. Same machinery, but land the core first.
- Anything needing the two-pass analysis (task 05).
- Changing how `state.featureType` is captured — it already works; this only normalises it.
