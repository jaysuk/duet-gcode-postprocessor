import { describe, expect, it } from "vitest";

import {
	fanByFeatureStep, inScaleRange, parseFeatureOverrides, parseOverrideEntries,
} from "../model/steps/fanByFeature";
import { getStepDefinition } from "../model/steps/registry";
import { runStep } from "./helpers";

const BRIDGE_FIXTURE = [
	";LAYER_CHANGE",
	";TYPE:External perimeter",
	"M106 P0 S128",
	"G1 X1 Y1",
	";TYPE:Bridge infill",
	"G1 X2 Y2",
	";TYPE:External perimeter",
	"G1 X3 Y3",
].join("\n");

describe("parseOverrideEntries / parseFeatureOverrides", () => {
	it("parses comma- and newline-separated entries", () => {
		expect([...parseFeatureOverrides("bridge=255, overhang=255\nexternalPerimeter=180").entries()])
			.toEqual([["bridge", 255], ["overhang", 255], ["externalPerimeter", 180]]);
	});

	it("is case-insensitive on the feature key", () => {
		expect(parseFeatureOverrides("BRIDGE=255").get("bridge")).toBe(255);
		expect(parseFeatureOverrides("Bridge=255").get("bridge")).toBe(255);
	});

	it("accepts : as well as = ", () => {
		expect(parseFeatureOverrides("bridge:255").get("bridge")).toBe(255);
	});

	it("flags an unrecognised feature name rather than silently dropping it", () => {
		// The value parses fine on its own — it is specifically the key that is not recognised
		const entries = parseOverrideEntries("brige=255");
		expect(entries[0]).toEqual({ raw: "brige=255", feature: null, speed: 255 });
	});

	it("flags a non-numeric value", () => {
		const entries = parseOverrideEntries("bridge=fast");
		expect(entries[0]).toEqual({ raw: "bridge=fast", feature: null, speed: null });
	});

	it("ignores blank entries from stray commas or blank lines", () => {
		expect(parseOverrideEntries("bridge=255,,\n\noverhang=255")).toHaveLength(2);
	});

	it("parses a fractional speed", () => {
		expect(parseFeatureOverrides("bridge=0.8").get("bridge")).toBe(0.8);
	});
});

describe("inScaleRange", () => {
	it("checks the 0-255 range", () => {
		expect(inScaleRange(255, "0-255")).toBe(true);
		expect(inScaleRange(256, "0-255")).toBe(false);
		expect(inScaleRange(-1, "0-255")).toBe(false);
	});

	it("checks the 0-1 range", () => {
		expect(inScaleRange(1, "0-1")).toBe(true);
		expect(inScaleRange(1.1, "0-1")).toBe(false);
		expect(inScaleRange(0.5, "0-1")).toBe(true);
	});
});

