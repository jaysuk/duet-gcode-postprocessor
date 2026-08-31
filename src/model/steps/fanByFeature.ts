/**
 * Override the part-cooling fan speed for specific features (bridges, overhangs, …) without the
 * slicer's own setting undoing it two lines later.
 *
 * The trap this step exists to avoid: a slicer re-emits M106 constantly, including inside the
 * region being overridden, so simply inserting an M106 on entering a feature is not enough — the
 * very next line can put the old speed straight back. This step suppresses the slicer's own
 * M106/M107 lines for as long as an override is active, and restores the speed that was in force
 * once the override ends — which happens at the next feature change *or* at a layer change, even
 * when the same feature label continues across the boundary (many slicers re-state their fan speed
 * once per layer, so treating a layer change as its own boundary keeps this in step with that).
 */

import { formatNumber, paramNumber, parseParams, tokenise } from "../gcode/tokenise";
import { CONFIGURABLE_FEATURES, featureLabel, normaliseFeature, type Feature } from "../gcode/features";
import type { LineContext, StepDefinition, Transform } from "./types";

export type FanSpeedScale = "0-255" | "0-1";

export interface FanByFeatureConfig {
	/** The overrides mini-language: one `feature=speed` entry per line or comma-separated. */
	overrides: string;
	scale: FanSpeedScale;
	firstLayerEnabled: boolean;
	firstLayerSpeed: number;
	action: "comment" | "delete";
	note: string;
}

export interface ParsedOverride {
	raw: string;
	/** null when `raw`'s key was not a recognised feature. */
	feature: Exclude<Feature, "unknown"> | null;
	/** null when `raw`'s value could not be parsed as a number. */
	speed: number | null;
}

const FEATURE_BY_LOWER_KEY: Record<string, Exclude<Feature, "unknown">> = Object.fromEntries(
	CONFIGURABLE_FEATURES.map((f) => [f.toLowerCase(), f]),
);

