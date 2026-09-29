import { describe, expect, it } from "vitest";

import { adaptiveMeshStep, buildM557, computeGrid, isGridM557, isProbingG29, type AdaptiveMeshConfig } from "../model/steps/adaptiveMesh";
import { defaultConfig } from "../model/steps/registry";
import type { StepFactoryContext } from "../model/steps/types";
import { runStepsWithAnalysis } from "./helpers";

function run(input: string, config: Record<string, unknown> = {}, ctx: StepFactoryContext = { scriptsTrusted: true }) {
	const stepConfig = { ...defaultConfig("adaptiveMesh"), ...config };
	const transform = adaptiveMeshStep.create(stepConfig as never, ctx);
	const collectors = adaptiveMeshStep.analysis?.(stepConfig as never, ctx) ?? [];
	return runStepsWithAnalysis([transform], collectors, input);
}

/** A purge line at the bed edge, then a 40x20 first layer at (100..140, 100..120), then a wider layer 2. */
const PRINT = [
	"M83",
	"G28",
	"G29",
	";TYPE:Custom",
	"G1 X5 Y1 E1 F1200",
	"G1 X60 Y1 E2",
	";LAYER_CHANGE",
	";TYPE:External perimeter",
	"G1 X100 Y100 F6000",
	"G1 X140 Y100 E1 F1200",
	"G1 X140 Y120 E1",
	"G1 X100 Y120 E1",
	";LAYER_CHANGE",
	"G1 X90 Y90 F6000",
	"G1 X150 Y90 E1 F1200",
].join("\n");

