import { describe, expect, it } from "vitest";

import { emptyMetadata, parseMetadata } from "../model/gcode/metadata";
import { mapCommand, parseAddParams, parseLetters, parseParamMap } from "../model/steps/commandMap";
import { applyOp } from "../model/steps/paramRewrite";
import { bandForLayer, bandValue } from "../model/steps/rangeVary";
import { defaultConfig, getStepDefinition, STEP_DEFINITIONS } from "../model/steps/registry";
import { StepConfigError, validateStep, withDefaults } from "../model/steps/types";
import { runStep, SAMPLE } from "./helpers";

describe("findReplace", () => {
	it("replaces literally by default", () => {
		const out = runStep("findReplace", { find: "M104", replace: "M568" }, "M104 S210\nM140 S60");
		expect(out).toBe("M568 S210\nM140 S60");
	});

	it("does not treat a literal find as a regex", () => {
		const out = runStep("findReplace", { find: "M104 S210" }, "M104 S210");
		expect(out).toBe("");
		const dots = runStep("findReplace", { find: "G1.X", replace: "!" }, "G1 X10");
		expect(dots).toBe("G1 X10");
	});

	it("supports regex with capture groups", () => {
		const out = runStep(
			"findReplace",
			{ find: "^M900 K([\\d.]+)", replace: "M572 D0 S$1", regex: true },
			"M900 K0.05",
		);
		expect(out).toBe("M572 D0 S0.05");
	});

	it("honours case sensitivity", () => {
		expect(runStep("findReplace", { find: "m104", replace: "X" }, "M104")).toBe("M104");
		expect(runStep("findReplace", { find: "m104", replace: "X", caseSensitive: false }, "M104")).toBe("X");
	});

	it("honours whole-word matching", () => {
		expect(runStep("findReplace", { find: "M10", replace: "X", wholeWord: true }, "M104")).toBe("M104");
		expect(runStep("findReplace", { find: "M10", replace: "X", wholeWord: true }, "M10 S1")).toBe("X S1");
	});

	it("replaces every occurrence by default and only the first when asked", () => {
		expect(runStep("findReplace", { find: "A", replace: "B" }, "A A A")).toBe("B B B");
		expect(runStep("findReplace", { find: "A", replace: "B", all: false }, "A A A")).toBe("B A A");
	});

	it("resets a global regex between lines", () => {
		// A `g` regex keeps lastIndex; without the reset, every other line silently escapes
		const out = runStep("findReplace", { find: "X", replace: "Y", regex: true }, "X\nX\nX\nX");
		expect(out).toBe("Y\nY\nY\nY");
	});

	it("applies only inside the layer range", () => {
		const out = runStep("findReplace", { find: "F1800", replace: "F900", layerFrom: 1 }, SAMPLE);
		expect(out).toContain("G1 X20 Y10 E2 F1800"); // layer 0
		expect(out).toContain("G1 X10 Y20 E3 F900"); // layer 1
	});

	it("rejects an invalid regex at build time", () => {
		expect(() => runStep("findReplace", { find: "([", regex: true }, "x")).toThrow(StepConfigError);
	});
});

