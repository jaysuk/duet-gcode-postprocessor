/**
 * Whether a recipe step should run at all for this particular file — "only if PETG", "only if
 * sliced by Cura" — evaluated once, from the slicer's own metadata, before the transform pass
 * starts. Deliberately not per-line: that is what the `rules` step's own `Condition` type already
 * does, and reusing that per-line shape here would apply a whole-file question line by line for no
 * reason.
 *
 * **Metadata only, not `FileAnalysis`.** Metadata is already parsed from the pre-scanned head/tail
 * before a single line of the transform pass runs, so evaluating a condition against it costs
 * nothing extra. `FileAnalysis` is not: producing one needs a full pass over the file, and today
 * that only happens when the caller explicitly asks for it (`ProcessOptions.analyse`) — making a
 * condition depend on it would mean *every* run with a conditional step pays for a full analysis
 * pass whether or not `analyse` was requested, which is a bigger architectural change than this
 * feature warrants. In practice this loses little: `SlicerMetadata.totalLayers` and `.layerHeight`
 * already cover the common "how big is this file" questions when the slicer states them, which
 * every slicer this plugin recognises does.
 */

import { normaliseKey, type SlicerMetadata } from "./gcode/metadata";

export type ConditionOp = "eq" | "neq" | "contains" | "gt" | "lt" | "gte" | "lte" | "exists" | "notExists";

export interface StepCondition {
	/** A `SlicerMetadata` field name (`slicer`, `slicerVersion`, `totalLayers`, `layerHeight`,
	 *  `filamentMm`, `filamentDiameterMm`, `printTimeSeconds`), or any other key — looked up in
	 *  `meta.values` after the same normalisation (lower-cased, spaces to underscores) every key
	 *  there has already had applied, so `"Filament Type"` and `"filament_type"` match the same way. */
	key: string;
	op: ConditionOp;
	/** Unused for `exists`/`notExists`. Compared case-insensitively for strings. */
	value?: string | number;
}

const KNOWN_FIELDS: Record<string, (meta: SlicerMetadata) => string | number | null> = {
	slicer: (m) => (m.slicer === "unknown" ? null : m.slicer),
	slicerversion: (m) => m.slicerVersion,
	totallayers: (m) => m.totalLayers,
	layerheight: (m) => m.layerHeight,
	filamentmm: (m) => m.filamentMm,
	filamentdiametermm: (m) => m.filamentDiameterMm,
	printtimeseconds: (m) => m.printTimeSeconds,
};

/** Resolves a condition's own key against the known typed fields first, falling back to the raw
 *  `meta.values` map — a number-looking value is returned as a number so `gt`/`lt` work on it. */
function resolveKey(key: string, meta: SlicerMetadata): string | number | null {
	const known = KNOWN_FIELDS[key.toLowerCase().replace(/\s+/g, "")];
	if (known !== undefined) return known(meta);

	const raw = meta.values.get(normaliseKey(key));
	if (raw === undefined) return null;
	const n = Number(raw);
	return Number.isFinite(n) && raw.trim() !== "" ? n : raw;
}

/** Evaluate one condition. Pure. */
export function testStepCondition(cond: StepCondition, meta: SlicerMetadata): boolean {
	const actual = resolveKey(cond.key, meta);
	switch (cond.op) {
		case "exists": return actual !== null;
		case "notExists": return actual === null;
		case "eq":
			if (actual === null) return false;
			return typeof actual === "number" && typeof cond.value === "number"
				? actual === cond.value
				: String(actual).toLowerCase() === String(cond.value).toLowerCase();
		case "neq":
			if (actual === null) return true;
			return typeof actual === "number" && typeof cond.value === "number"
				? actual !== cond.value
				: String(actual).toLowerCase() !== String(cond.value).toLowerCase();
		case "contains":
			return actual !== null && String(actual).toLowerCase().includes(String(cond.value ?? "").toLowerCase());
		case "gt":
			return typeof actual === "number" && typeof cond.value === "number" && actual > cond.value;
		case "lt":
			return typeof actual === "number" && typeof cond.value === "number" && actual < cond.value;
		case "gte":
			return typeof actual === "number" && typeof cond.value === "number" && actual >= cond.value;
		case "lte":
			return typeof actual === "number" && typeof cond.value === "number" && actual <= cond.value;
	}
}

/** All of a step's conditions must hold — an empty or absent list always holds, meaning "always run",
 *  the same as a step having no condition configured at all. */
export function stepConditionsMet(conditions: ReadonlyArray<StepCondition> | undefined, meta: SlicerMetadata): boolean {
	if (conditions === undefined || conditions.length === 0) return true;
	return conditions.every((c) => testStepCondition(c, meta));
}

/** One human-readable line per condition, for the "skipped: condition not met" report. */
export function describeStepConditions(conditions: ReadonlyArray<StepCondition>): string {
	const OP_WORDS: Record<ConditionOp, string> = {
		eq: "=", neq: "≠", contains: "contains", gt: ">", lt: "<", gte: "≥", lte: "≤",
		exists: "is set", notExists: "is not set",
	};
	return conditions
		.map((c) => (c.op === "exists" || c.op === "notExists" ? `${c.key} ${OP_WORDS[c.op]}` : `${c.key} ${OP_WORDS[c.op]} ${c.value}`))
		.join(" and ");
}