describe("adaptiveMesh", () => {
	it("inserts M557 before the first G29, sized to the first layer plus the margin", () => {
		const { output } = run(PRINT, { spacingMm: 20, marginMm: 5 });
		const lines = output.split("\n");
		const at = lines.findIndex((l) => l.startsWith("M557"));
		expect(lines[at]).toBe("M557 X95:145 Y95:125 S20 ; adaptive mesh");
		expect(lines[at + 1]).toBe("G29");
	});

	it("ignores the purge line, but uses it (with a warning) if that is all the file has", () => {
		const input = ["M83", "G29", ";TYPE:Custom", "G1 X5 Y1 E1 F1200", "G1 X60 Y1 E2"].join("\n");
		const { output, pipeline } = run(input, { spacingMm: 10, marginMm: 0 });
		expect(output).toContain("M557 X5:60 Y-4:6 S10");
		expect(pipeline.stats.warnings.some((w) => w.includes("every extruding move"))).toBe(true);
	});

	it("covers the whole print when firstLayerOnly is off", () => {
		const { output } = run(PRINT, { firstLayerOnly: false, marginMm: 0, spacingMm: 10 });
		expect(output).toContain("M557 X90:150 Y90:120 S10");
	});

	it("replaces an existing M557, keeping a delta radius", () => {
		const input = ["M83", "M557 R100 X0:200 Y0:200 S30", "G29", ";LAYER_CHANGE", "G1 X50 Y50 F6000", "G1 X60 Y50 E1", "G1 X60 Y60 E1"].join("\n");
		const { output } = run(input, { marginMm: 0, spacingMm: 5 });
		const lines = output.split("\n");
		expect(lines.filter((l) => l.startsWith("M557"))).toEqual(["M557 X50:60 Y50:60 R100 S5 ; adaptive mesh"]);
		expect(lines).toHaveLength(input.split("\n").length);
	});

	it("does not touch a G29 that only loads or saves a height map", () => {
		const input = ["G29 S1", ";LAYER_CHANGE", "G1 X50 Y50 F6000", "G1 X60 Y50 E1"].join("\n");
		const { output, pipeline } = run(input);
		expect(output).toBe(input);
		expect(pipeline.stats.warnings.some((w) => w.includes("no M557 or G29"))).toBe(true);
	});

	it("can put M557 at the top when the probing is in a macro", () => {
		const input = ['M98 P"start.g"', ";LAYER_CHANGE", "G1 X50 Y50 F6000", "G1 X60 Y50 E1", "G1 X60 Y60 E1"].join("\n");
		const { output } = run(input, { ifNoAnchor: "top", marginMm: 0, spacingMm: 5 });
		expect(output.split("\n")[0]).toBe("M557 X50:60 Y47.5:52.5 S5 ; adaptive mesh");
	});

	it("writes the points form when asked for a point count", () => {
		const { output } = run(PRINT, { density: "points", points: 4, marginMm: 0 });
		expect(output).toContain("M557 X100:140 Y100:120 P4:4 ; adaptive mesh");
	});

	it("includes an arc's bulge, not just its endpoints", () => {
		// Half circle from (0,0) to (10,0) about centre (5,0), counter-clockwise: bulges to y = -5
		const input = ["M83", "G29", ";LAYER_CHANGE", "G1 X0 Y0 F6000", "G3 X10 Y0 I5 J0 E1 F1200"].join("\n");
		const { output } = run(input, { marginMm: 0, spacingMm: 1 });
		expect(output).toContain("M557 X0:10 Y-5:0 S1");
	});

	it("handles relative E and G92 E0", () => {
		const input = ["M83", "G29", ";LAYER_CHANGE", "G1 X10 Y10 F6000", "G1 X20 Y10 E-1", "G92 E0", "G1 X30 Y10 E1"].join("\n");
		const { output } = run(input, { marginMm: 0, spacingMm: 1 });
		// The E-1 move is a retraction and contributes nothing; the one extruding move runs (20,10)->(30,10),
		// and a zero-height axis is widened to the spacing about its centre
		expect(output).toContain("M557 X20:30 Y9.5:10.5 S1");
	});

	it("keeps a print smaller than the spacing wide enough to probe", () => {
		const grid = computeGrid({ minX: 100, maxX: 102, minY: 100, maxY: 102 }, { ...(defaultConfig("adaptiveMesh") as unknown as AdaptiveMeshConfig), marginMm: 0, spacingMm: 20 });
		expect(grid).toEqual({ minX: 91, maxX: 111, minY: 91, maxY: 111 });
	});

	it("clips to the probeable area, and slides rather than shrinks a too-small print at its edge", () => {
		const config = { ...(defaultConfig("adaptiveMesh") as unknown as AdaptiveMeshConfig), marginMm: 5, spacingMm: 20, clampToBed: true, bedMinX: 10, bedMaxX: 290, bedMinY: 10, bedMaxY: 290 };
		expect(computeGrid({ minX: 0, maxX: 100, minY: 50, maxY: 100 }, config)).toEqual({ minX: 10, maxX: 105, minY: 45, maxY: 105 });
		expect(computeGrid({ minX: 12, maxX: 14, minY: 50, maxY: 100 }, { ...config, marginMm: 0 })).toEqual({ minX: 10, maxX: 30, minY: 50, maxY: 100 });
		expect(computeGrid({ minX: 400, maxX: 420, minY: 50, maxY: 100 }, config)).toBeNull();
	});

	it("warns when the grid would exceed the firmware's point capacity", () => {
		const { pipeline } = run(PRINT, { firstLayerOnly: false, spacingMm: 1, marginMm: 0 });
		expect(pipeline.stats.warnings.some((w) => w.includes("probe points"))).toBe(true);
	});

	it("warns and changes nothing for a file with no extrusion", () => {
		const input = ["G28", "G29", "G1 X10 Y10 F6000"].join("\n");
		const { output, pipeline } = run(input);
		expect(output).toBe(input);
		expect(pipeline.stats.warnings.some((w) => w.includes("no extruding"))).toBe(true);
	});

	it("does not confuse the deprecated G32 point form with a grid", () => {
		expect(isGridM557("M557 P1 X30 Y40.5")).toBe(false);
		expect(isGridM557("M557 X0:200 Y0:220 S20")).toBe(true);
		expect(isGridM557("M557 R150 S15")).toBe(true);
		expect(isProbingG29("G29")).toBe(true);
		expect(isProbingG29("G29 S0")).toBe(true);
		expect(isProbingG29("G29 S1")).toBe(false);
	});

	it("rejects an inverted probeable area", () => {
		const config = { ...defaultConfig("adaptiveMesh"), clampToBed: true, bedMinX: 100, bedMaxX: 50 };
		expect(adaptiveMeshStep.validate?.(config as never)).toContain("Probeable X max must be greater than X min");
	});

	it("formats spacing with no trailing zeros", () => {
		const config = { ...(defaultConfig("adaptiveMesh") as unknown as AdaptiveMeshConfig), spacingMm: 12.5 };
		expect(buildM557({ minX: 0, maxX: 10, minY: 0, maxY: 10 }, config, null)).toBe("M557 X0:10 Y0:10 S12.5 ; adaptive mesh");
	});
});