describe("commandMap", () => {
	it("parses its little config languages", () => {
		expect(parseParamMap("K=S, T -> D")).toEqual([{ from: "K", to: "S" }, { from: "T", to: "D" }]);
		expect(parseAddParams("D0, S1")).toEqual([{ letter: "D", value: "0" }, { letter: "S", value: "1" }]);
		expect(parseLetters("T, P")).toEqual(["T", "P"]);
	});

	it("maps M900 K to M572 D0 S — the case a find/replace gets wrong", () => {
		const out = mapCommand("M900 K0.05", {
			from: "M900", to: "M572",
			renames: [{ from: "K", to: "S" }], adds: [{ letter: "D", value: "0" }], drops: [],
			onlyWithParam: "", keepOriginal: false,
		});
		expect(out).toBe("M572 S0.05 D0");
	});

	it("keeps the original as a comment when asked", () => {
		const out = mapCommand("M900 K0.05", {
			from: "M900", to: "M572", renames: [], adds: [], drops: [], onlyWithParam: "", keepOriginal: true,
		});
		expect(out).toBe("M572 K0.05 ; was: M900 K0.05");
	});

	it("drops unwanted parameters", () => {
		const out = mapCommand("M205 X8 Y8 J0.02", {
			from: "M205", to: "M566", renames: [], adds: [], drops: ["J"], onlyWithParam: "", keepOriginal: false,
		});
		expect(out).toBe("M566 X8 Y8");
	});

	it("preserves an existing comment", () => {
		const out = mapCommand("M900 K0.05 ; linear advance", {
			from: "M900", to: "M572", renames: [], adds: [], drops: [], onlyWithParam: "", keepOriginal: false,
		});
		expect(out).toBe("M572 K0.05 ; linear advance");
	});

	it("returns null for a different command", () => {
		expect(mapCommand("M104 S200", {
			from: "M900", to: "M572", renames: [], adds: [], drops: [], onlyWithParam: "", keepOriginal: false,
		})).toBeNull();
	});

	it("does not add a parameter that is already present", () => {
		const out = mapCommand("M900 D1 K0.05", {
			from: "M900", to: "M572", renames: [], adds: [{ letter: "D", value: "0" }], drops: [],
			onlyWithParam: "", keepOriginal: false,
		});
		expect(out).toBe("M572 D1 K0.05");
	});

	it("only maps a line that carries onlyWithParam, leaving others untouched", () => {
		const spec = {
			from: "M104", to: "M568", renames: [{ from: "T", to: "P" }], adds: [], drops: [],
			onlyWithParam: "T", keepOriginal: false,
		};
		expect(mapCommand("M104 S200 T1", spec)).toBe("M568 S200 P1");
		expect(mapCommand("M104 S200", spec)).toBeNull();
	});
});

describe("insertAt", () => {
	it("inserts at the start and end of the file", () => {
		const out = runStep("insertAt", { anchor: "fileStart", text: "; top" }, "G28\nG1 X1");
		expect(out.split("\n")[0]).toBe("; top");
		const end = runStep("insertAt", { anchor: "fileEnd", text: "; bottom" }, "G28\nG1 X1");
		expect(end.split("\n").at(-1)).toBe("; bottom");
	});

	it("inserts before a specific layer", () => {
		const out = runStep("insertAt", { anchor: "layer", layer: 1, position: "before", text: "M25" }, SAMPLE);
		const lines = out.split("\n");
		const marker = lines.indexOf("M25");
		expect(marker).toBeGreaterThan(0);
		expect(lines[marker + 1]).toBe(";LAYER_CHANGE");
		// exactly once
		expect(lines.filter((l) => l === "M25")).toHaveLength(1);
	});

	it("inserts at every layer change, and honours the interval", () => {
		const every = runStep("insertAt", { anchor: "everyLayer", text: "M118 S\"layer\"" }, SAMPLE);
		expect(every.split("\n").filter((l) => l.startsWith("M118"))).toHaveLength(3);
		const alternate = runStep("insertAt", { anchor: "everyLayer", interval: 2, text: "M118 S\"layer\"" }, SAMPLE);
		expect(alternate.split("\n").filter((l) => l.startsWith("M118"))).toHaveLength(2);
	});

	it("expands placeholders", () => {
		const out = runStep("insertAt", { anchor: "layer", layer: 1, text: "M117 layer {layer} z{z}" }, SAMPLE);
		expect(out).toContain("M117 layer 1 z0.2");
	});

	it("inserts at a Z height exactly once", () => {
		const out = runStep("insertAt", { anchor: "z", z: 0.4, text: "; at Z" }, SAMPLE);
		expect(out.split("\n").filter((l) => l === "; at Z")).toHaveLength(1);
	});

	it("inserts at a tool change", () => {
		const out = runStep("insertAt", { anchor: "toolChange", text: "; purge" }, "T0\nG1 X1\nT1\nG1 X2");
		expect(out.split("\n").filter((l) => l === "; purge")).toHaveLength(2);
	});

	it("inserts wherever a pattern matches, and once when asked", () => {
		const all = runStep("insertAt", { anchor: "match", pattern: "M104", text: "; temp" }, "M104 S1\nG1\nM104 S2");
		expect(all.split("\n").filter((l) => l === "; temp")).toHaveLength(2);
		const once = runStep("insertAt", { anchor: "match", pattern: "M104", text: "; temp", once: true }, "M104 S1\nG1\nM104 S2");
		expect(once.split("\n").filter((l) => l === "; temp")).toHaveLength(1);
	});

	it("inserts multiple lines in order", () => {
		const out = runStep("insertAt", { anchor: "fileStart", text: "; a\n; b\n; c" }, "G28");
		expect(out.split("\n").slice(0, 3)).toEqual(["; a", "; b", "; c"]);
	});

	it("expands a typed {meta.*} field", () => {
		// SAMPLE's own "; total layers count = 3" header line normalises to totalLayers = 3
		const meta = parseMetadata(SAMPLE);
		const out = runStep("insertAt", { anchor: "layer", layer: 1, text: "M117 of {meta.totalLayers}" }, SAMPLE, meta);
		expect(out).toContain("M117 of 3");
	});

	it("expands a raw {meta.<key>} field from the normalised values map", () => {
		const meta = { ...emptyMetadata(), values: new Map([["layer_height", "0.2"]]) };
		const out = runStep("insertAt", { anchor: "layer", layer: 1, text: "; lh {meta.layer_height}" }, SAMPLE, meta);
		expect(out).toContain("; lh 0.2");
	});

	it("leaves an unknown {meta.*} key literally intact, rather than expanding to empty", () => {
		const out = runStep("insertAt", { anchor: "layer", layer: 1, text: "M104 S{meta.first_layer_temperature}" }, SAMPLE);
		expect(out).toContain("M104 S{meta.first_layer_temperature}");
	});
});