/** Split "bridge=255, overhang=255\nexternalPerimeter=180" into individual entries. */
function splitOverrideEntries(text: string): Array<string> {
	return text.split(/[,\n]+/).map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Parse the overrides field into individual entries, each carrying its own success/failure so
 * `validate()` can report exactly which line is wrong rather than rejecting the whole field.
 */
export function parseOverrideEntries(text: string): Array<ParsedOverride> {
	return splitOverrideEntries(text).map((raw) => {
		const m = /^([A-Za-z]+)\s*[:=]\s*(-?[\d.]+)$/.exec(raw);
		if (m === null) return { raw, feature: null, speed: null };
		const feature = FEATURE_BY_LOWER_KEY[m[1].toLowerCase()] ?? null;
		const speed = Number(m[2]);
		return { raw, feature, speed: Number.isFinite(speed) ? speed : null };
	});
}

/** Just the successfully parsed feature -> speed pairs; anything malformed or unrecognised is dropped. */
export function parseFeatureOverrides(text: string): Map<Exclude<Feature, "unknown">, number> {
	const map = new Map<Exclude<Feature, "unknown">, number>();
	for (const entry of parseOverrideEntries(text)) {
		if (entry.feature !== null && entry.speed !== null) map.set(entry.feature, entry.speed);
	}
	return map;
}

export function inScaleRange(value: number, scale: FanSpeedScale): boolean {
	return scale === "0-1" ? value >= 0 && value <= 1 : value >= 0 && value <= 255;
}

type OverrideKind = "feature" | "firstLayer";
interface DesiredOverride {
	kind: OverrideKind;
	feature: Feature | null;
	speed: number;
}

function identityOf(kind: OverrideKind | null, feature: Feature | null): string | null {
	if (kind === null) return null;
	return kind === "firstLayer" ? "firstLayer" : `feature:${feature}`;
}

export const fanByFeatureStep: StepDefinition<FanByFeatureConfig> = {
	id: "fanByFeature",
	label: "Fan speed by feature",
	description: "Override the part-cooling fan speed for specific features such as bridges or overhangs.",
	icon: "mdi-fan",
	fields: [
		{
			key: "overrides", label: "Overrides", type: "textarea", default: "",
			placeholder: "bridge=255\noverhang=255\nexternalPerimeter=180",
			help: "One per line or comma-separated: feature=speed. Features: externalPerimeter, internalPerimeter, overhang, bridge, solidInfill, topSolidInfill, sparseInfill, support, skirtBrim, ironing, custom.",
		},
		{
			key: "scale", label: "Speed scale", type: "select", default: "0-255",
			options: [
				{ value: "0-255", label: "0–255" },
				{ value: "0-1", label: "0–1 (fraction)" },
			],
			help: "Match whichever scale this file already uses — check the Fan speeds table on the Inspect tab. Default: 0–255.",
		},
		{
			key: "firstLayerEnabled", label: "Override the first layer", type: "boolean", default: false,
			help: "Applies regardless of feature, and takes priority over a feature override on the first layer. Default: off.",
		},
		{
			key: "firstLayerSpeed", label: "First layer speed", type: "number", default: 0, min: 0,
			showWhen: { key: "firstLayerEnabled", equals: [true] },
			help: "Default: 0 (off) — most slicers already print the first layer with cooling off, for adhesion.",
		},
		{
			key: "action", label: "How to suppress the slicer's own setting", type: "select", default: "comment",
			options: [
				{ value: "comment", label: "Comment out (keep the line, disabled)" },
				{ value: "delete", label: "Delete the line entirely" },
			],
			help: "Applies to the M106/M107 lines the slicer emits inside an overridden region. Default: comment out.",
		},
		{
			key: "note", label: "Note to append", type: "text", default: "suppressed by fan override",
			showWhen: { key: "action", equals: ["comment"] },
			help: "Appended after the commented-out line so its origin is obvious later.",
		},
	],

	create(config): Transform {
		const overrides = parseFeatureOverrides(config.overrides);
		const firstLayerSpeed = config.firstLayerEnabled ? config.firstLayerSpeed : null;
		const commentOut = config.action !== "delete";
		const note = config.note === "" ? "" : ` ${config.note}`;

		// The last fan setting the SLICER actually asked for, tracked continuously (even while
		// suppressed) so there is always a real value to restore to once an override ends
		let lastRealFan = 0;
		let lastRealSpeed = 0;
		let activeKind: OverrideKind | null = null;
		let activeFeature: Feature | null = null;
		/** Captured once, at the moment an override begins; fixed until that override fully ends. */
		let restorePending: { fan: number; speed: number } | null = null;

		function desiredFor(ctx: LineContext): DesiredOverride | null {
			// First-layer takes priority over a feature override on the same layer — a deliberate
			// blanket adhesion setting should not be defeated by e.g. a bridge on layer 0
			if (ctx.layer === 0 && firstLayerSpeed !== null) {
				return { kind: "firstLayer", feature: null, speed: firstLayerSpeed };
			}
			const feature = normaliseFeature(ctx.featureType);
			if (feature === "unknown") return null;
			const speed = overrides.get(feature);
			return speed === undefined ? null : { kind: "feature", feature, speed };
		}

		return {
			id: "fanByFeature",

			onStart() {
				lastRealFan = 0;
				lastRealSpeed = 0;
				activeKind = null;
				activeFeature = null;
				restorePending = null;
			},

			onLine(ctx: LineContext, line: string) {
				// A `;TYPE:` or layer-change comment and a real M106/M107 command never coincide on
				// the same source line, so suppression and transition-detection never conflict
				const token = tokenise(line);
				const code = token.code?.toUpperCase() ?? null;
				let replacement: string | null | undefined;

				if (code === "M106" || code === "M107") {
					const params = parseParams(token.body);
					lastRealFan = paramNumber(params, "P") ?? 0;
					lastRealSpeed = code === "M107" ? 0 : (paramNumber(params, "S") ?? 0);
					replacement = activeKind !== null ? (commentOut ? `;${line}${note}` : null) : undefined;
				} else {
					replacement = undefined;
				}

				const want = desiredFor(ctx);
				const wantId = identityOf(want?.kind ?? null, want?.feature ?? null);
				const activeId = identityOf(activeKind, activeFeature);
				// A layer change ends the current override even when the feature label continues
				// across it — this is the case the module comment calls out as easy to forget
				const forceExit = ctx.layerChanged && activeKind !== null;

				const emitted: Array<string> = [];
				if (wantId !== activeId || forceExit) {
					if (activeKind !== null) {
						if (restorePending !== null) {
							emitted.push(`M106 P${restorePending.fan} S${formatNumber(restorePending.speed, 3)}`);
						}
						activeKind = null;
						activeFeature = null;
						restorePending = null;
					}
					if (want !== null) {
						// Capture what to restore to BEFORE overriding, from the slicer's last real
						// setting — never from a previous override's value
						restorePending = { fan: lastRealFan, speed: lastRealSpeed };
						emitted.push(`M106 P${lastRealFan} S${formatNumber(want.speed, 3)}`);
						activeKind = want.kind;
						activeFeature = want.feature;
					}
				}

				if (emitted.length === 0) return replacement;
				const base = replacement === null ? [] : [replacement === undefined ? line : replacement];
				return [...base, ...emitted];
			},

			// Ending mid-region needs no closing restore — there is nothing left in the file for a
			// wrong fan speed to affect, and emitting one would be a dangling, pointless command
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		const entries = parseOverrideEntries(config.overrides);
		for (const entry of entries) {
			if (entry.feature === null) {
				errors.push(`"${entry.raw}" is not a recognised feature — see the help text for the list`);
			} else if (entry.speed === null) {
				errors.push(`"${entry.raw}" does not have a valid numeric speed`);
			} else if (!inScaleRange(entry.speed, config.scale)) {
				errors.push(`${featureLabel(entry.feature)}: ${entry.speed} is outside the ${config.scale} range`);
			}
		}
		if (config.firstLayerEnabled && typeof config.firstLayerSpeed === "number"
			&& !inScaleRange(config.firstLayerSpeed, config.scale)) {
			errors.push(`First layer speed ${config.firstLayerSpeed} is outside the ${config.scale} range`);
		}
		if (entries.filter((e) => e.feature !== null && e.speed !== null).length === 0 && !config.firstLayerEnabled) {
			errors.push("Set at least one feature override, or enable the first-layer override");
		}
		return errors;
	},
};
