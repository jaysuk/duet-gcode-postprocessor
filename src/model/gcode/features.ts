/**
 * Canonical feature types, normalised from the slicer-specific strings in a `;TYPE:` comment
 * (captured verbatim as `state.featureType` in `state.ts`).
 *
 * Every slicer names the same handful of concepts differently, and — the reason this file exists
 * rather than a single shared table being enough — a slicer *family* is not one vocabulary either:
 * OrcaSlicer's own fixture in this repo (`test/fixtures/orcaslicer.gcode`) emits `;TYPE:Outer wall`,
 * not PrusaSlicer's `External perimeter`, even though Orca is a PrusaSlicer descendant. Assuming
 * "Orca uses Prusa's names" was wrong the moment it was checked against a real example.
 */

export type Feature =
	| "externalPerimeter" | "internalPerimeter" | "overhang" | "bridge"
	| "solidInfill" | "topSolidInfill" | "sparseInfill" | "support"
	| "skirtBrim" | "ironing" | "custom" | "unknown";

const LABELS: Record<Feature, string> = {
	externalPerimeter: "External perimeter",
	internalPerimeter: "Internal perimeter",
	overhang: "Overhang",
	bridge: "Bridge",
	solidInfill: "Solid infill",
	topSolidInfill: "Top solid infill",
	sparseInfill: "Sparse infill",
	support: "Support",
	skirtBrim: "Skirt / brim",
	ironing: "Ironing",
	custom: "Custom G-code",
	unknown: "Unrecognised",
};

/**
 * Raw `;TYPE:` strings, lower-cased, mapped to the canonical feature they mean. Confirmed against
 * this repo's own fixtures where noted; PrusaSlicer/SuperSlicer/Cura values come from the slicers'
 * documented feature list. The OrcaSlicer-specific entries beyond "outer wall"/"inner wall" (Bambu's
 * naming, which Orca inherited) are included on the strength of that shared lineage but have not
 * individually been checked against a real Orca export — an unrecognised string safely falls back
 * to "unknown" rather than mis-mapping, so getting one of these wrong costs nothing but a missed
 * match, never a wrong one.
 */
const RAW_TO_FEATURE: Record<string, Exclude<Feature, "unknown">> = {
	// PrusaSlicer / SuperSlicer
	"external perimeter": "externalPerimeter",
	"perimeter": "internalPerimeter",
	"internal perimeter": "internalPerimeter",
	"overhang perimeter": "overhang",
	"bridge infill": "bridge",
	"internal bridge infill": "bridge",
	"overhang bridge": "bridge",
	"solid infill": "solidInfill",
	"top solid infill": "topSolidInfill",
	"internal infill": "sparseInfill",
	"sparse infill": "sparseInfill",
	"support material": "support",
	"support material interface": "support",
	"skirt": "skirtBrim",
	"skirt/brim": "skirtBrim",
	"brim": "skirtBrim",
	"ironing": "ironing",
	"custom": "custom",

	// Cura
	"wall-outer": "externalPerimeter",
	"wall-inner": "internalPerimeter",
	"bridge": "bridge",
	"skin": "solidInfill",
	"top-surface": "topSolidInfill",
	"fill": "sparseInfill",
	"support": "support",
	"support-interface": "support",

	// OrcaSlicer / Bambu Studio — confirmed: "outer wall" (this repo's orcaslicer.gcode fixture)
	"outer wall": "externalPerimeter",
	"inner wall": "internalPerimeter",
	"overhang wall": "overhang",
	"internal solid infill": "solidInfill",
	"top surface": "topSolidInfill",
	"bottom surface": "topSolidInfill",
	"support interface": "support",
	"gap infill": "sparseInfill",
};

/**
 * Normalise a raw `;TYPE:` string onto the canonical set. Never throws: `null`, empty, whitespace-
 * only or unrecognised input all resolve to `"unknown"` rather than guessing — a slicer version that
 * invents a new label must show up as "we don't know what this is", not silently as the wrong thing.
 */
export function normaliseFeature(raw: string | null): Feature {
	if (raw === null) return "unknown";
	const key = raw.trim().toLowerCase();
	if (key === "") return "unknown";
	return RAW_TO_FEATURE[key] ?? "unknown";
}

/** Human-readable label for a canonical feature, for the inspector and the step's config form. */
export function featureLabel(feature: Feature): string {
	return LABELS[feature];
}

/** Every feature a user can actually configure an override for — excludes "unknown". */
export const CONFIGURABLE_FEATURES: ReadonlyArray<Exclude<Feature, "unknown">> = Object.freeze([
	"externalPerimeter", "internalPerimeter", "overhang", "bridge",
	"solidInfill", "topSolidInfill", "sparseInfill", "support", "skirtBrim", "ironing", "custom",
]);
