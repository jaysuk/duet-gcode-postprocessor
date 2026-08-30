import { describe, expect, it } from "vitest";

import { advance, createState } from "../model/gcode/state";
import { tokenise } from "../model/gcode/tokenise";

function run(lines: Array<string>) {
	const state = createState();
	const seen: Array<{ line: string; layer: number; z: number | null; changed: boolean }> = [];
	for (const line of lines) {
		advance(state, tokenise(line));
		seen.push({ line, layer: state.layer, z: state.z, changed: state.layerChanged });
	}
	return { state, seen };
}

describe("layer tracking", () => {
	it("counts PrusaSlicer LAYER_CHANGE markers", () => {
		const { state } = run([";LAYER_CHANGE", "G1 Z0.2", ";LAYER_CHANGE", "G1 Z0.4"]);
		expect(state.layer).toBe(1);
		expect(state.sawLayerMarker).toBe(true);
	});

	it("does not treat BEFORE/AFTER_LAYER_CHANGE as extra layers", () => {
		// Prusa emits all three around one layer boundary; counting them all trebles the count
		const { state } = run([";BEFORE_LAYER_CHANGE", ";LAYER_CHANGE", ";AFTER_LAYER_CHANGE"]);
		expect(state.layer).toBe(0);
	});

	it("reads Cura's absolute layer index", () => {
		const { state } = run([";LAYER:0", ";LAYER:1", ";LAYER:7"]);
		expect(state.layer).toBe(7);
	});

	it("normalises Simplify3D's 1-based numbering", () => {
		const { state } = run(["; layer 1, Z = 0.2", "; layer 2, Z = 0.4"]);
		expect(state.layer).toBe(1);
	});

	it("falls back to Z-only rises when the file has no markers", () => {
		const { state } = run(["G1 Z0.2", "G1 X10 Y10", "G1 Z0.4", "G1 X20 Y20"]);
		expect(state.layer).toBe(1);
	});

	it("does not count a Z-lift that also travels in XY as a layer", () => {
		const { state } = run(["G1 Z0.2", "G1 X10 Y10 Z0.6", "G1 X20 Y20 Z0.2"]);
		expect(state.layer).toBe(0);
	});

	it("discards the geometric count when the first marker arrives", () => {
		// Real start G-code moves Z before the first marker; counting it puts every layer out by one
		const { state } = run(["G1 Z0.2", ";BEFORE_LAYER_CHANGE", ";LAYER_CHANGE", ";AFTER_LAYER_CHANGE", "G1 Z0.4"]);
		expect(state.layer).toBe(0);
	});

	it("never guesses at all when the pre-scan found markers", () => {
		// The belt to the reset's braces: a step anchored to "every layer" must not fire on the
		// start block's Z move before the first marker
		const state = createState({ geometricFallback: false });
		const seen: Array<boolean> = [];
		for (const line of ["G1 Z0.2", "G1 Z0.4", ";LAYER_CHANGE", "G1 Z0.6"]) {
			advance(state, tokenise(line));
			seen.push(state.layerChanged);
		}
		expect(seen).toEqual([false, false, true, false]);
		expect(state.layer).toBe(0);
	});

	it("stops the geometric fallback once a marker appears", () => {
		const { state } = run([";LAYER_CHANGE", "G1 Z0.2", "G1 Z1.0", "G1 Z2.0"]);
		expect(state.layer).toBe(0);
	});

	it("flags the line the layer changed on", () => {
		const { seen } = run([";LAYER_CHANGE", "G1 Z0.2"]);
		expect(seen[0].changed).toBe(true);
		expect(seen[1].changed).toBe(false);
	});
});

describe("machine state", () => {
	it("tracks the active tool", () => {
		const { state } = run(["T0", "G1 X1", "T1"]);
		expect(state.tool).toBe(1);
	});

	it("tracks relative extrusion mode", () => {
		expect(run(["M83"]).state.relativeE).toBe(true);
		expect(run(["M83", "M82"]).state.relativeE).toBe(false);
	});

	it("tracks relative axis mode and applies it to Z", () => {
		const { state } = run(["G90", "G1 Z1", "G91", "G1 Z0.5"]);
		expect(state.z).toBeCloseTo(1.5);
	});

	it("takes Z from G92", () => {
		expect(run(["G1 Z5", "G92 Z0"]).state.z).toBe(0);
	});

	it("tracks the feedrate", () => {
		expect(run(["G1 X1 F1200", "G1 X2"]).state.feedrate).toBe(1200);
	});

	it("tracks the M486 object by number and by label", () => {
		expect(run(["M486 S2"]).state.object).toBe("2");
		expect(run(["M486 S2 A\"handle\""]).state.object).toBe("handle");
		expect(run(["M486 S2", "M486 S-1"]).state.object).toBeNull();
	});

	it("tracks the slicer feature type", () => {
		expect(run([";TYPE:External perimeter"]).state.featureType).toBe("External perimeter");
	});

	it("counts lines from 1", () => {
		expect(run(["G1 X1", "G1 X2"]).state.lineNo).toBe(2);
	});
});