describe("deleteLines", () => {
	it("comments out by default and keeps the line", () => {
		const out = runStep("deleteLines", { pattern: "M140" }, "M140 S60\nG28");
		expect(out).toBe(";M140 S60 disabled by post-processor\nG28");
	});

	it("deletes when asked", () => {
		expect(runStep("deleteLines", { pattern: "M140", action: "delete" }, "M140 S60\nG28")).toBe("G28");
	});

	it("respects the layer range", () => {
		const out = runStep("deleteLines", { pattern: "^G1 Z", regex: true, action: "delete", layerFrom: 2 }, SAMPLE);
		expect(out).toContain("G1 Z0.2 F9000");
		expect(out).not.toContain("G1 Z0.6 F9000");
	});
});

describe("paramRewrite", () => {
	it("does the arithmetic", () => {
		expect(applyOp("scale", 100, { value: 0.8, min: 0, max: 0 })).toBe(80);
		expect(applyOp("offset", 1, { value: 0.02, min: 0, max: 0 })).toBeCloseTo(1.02);
		expect(applyOp("set", 1, { value: 5, min: 0, max: 0 })).toBe(5);
		expect(applyOp("clamp", 500, { value: 0, min: 0, max: 100 })).toBe(100);
	});

	it("scales a feedrate and leaves everything else byte-identical", () => {
		const out = runStep("paramRewrite", { commands: "G1", param: "F", op: "scale", value: 0.5, decimals: 0 }, "G1 X10  Y20 E1 F1200 ; go");
		expect(out).toBe("G1 X10  Y20 E1 F600 ; go");
	});

	it("skips commands it was not asked about", () => {
		expect(runStep("paramRewrite", { commands: "G1", param: "F", op: "scale", value: 0.5 }, "G0 X1 F1200")).toBe("G0 X1 F1200");
	});

	it("skips lines without the parameter by default", () => {
		expect(runStep("paramRewrite", { commands: "G1", param: "F", op: "set", value: 600 }, "G1 X1")).toBe("G1 X1");
	});

	it("adds the parameter when told not to skip", () => {
		expect(runStep("paramRewrite", { commands: "G1", param: "F", op: "set", value: 600, skipMissing: false, decimals: 0 }, "G1 X1")).toBe("G1 X1 F600");
	});

	it("leaves an expression parameter alone", () => {
		expect(runStep("paramRewrite", { commands: "G1", param: "F", op: "scale", value: 0.5 }, "G1 F{var.speed}")).toBe("G1 F{var.speed}");
	});

	it("sees an earlier step's output rather than the original line", () => {
		// Two rewrites of the same parameter have to compose, so the second must re-tokenise
		const out = runStep("paramRewrite", { commands: "G1", param: "F", op: "scale", value: 0.5, decimals: 0 },
			runStep("paramRewrite", { commands: "G1", param: "F", op: "scale", value: 0.5, decimals: 0 }, "G1 F1200"));
		expect(out).toBe("G1 F300");
	});

	it("rejects a multi-letter parameter", () => {
		expect(() => runStep("paramRewrite", { commands: "G1", param: "XY" }, "G1")).toThrow(StepConfigError);
	});
});

