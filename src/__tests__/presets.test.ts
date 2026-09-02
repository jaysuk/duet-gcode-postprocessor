import { describe, expect, it } from "vitest";

import { parseMetadata } from "../model/gcode/metadata";
import { findPreset, PRESETS } from "../model/presets";
import { buildTransforms } from "../model/recipe";
import { runToString } from "../model/pipeline";

/**
 * None of the 6 golden-file fixtures (`test/golden/*.gcode`) has more than 4 layers, so any preset
 * whose default anchor is "layer 10" — including the pre-existing `pauseAtLayer` — is byte-identical
 * to its input in every golden case: the anchor never fires. That is an accepted, pre-existing
 * limitation of the golden suite (confirmed against `pauseAtLayer` before writing these), not
 * something to work around by lowering a preset's realistic default. These tests exercise the new
 * presets' actual behaviour directly, independent of the golden fixtures' short layer counts.
 */
function manyLayers(layers: number): string {
	const lines: Array<string> = ["M83", "T0"];
	for (let i = 0; i < layers; i++) {
		lines.push(";LAYER_CHANGE");
		lines.push(`G1 Z${(i * 0.2).toFixed(2)} F600`);
		lines.push("G1 X1 Y1 E1 F1200");
	}
	return lines.join("\n");
}

function runPreset(key: string, input: string): string {
	const preset = findPreset(key);
	if (preset === null) throw new Error(`no such preset: ${key}`);
	// Real metadata, not the default empty one: hasLayerMarkers must be true for these test inputs'
	// own ";LAYER_CHANGE" comments to be trusted over the geometric fallback (a Z-only rise treated
	// as a layer change) — exactly how a real recipe run always works (transfer.ts always pre-scans
	// and passes real metadata; only a test skipping that step would see the fallback misfire).
	const meta = parseMetadata(input);
	const transforms = buildTransforms(preset.build(), { scriptsTrusted: false }, meta);
	return runToString({ transforms, meta }, input).output;
}

describe("bundled presets", () => {
	it("every preset builds a recipe with at least one step", () => {
		for (const preset of PRESETS) {
			expect(preset.build().steps.length).toBeGreaterThan(0);
		}
	});

	describe("bedTemperatureRamp", () => {
		it("emits M140, never M190 (M190 waits and would stall the print)", () => {
			const out = runPreset("bedTemperatureRamp", manyLayers(15));
			expect(out).toMatch(/M140 S\d/);
			expect(out).not.toContain("M190");
		});
	});

	describe("confirmationGate", () => {
		it("emits a blocking M291 (S2 or higher), not a non-blocking one", () => {
			const out = runPreset("confirmationGate", manyLayers(15));
			const match = /M291\b[^\n]*\bS(\d+)\b/.exec(out);
			expect(match).not.toBeNull();
			expect(Number(match?.[1])).toBeGreaterThanOrEqual(2);
		});
	});

	describe("perLayerZOffset", () => {
		it("offsets Z from the configured starting layer onward", () => {
			const out = runPreset("perLayerZOffset", manyLayers(3));
			// Layer 1's own Z move (0.2) offset by the preset's default -0.02 -> 0.18
			expect(out).toContain("G1 Z0.18 F600");
		});

		it("does not touch anything before the starting layer", () => {
			// The very first move (before any ;LAYER_CHANGE) is not yet "layer 0" in this codebase's
			// own convention (layer starts at -1 until the first marker), so it must survive untouched
			const out = runPreset("perLayerZOffset", "G1 Z0.2 F600\n;LAYER_CHANGE\nG1 Z0.4 F600");
			expect(out).toContain("G1 Z0.2 F600");
		});
	});

	describe("ejectSequenceTemplate", () => {
		it("appends a fully commented-out template at the end, touching nothing else", () => {
			const input = "G28\nG1 X1";
			const out = runPreset("ejectSequenceTemplate", input);
			expect(out.startsWith(input)).toBe(true);
			expect(out).toContain("; --- Eject sequence template");
			const appended = out.slice(input.length).split("\n").filter((l) => l.trim() !== "");
			expect(appended.length).toBeGreaterThan(0);
			expect(appended.every((l) => l.trim().startsWith(";"))).toBe(true);
		});
	});
});
