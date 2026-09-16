import { describe, expect, it } from "vitest";

import { runToString } from "../model/pipeline";
import type { LineContext, Transform } from "../model/steps/types";
import { makeStep, runSteps, SAMPLE } from "./helpers";

/** A step that does nothing, to prove the pipeline itself is transparent. */
const noop: Transform = { id: "noop", onLine: () => undefined };

/** Records `ctx.z` at every `onLine` call, to inspect state tracking without rewriting anything. */
function zSpy(): { transform: Transform; seen: Array<number | null> } {
	const seen: Array<number | null> = [];
	return {
		transform: {
			id: "zSpy",
			onLine: (ctx: LineContext) => {
				seen.push(ctx.z);
				return undefined;
			},
		},
		seen,
	};
}

describe("the pipeline", () => {
	it("is byte-identical with no steps", () => {
		const { output } = runToString({ transforms: [] }, SAMPLE);
		expect(output).toBe(SAMPLE);
	});

	it("is byte-identical with a step that changes nothing", () => {
		expect(runToString({ transforms: [noop] }, SAMPLE).output).toBe(SAMPLE);
	});

	it("preserves a trailing newline, and its absence", () => {
		expect(runToString({ transforms: [noop] }, "G28\nG1 X1\n").output).toBe("G28\nG1 X1\n");
		expect(runToString({ transforms: [noop] }, "G28\nG1 X1").output).toBe("G28\nG1 X1");
	});

	it("strips CR from CRLF input", () => {
		// Windows-sliced files are common; leaving the CR in doubles it on every rewritten line
		expect(runToString({ transforms: [noop] }, "G28\r\nG1 X1\r\n").output).toBe("G28\nG1 X1\n");
	});

	it("feeds one step's output into the next", () => {
		const { output } = runSteps(
			[
				makeStep("findReplace", { find: "A", replace: "B" }),
				makeStep("findReplace", { find: "B", replace: "C" }),
			],
			"A",
		);
		expect(output).toBe("C");
	});

	it("runs later steps over lines an earlier step inserted", () => {
		const { output } = runSteps(
			[
				makeStep("insertAt", { anchor: "fileStart", text: "; MARKER" }),
				makeStep("findReplace", { find: "MARKER", replace: "REPLACED" }),
			],
			"G28",
		);
		// fileStart emissions come from onStart, before any line is processed, so they are NOT
		// re-fed through the chain — this documents that boundary rather than pretending otherwise
		expect(output).toBe("; MARKER\nG28");
	});

	it("runs later steps over lines a match-anchored insert produced", () => {
		const { output } = runSteps(
			[
				makeStep("insertAt", { anchor: "match", pattern: "G28", text: "; MARKER" }),
				makeStep("findReplace", { find: "MARKER", replace: "REPLACED" }),
			],
			"G28",
		);
		expect(output).toBe("G28\n; REPLACED");
	});

	it("stops running steps once a line has been dropped", () => {
		const { output, pipeline } = runSteps(
			[
				makeStep("deleteLines", { pattern: "G28", action: "delete" }),
				makeStep("findReplace", { find: "G28", replace: "SHOULD NOT HAPPEN" }),
			],
			"G28\nG1 X1",
		);
		expect(output).toBe("G1 X1");
		expect(pipeline.stats.linesRemoved).toBe(1);
	});

	it("counts what it did", () => {
		const { pipeline } = runSteps([makeStep("findReplace", { find: "F1800", replace: "F900" })], SAMPLE);
		expect(pipeline.stats.linesIn).toBe(SAMPLE.split("\n").length);
		expect(pipeline.stats.linesChanged).toBe(3);
		expect(pipeline.stats.linesAdded).toBe(0);
		expect(pipeline.stats.linesRemoved).toBe(0);
		expect(pipeline.stats.perStep[0]).toBe(3);
	});

	it("records a diff entry per change", () => {
		const { pipeline } = runSteps([makeStep("findReplace", { find: "F1800", replace: "F900" })], SAMPLE);
		expect(pipeline.diff).toHaveLength(3);
		expect(pipeline.diff[0].before).toContain("F1800");
		expect(pipeline.diff[0].after?.[0]).toContain("F900");
	});

	it("caps the diff and says so", () => {
		const input = Array.from({ length: 50 }, () => "M104 S1").join("\n");
		const { pipeline } = runToString(
			{ transforms: [makeStep("findReplace", { find: "S1", replace: "S2" })], maxDiffEntries: 10 },
			input,
		);
		expect(pipeline.diff).toHaveLength(10);
		expect(pipeline.stats.diffTruncated).toBe(true);
	});

	it("writes the stamp as the first line when given one", () => {
		const { output } = runToString({ transforms: [], stampLine: "; stamp" }, "G28");
		expect(output.split("\n")[0]).toBe("; stamp");
	});

	it("writes the core stamp as the first line when given one and no plugin stamp", () => {
		const { output } = runToString({ transforms: [], coreStampLine: "; core stamp" }, "G28");
		expect(output.split("\n")[0]).toBe("; core stamp");
	});

	it("writes the plugin stamp then the core stamp, in that order, when both are given", () => {
		const { output } = runToString({ transforms: [], stampLine: "; stamp", coreStampLine: "; core stamp" }, "G28");
		expect(output.split("\n").slice(0, 2)).toEqual(["; stamp", "; core stamp"]);
	});

	it("exposes machine state to a step through the line context", () => {
		const seen: Array<{ layer: number; tool: number; z: number | null }> = [];
		const spy: Transform = {
			id: "spy",
			onLine(ctx: LineContext) {
				if (ctx.layerChanged) seen.push({ layer: ctx.layer, tool: ctx.tool, z: ctx.z });
				return undefined;
			},
		};
		runToString({ transforms: [spy] }, SAMPLE);
		expect(seen.map((s) => s.layer)).toEqual([0, 1, 2]);
		expect(seen.every((s) => s.tool === 0)).toBe(true);
	});

	it("collects warnings a step raises, without duplicates", () => {
		const noisy: Transform = {
			id: "noisy",
			onStart(ctx) { ctx.warn("careful"); },
			onLine: () => undefined,
			onEnd(ctx) { ctx.warn("careful"); },
		};
		const { pipeline } = runToString({ transforms: [noisy] }, "G28");
		expect(pipeline.stats.warnings).toEqual(["careful"]);
	});

	it("produces the same bytes whatever order equivalent steps run in when they do not overlap", () => {
		const a = runSteps([
			makeStep("findReplace", { find: "M104", replace: "M568" }),
			makeStep("findReplace", { find: "M140", replace: "M141" }),
		], SAMPLE).output;
		const b = runSteps([
			makeStep("findReplace", { find: "M140", replace: "M141" }),
			makeStep("findReplace", { find: "M104", replace: "M568" }),
		], SAMPLE).output;
		expect(a).toBe(b);
	});

	describe("a line holding more than one command (RRF: 'G90 G1 X10' is two)", () => {
		it("stays byte-identical when nothing touches either command", () => {
			const { output } = runToString({ transforms: [noop] }, "G90 G1 Z5\nG1 X1 Y1");
			expect(output).toBe("G90 G1 Z5\nG1 X1 Y1");
		});

		it("tracks state through EVERY command on the line, not just the first", () => {
			const spy = zSpy();
			runToString({ transforms: [spy.transform] }, "G90 G1 Z5\nG1 X1 Y1");
			// Without the fix, `tokenise()` only ever sees "G90" on the combined line - the Z=5 move
			// is invisible to the state machine, so ctx.z would stay null through both onLine calls
			// on that line, and the second physical line would wrongly start from z=null too.
			expect(spy.seen).toContain(5);
			expect(spy.seen[spy.seen.length - 1]).toBe(5);
		});

		it("fires a Z-anchored insertion on a Z move hidden as a line's second command", () => {
			const insert = makeStep("insertAt", { anchor: "z", z: 5, tolerance: 0.05, text: "M300", position: "after" });
			const { output } = runToString({ transforms: [insert] }, "G90 G1 Z5\nG1 X1 Y1");
			const lines = output.split("\n");
			expect(lines).toContain("M300");
			// The insertion must land right after the piece that actually reached Z5, not after the
			// whole original two-command line as an undifferentiated block
			expect(lines[lines.indexOf("M300") - 1]).toBe("G1 Z5");
		});

		it("splits the physical line into pieces only when a step actually rewrites one of them", () => {
			const map = makeStep("commandMap", {
				from: "G1", to: "G0", paramMap: "", addParams: "", dropParams: "", keepOriginal: false,
			});
			const { output } = runToString({ transforms: [map] }, "G90 G1 Z5\nG1 X1 Y1");
			// G90 is untouched and must survive as its own line; only the matched G1 is rewritten
			expect(output).toBe("G90 \nG0 Z5\nG0 X1 Y1");
		});

		it("counts a multi-command line as one touched line per step, not one per command", () => {
			const map = makeStep("commandMap", { from: "G1", to: "G0", paramMap: "", addParams: "", dropParams: "" });
			// Two G1s on the SAME physical line - both get rewritten, but it is still one source line
			const { pipeline } = runToString({ transforms: [map] }, "G1 X1 G1 Y1");
			expect(pipeline.stats.perStep).toEqual([1]);
			expect(pipeline.stats.linesIn).toBe(1);
		});
	});
});