describe("the fanByFeature step", () => {
	it("emits the override on entering a configured feature", () => {
		const out = runStep("fanByFeature", { overrides: "bridge=255" }, BRIDGE_FIXTURE);
		const lines = out.split("\n");
		const typeIndex = lines.indexOf(";TYPE:Bridge infill");
		expect(lines[typeIndex + 1]).toBe("M106 P0 S255");
	});

	it("suppresses the slicer's own M106 while inside an overridden region", () => {
		const input = [";TYPE:Bridge infill", "M106 P0 S200", "G1 X1"].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=255" }, input);
		expect(out).toContain(";M106 P0 S200 suppressed by fan override");
		expect(out).not.toMatch(/^M106 P0 S200$/m);
	});

	it("deletes the suppressed line instead of commenting when configured to", () => {
		const input = [";TYPE:Bridge infill", "M106 P0 S200", "G1 X1"].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=255", action: "delete" }, input);
		expect(out).not.toContain("S200");
	});

	it("restores the speed that was in force before the override, exactly once", () => {
		const out = runStep("fanByFeature", { overrides: "bridge=255" }, BRIDGE_FIXTURE);
		const lines = out.split("\n");
		// "M106 P0 S128" appears twice in total: the original, untouched slicer line (it sits
		// before the bridge region even starts, so it is never suppressed) plus one injected
		// restore — the restore itself must fire exactly once, immediately after the second
		// ";TYPE:External perimeter" line that ends the bridge region
		expect(lines.filter((l) => l === "M106 P0 S128")).toHaveLength(2);
		const secondType = lines.lastIndexOf(";TYPE:External perimeter");
		expect(lines[secondType + 1]).toBe("M106 P0 S128");
		expect(lines[secondType + 2]).not.toBe("M106 P0 S128");
	});

	it("restores to 0 when the file never set its own fan speed before the override", () => {
		const input = [";TYPE:Bridge infill", "G1 X1", ";TYPE:Solid infill", "G1 X2"].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=255" }, input);
		expect(out).toContain("M106 P0 S0");
	});

	it("is byte-identical when no override matches anything in the file", () => {
		expect(runStep("fanByFeature", { overrides: "support=255" }, BRIDGE_FIXTURE)).toBe(BRIDGE_FIXTURE);
	});

	it("is byte-identical with no overrides configured at all", () => {
		expect(runStep("fanByFeature", { overrides: "" }, BRIDGE_FIXTURE)).toBe(BRIDGE_FIXTURE);
	});

	it("ends an override at a layer change even when the same feature label continues", () => {
		const input = [
			";LAYER_CHANGE", ";TYPE:Bridge infill", "G1 X1",
			";LAYER_CHANGE", "G1 X2", // still "Bridge infill" — no fresh TYPE comment
		].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=255" }, input);
		const lines = out.split("\n");
		// Second LAYER_CHANGE: restore (leaving) immediately followed by re-entering the same feature
		const secondLayerChange = lines.lastIndexOf(";LAYER_CHANGE");
		expect(lines[secondLayerChange + 1]).toBe("M106 P0 S0");
		expect(lines[secondLayerChange + 2]).toBe("M106 P0 S255");
	});

	it("honours the first-layer override independently of any feature settings", () => {
		const input = [";LAYER_CHANGE", "G1 X1", ";LAYER_CHANGE", "G1 X2"].join("\n");
		const out = runStep("fanByFeature", { overrides: "", firstLayerEnabled: true, firstLayerSpeed: 50 }, input);
		const lines = out.split("\n");
		expect(lines[1]).toBe("M106 P0 S50"); // right after the first LAYER_CHANGE
		expect(lines).toContain("M106 P0 S0"); // restored once layer 1 begins
	});

	it("gives the first-layer override priority over a feature override on layer 0", () => {
		const input = [";LAYER_CHANGE", ";TYPE:Bridge infill", "G1 X1"].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=255", firstLayerEnabled: true, firstLayerSpeed: 50 }, input);
		expect(out).toContain("M106 P0 S50");
		expect(out).not.toContain("M106 P0 S255");
	});

	it("does not emit a trailing restore when the file ends mid-region", () => {
		const input = [";TYPE:Bridge infill", "G1 X1"].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=255" }, input);
		expect(out.split("\n").at(-1)).toBe("G1 X1");
	});

	it("round-trips a 0-1 scale value unchanged", () => {
		const input = [";TYPE:Bridge infill", "G1 X1"].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=0.8", scale: "0-1" }, input);
		expect(out).toContain("M106 P0 S0.8");
	});

	it("round-trips a 0-255 scale value unchanged", () => {
		const input = [";TYPE:Bridge infill", "G1 X1"].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=255", scale: "0-255" }, input);
		expect(out).toContain("M106 P0 S255");
	});

	it("treats M107 as speed 0 for restore purposes", () => {
		const input = [";TYPE:External perimeter", "M107 P0", ";TYPE:Bridge infill", "G1 X1", ";TYPE:External perimeter"].join("\n");
		const out = runStep("fanByFeature", { overrides: "bridge=255" }, input);
		const lines = out.split("\n");
		expect(lines[lines.lastIndexOf(";TYPE:External perimeter")]).toBe(";TYPE:External perimeter");
		expect(out.split("M106 P0 S255")[1]).toContain("M106 P0 S0");
	});
});

describe("validate", () => {
	const def = getStepDefinition("fanByFeature")!;

	it("requires at least one override or the first-layer override", () => {
		const errors = fanByFeatureStep.validate!({
			overrides: "", scale: "0-255", firstLayerEnabled: false, firstLayerSpeed: 0,
			action: "comment", note: "x",
		});
		expect(errors.some((e) => e.includes("at least one"))).toBe(true);
	});

	it("accepts a config with only a first-layer override", () => {
		const errors = fanByFeatureStep.validate!({
			overrides: "", scale: "0-255", firstLayerEnabled: true, firstLayerSpeed: 0,
			action: "comment", note: "x",
		});
		expect(errors).toEqual([]);
	});

	it("flags an out-of-range speed for the configured scale", () => {
		const errors = fanByFeatureStep.validate!({
			overrides: "bridge=2", scale: "0-1", firstLayerEnabled: false, firstLayerSpeed: 0,
			action: "comment", note: "x",
		});
		expect(errors.some((e) => e.includes("outside the 0-1 range"))).toBe(true);
	});

	it("flags an unrecognised feature and a non-numeric value with actionable messages", () => {
		const errors = fanByFeatureStep.validate!({
			overrides: "brige=255, bridge=fast", scale: "0-255", firstLayerEnabled: false, firstLayerSpeed: 0,
			action: "comment", note: "x",
		});
		// One message per malformed entry, plus the catch-all: neither entry parsed successfully,
		// so nothing this recipe would actually do — that is worth its own message too
		expect(errors).toHaveLength(3);
		expect(errors.some((e) => e.includes("at least one"))).toBe(true);
	});

	it("does not add the catch-all once at least one entry parses successfully", () => {
		const errors = fanByFeatureStep.validate!({
			overrides: "bridge=255, brige=255", scale: "0-255", firstLayerEnabled: false, firstLayerSpeed: 0,
			action: "comment", note: "x",
		});
		expect(errors).toHaveLength(1);
	});

	it("registers with a working default config", () => {
		expect(def.id).toBe("fanByFeature");
	});
});
