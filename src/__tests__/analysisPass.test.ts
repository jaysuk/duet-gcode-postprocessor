import { describe, expect, it } from "vitest";

import { AnalysisRunner, type AnalysisCollector } from "../model/analysisPass";
import { runToString } from "../model/pipeline";
import type { LineContext, Transform } from "../model/steps/types";
import { SAMPLE } from "./helpers";

/** Records a plain snapshot of every field a collector or step actually gets to see, in order. */
function snapshot(ctx: LineContext, line: string): Record<string, unknown> {
	return {
		line,
		lineNo: ctx.lineNo,
		layer: ctx.layer,
		z: ctx.z,
		tool: ctx.tool,
		feedrate: ctx.feedrate,
		relativeMoves: ctx.relativeMoves,
		relativeE: ctx.relativeE,
		object: ctx.object,
		featureType: ctx.featureType,
		layerChanged: ctx.layerChanged,
		sawLayerMarker: ctx.sawLayerMarker,
		progress: ctx.progress,
		code: ctx.token.code,
	};
}

class RecordingCollector implements AnalysisCollector<Array<Record<string, unknown>>> {
	readonly id = "recorder";
	seen: Array<Record<string, unknown>> = [];

	onLine(ctx: LineContext, line: string): void {
		this.seen.push(snapshot(ctx, line));
	}

	result(): Array<Record<string, unknown>> {
		return this.seen;
	}
}

function driveTransformPass(input: string): Array<Record<string, unknown>> {
	const recorded: Array<Record<string, unknown>> = [];
	const recorder: Transform = {
		id: "recorder",
		onLine(ctx, line) {
			recorded.push(snapshot(ctx, line));
			return undefined;
		},
	};
	runToString({ transforms: [recorder], totalBytes: input.length }, input);
	return recorded;
}

/** Drive an AnalysisRunner over a string the same way processFile's forEachLine would. */
function driveAnalysisPass(collectors: Array<AnalysisCollector>, input: string): void {
	const runner = new AnalysisRunner({ collectors, totalBytes: input.length });
	let offset = 0;
	const lines = input.split("\n");
	const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	if (hasTrailingNewline) lines.pop();
	for (const rawLine of lines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		runner.line(line, offset);
		offset += rawLine.length + 1;
	}
}

describe("AnalysisRunner", () => {
	it("shows a collector every line exactly once, in order, with the transform pass's own LineContext values", () => {
		const collector = new RecordingCollector();
		driveAnalysisPass([collector], SAMPLE);
		const fromTransformPass = driveTransformPass(SAMPLE);

		expect(collector.seen.length).toBe(SAMPLE.split("\n").length);
		expect(collector.seen).toEqual(fromTransformPass);
	});

	it("runs every collector over the same lines independently", () => {
		const a = new RecordingCollector();
		const b = new RecordingCollector();
		driveAnalysisPass([a, b], SAMPLE);
		expect(a.seen).toEqual(b.seen);
	});

	it("produces a results map keyed by collector id", () => {
		const collector = new RecordingCollector();
		const runner = new AnalysisRunner({ collectors: [collector] });
		runner.line("G28", 0);
		const results = runner.result();
		expect(results.get("recorder")).toEqual(collector.seen);
		expect(results.has("nonexistent")).toBe(false);
	});

	it("does nothing when there are no collectors", () => {
		const runner = new AnalysisRunner({ collectors: [] });
		runner.line("G28", 0);
		expect(runner.result().size).toBe(0);
	});
});