describe("rangeVary", () => {
	it("spreads values inclusively across the bands", () => {
		expect(bandValue(0, 5, 0, 0.1)).toBeCloseTo(0);
		expect(bandValue(4, 5, 0, 0.1)).toBeCloseTo(0.1);
		expect(bandValue(2, 5, 0, 0.1)).toBeCloseTo(0.05);
	});

	it("maps layers onto bands", () => {
		expect(bandForLayer(0, 2, 10, 5)).toBe(-1);
		expect(bandForLayer(2, 2, 10, 5)).toBe(0);
		expect(bandForLayer(11, 2, 10, 5)).toBe(0);
		expect(bandForLayer(12, 2, 10, 5)).toBe(1);
		expect(bandForLayer(500, 2, 10, 5)).toBe(-1);
	});

	it("emits one command per band", () => {
		const out = runStep("rangeVary", {
			template: "M572 D0 S{value}", from: 0, to: 0.1, bands: 3, layersPerBand: 1,
			startLayer: 0, announce: false,
		}, SAMPLE);
		const emitted = out.split("\n").filter((l) => l.startsWith("M572"));
		expect(emitted).toEqual(["M572 D0 S0", "M572 D0 S0.05", "M572 D0 S0.1"]);
	});

	it("emits the announcement alongside", () => {
		const out = runStep("rangeVary", {
			template: "M572 D0 S{value}", from: 0, to: 0.1, bands: 3, layersPerBand: 1,
			startLayer: 0, announce: true, announceTemplate: "M117 band {band}: {value}",
		}, SAMPLE);
		expect(out).toContain("M117 band 1: 0");
		expect(out).toContain("M117 band 3: 0.1");
	});
});

describe("the registry", () => {
	it("has a definition for every id, with no duplicates", () => {
		const ids = STEP_DEFINITIONS.map((d) => d.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(getStepDefinition(id)).not.toBeNull();
	});

	// Self-maintaining: a step added later is covered without touching this file.
	// A freshly added step legitimately has empty required fields (there is nothing to find yet),
	// so the assertion is that nothing OTHER than "is required" comes back — a default that fails
	// its own type, range or regex validation is a bug in the step definition.
	it.each(STEP_DEFINITIONS.map((d) => [d.id, d] as const))("%s has defaults that only fail as 'required'", (id, def) => {
		const config = defaultConfig(id);
		const schemaErrors = validateStep(def, config).filter((e) => !e.endsWith("is required"));
		expect(schemaErrors).toEqual([]);
	});

	it.each(STEP_DEFINITIONS.map((d) => [d.id, d] as const))("%s builds once its required fields are filled", (id, def) => {
		const config = defaultConfig(id);
		// Fill anything blank with something plausible for its type, so create() is exercised
		for (const field of def.fields) {
			if (config[field.key] !== "" ) continue;
			config[field.key] = field.type === "regex" ? "M104"
				: field.key === "from" ? "M900"
				: field.key === "to" ? "M572"
				: field.type === "gcode" || field.type === "textarea" ? "; placeholder"
				: "M104";
		}
		expect(() => def.create(config as never, { scriptsTrusted: true })).not.toThrow();
	});

	it("refuses to build a script step until scripts are trusted", () => {
		const def = getStepDefinition("script")!;
		expect(() => def.create(defaultConfig("script") as never, { scriptsTrusted: false }))
			.toThrow(/Trust scripts/);
	});

	it.each(STEP_DEFINITIONS.map((d) => [d.id, d] as const))("%s declares complete field metadata", (_id, def) => {
		expect(def.label).not.toBe("");
		expect(def.description).not.toBe("");
		expect(def.icon.startsWith("mdi-")).toBe(true);
		for (const field of def.fields) {
			expect(field.key).not.toBe("");
			expect(field.label).not.toBe("");
			if (field.type === "select") expect(field.options?.length ?? 0).toBeGreaterThan(1);
			if (field.showWhen !== undefined) {
				expect(def.fields.some((f) => f.key === field.showWhen!.key)).toBe(true);
			}
		}
	});

	it("fills defaults for keys the stored config is missing", () => {
		const def = getStepDefinition("findReplace")!;
		const filled = withDefaults(def, { find: "X" });
		expect(filled.find).toBe("X");
		expect(filled.caseSensitive).toBe(true);
	});

	it("rejects a cleared numeric field rather than coercing it to zero", () => {
		// Vuetify leaves "" in a cleared v-model.number field, and isFinite("") is true
		const def = getStepDefinition("paramRewrite")!;
		const errors = validateStep(def, { ...defaultConfig("paramRewrite"), value: "" });
		expect(errors.length).toBeGreaterThan(0);
	});
});
