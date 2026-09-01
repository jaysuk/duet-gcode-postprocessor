/**
 * Golden-file tests: every bundled preset run against every fixture, with the output committed.
 *
 * A change in any transformation shows up here as a reviewable diff rather than as a surprise on
 * someone's printer. The expected files live in `test/golden/` and are regenerated with
 * `npx vitest run -u` — which should only ever be done with the resulting diff read line by line.
 *
 * The fixtures are hand-written in the shape each slicer actually emits (marker comments, metadata
 * blocks, command ordering) rather than captured from a real slice, so they stay small enough to
 * read in a diff. Where a real file differs is in volume, not in structure.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyseText } from "../model/analysis";
import { parseMetadata } from "../model/gcode/metadata";
import { runToString } from "../model/pipeline";
import { PRESETS } from "../model/presets";
import { buildTransforms } from "../model/recipe";

const FIXTURES = ["prusaslicer", "cura", "orcaslicer", "two-tool", "arc-circle"] as const;

function loadFixture(name: string): string {
	return readFileSync(resolve(__dirname, "../../test/fixtures", `${name}.gcode`), "utf-8")
		.replace(/\r\n/g, "\n");
}

describe("fixtures parse as expected", () => {
	it("reads PrusaSlicer", () => {
		const text = loadFixture("prusaslicer");
		const meta = parseMetadata(text);
		expect(meta.slicer).toBe("PrusaSlicer");
		expect(meta.totalLayers).toBe(4);
		const analysis = analyseText(text, meta);
		expect(analysis.layers).toBe(4);
		expect(analysis.dialect.flavour).toBe("marlin");
		expect(analysis.dialect.unsupported.map((u) => u.code).sort()).toEqual(["M205", "M900"]);
	});

	it("reads Cura", () => {
		const text = loadFixture("cura");
		const meta = parseMetadata(text);
		expect(meta.slicer).toBe("Cura");
		expect(meta.totalLayers).toBe(3);
		const analysis = analyseText(text, meta);
		expect(analysis.layers).toBe(3);
		expect(analysis.usesRelativeE).toBe(false);
	});

	it("reads OrcaSlicer, including its M486 objects", () => {
		const text = loadFixture("orcaslicer");
		const meta = parseMetadata(text);
		expect(meta.slicer).toBe("OrcaSlicer");
		const analysis = analyseText(text, meta);
		expect(analysis.layers).toBe(3);
		expect(analysis.objects).toEqual(["cube"]);
	});

	it("reads the two-tool fixture (added for the preheat step, task 06/07)", () => {
		const text = loadFixture("two-tool");
		const meta = parseMetadata(text);
		expect(meta.slicer).toBe("PrusaSlicer");
		expect(meta.totalLayers).toBe(3);
		const analysis = analyseText(text, meta);
		expect(analysis.layers).toBe(3);
		expect(analysis.tools).toEqual([0, 1]);
	});

	it("reads the arc-circle fixture (added for arc welding, task 08)", () => {
		const text = loadFixture("arc-circle");
		const meta = parseMetadata(text);
		expect(meta.slicer).toBe("PrusaSlicer");
		expect(meta.totalLayers).toBe(1);
		const analysis = analyseText(text, meta);
		expect(analysis.layers).toBe(1);
	});
});

describe("golden output", () => {
	const cases = PRESETS.flatMap((preset) => FIXTURES.map((fixture) => [preset.key, fixture, preset] as const));

	it.each(cases)("%s applied to %s", async (key, fixture, preset) => {
		const input = loadFixture(fixture);
		const meta = parseMetadata(input);
		const recipe = preset.build();
		const { output } = runToString(
			{ transforms: buildTransforms(recipe, { scriptsTrusted: false }), meta, sourcePath: `0:/gcodes/${fixture}.gcode` },
			input,
		);
		await expect(output).toMatchFileSnapshot(resolve(__dirname, "../../test/golden", `${key}.${fixture}.gcode`));
	});

	it.each(FIXTURES)("an empty recipe leaves %s byte-identical", (fixture) => {
		const input = loadFixture(fixture);
		expect(runToString({ transforms: [] }, input).output).toBe(input);
	});
});
