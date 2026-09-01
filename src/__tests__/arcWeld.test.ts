import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runStep, runSteps, makeStep } from "./helpers";

/**
 * Lines tracing points on a circle, each a `G1 X.. Y.. E.. F..` extruding move. `anglesDeg` gives
 * every point after the starting one; the caller is expected to have already got the machine to the
 * first point (a travel move), matching how a real sliced file approaches a curve.
 */
function circleMoves(
	cx: number, cy: number, r: number, anglesDeg: Array<number>,
	options: { ePerMm?: number; feedrate?: number } = {},
): { lines: Array<string>; endX: number; endY: number; totalE: number } {
	const ePerMm = options.ePerMm ?? 0.03;
	const feedrate = options.feedrate ?? 1800;
	const lines: Array<string> = [];
	let prevX = cx + r * Math.cos((anglesDeg[0] * Math.PI) / 180);
	let prevY = cy + r * Math.sin((anglesDeg[0] * Math.PI) / 180);
	let totalE = 0;
	for (let i = 1; i < anglesDeg.length; i++) {
		const x = cx + r * Math.cos((anglesDeg[i] * Math.PI) / 180);
		const y = cy + r * Math.sin((anglesDeg[i] * Math.PI) / 180);
		const dist = Math.hypot(x - prevX, y - prevY);
		const de = dist * ePerMm;
		totalE += de;
		lines.push(`G1 X${x.toFixed(4)} Y${y.toFixed(4)} E${de.toFixed(5)} F${feedrate}`);
		prevX = x;
		prevY = y;
	}
	return { lines, endX: prevX, endY: prevY, totalE };
}

function travelTo(x: number, y: number, feedrate = 6000): string {
	return `G1 X${x.toFixed(4)} Y${y.toFixed(4)} F${feedrate}`;
}

/** Small, safe angular step for the radii used below — see arcFit.test.ts's own note on sagitta. */
const ANGLES = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20];

function arcLines(output: string): Array<string> {
	return output.split("\n").filter((l) => /^(G2|G3)\b/.test(l.trim()));
}

describe("arcWeld", () => {
	it("collapses a circle of G1 moves into one G2/G3, ending where the original path ended", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = ["G28", "G90", "M83", travelTo(20, 0), ...circle.lines].join("\n");
		const output = runStep("arcWeld", {}, input);
		const arcs = arcLines(output);
		expect(arcs).toHaveLength(1);
		const m = /X(-?[\d.]+) Y(-?[\d.]+)/.exec(arcs[0])!;
		expect(Number(m[1])).toBeCloseTo(circle.endX, 1);
		expect(Number(m[2])).toBeCloseTo(circle.endY, 1);
	});

	it("preserves total extruded filament, in relative extrusion mode", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = ["G28", "G90", "M83", travelTo(20, 0), ...circle.lines].join("\n");
		const output = runStep("arcWeld", {}, input);
		let welded = 0;
		for (const line of output.split("\n")) {
			const m = /\bE(-?[\d.]+)/.exec(line);
			if (m !== null) welded += Number(m[1]);
		}
		expect(welded).toBeCloseTo(circle.totalE, 3);
	});

	// Regression test for a real defect: `closeRun()` passed a hardcoded `relativeE: false` into
	// `buildArcCommand`, so a relative-mode (M83) arc was emitted with the ABSOLUTE running E total
	// instead of the run's own small delta. The test above ("preserves total extruded filament")
	// could not have caught this — it extrudes nothing before the welded run, so the absolute total
	// and the relative delta are numerically identical (both start from zero) and the bug is
	// invisible. This one extrudes a substantial amount *before* the circle starts, so a file that
	// regresses to the absolute value produces an E three orders of magnitude too large — exactly
	// what a real multi-thousand-line print does, and exactly what turned one welded arc into a
	// request for 861mm of filament in a single move on a real file.
	it("emits the run's own small E delta, not the absolute running total, in relative extrusion mode", () => {
		// A large amount of *unrelated* prior extrusion (a different rate and direction, so it can
		// never itself join the circle's run) pushes the absolute running E total far away from zero
		// — exactly the situation a real, multi-thousand-line print is always in by the time it
		// reaches a curve, and exactly what the test above ("preserves total extruded filament")
		// cannot exercise, since it extrudes nothing before the circle and so never lets "the run's
		// own delta" and "the absolute total so far" diverge.
		const priorE = 861.17;
		const priming = `G1 X0 Y-5 E${priorE.toFixed(5)} F1800`;
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = ["G28", "G90", "M83", travelTo(20, 0), priming, ...circle.lines].join("\n");
		const output = runStep("arcWeld", {}, input);

		const arcs = arcLines(output);
		expect(arcs.length).toBeGreaterThan(0);

		// Every individual E value emitted for the circle's own portion of the move sequence must be
		// on the order of a single move's worth of filament, never anywhere near the ~861mm absolute
		// total in force by that point in the file
		let sumAfterPriming = 0;
		for (const line of output.split("\n").slice(output.split("\n").indexOf(priming) + 1)) {
			const m = /\bE(-?[\d.]+)/.exec(line);
			if (m === null) continue;
			const value = Number(m[1]);
			expect(Math.abs(value)).toBeLessThan(1);
			sumAfterPriming += value;
		}
		expect(sumAfterPriming).toBeCloseTo(circle.totalE, 3);
	});

	it("preserves the final absolute E position, in absolute extrusion mode", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		// M82 (absolute) means each circleMoves() line's own "E" is really a relative delta in this
		// fixture, so convert it to a running absolute value the same way a real absolute-mode file
		// would state it
		let running = 0;
		const absoluteLines = circle.lines.map((l) => {
			const m = /E(-?[\d.]+)/.exec(l)!;
			running += Number(m[1]);
			return l.replace(/E-?[\d.]+/, `E${running.toFixed(5)}`);
		});
		const input = ["G28", "G90", "M82", travelTo(20, 0), ...absoluteLines].join("\n");
		const output = runStep("arcWeld", {}, input);
		const lastE = [...output.matchAll(/\bE(-?[\d.]+)/g)].pop();
		expect(lastE).toBeDefined();
		expect(Number(lastE![1])).toBeCloseTo(running, 3);
	});

	it("is byte-identical for a file with no weldable runs", () => {
		const input = [
			"G28", "G90", "M83",
			"G1 X10 Y10 F6000",
			"G1 X100 Y10 E5 F1800",
			"G1 X100 Y100 E5 F1800",
			"M104 S210",
		].join("\n");
		expect(runStep("arcWeld", {}, input)).toBe(input);
	});

	it("emits a run shorter than minSegments verbatim rather than dropping it", () => {
		const circle = circleMoves(0, 0, 20, [0, 2, 4]); // 2 moves, fewer than the default minSegments=3
		const input = ["G28", "G90", "M83", travelTo(20, 0), ...circle.lines, "M104 S210"].join("\n");
		const output = runStep("arcWeld", {}, input);
		expect(arcLines(output)).toHaveLength(0);
		for (const line of circle.lines) expect(output).toContain(line);
	});

	it("flushes a run still open at end of file, via onEnd", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		// No trailing command after the circle -- the run is still open when the file ends
		const input = ["G28", "G90", "M83", travelTo(20, 0), ...circle.lines].join("\n");
		const output = runStep("arcWeld", {}, input);
		expect(arcLines(output)).toHaveLength(1);
	});

	it("breaks the run on any command that is not G0/G1", () => {
		const first = circleMoves(0, 0, 20, ANGLES);
		const second = circleMoves(first.endX, first.endY, 20, ANGLES.map((a) => a + 40));
		const input = [
			"G28", "G90", "M83", travelTo(20, 0),
			...first.lines,
			"M106 S128",
			...second.lines,
		].join("\n");
		const output = runStep("arcWeld", {}, input);
		expect(output).toContain("M106 S128");
		expect(arcLines(output).length).toBeGreaterThanOrEqual(2);
	});

	it("breaks the run on a change of extrusion character (a retraction mid-curve)", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = [
			"G28", "G90", "M83", travelTo(20, 0),
			...circle.lines.slice(0, 5),
			"G1 E-2 F1800",
			...circle.lines.slice(5),
		].join("\n");
		const output = runStep("arcWeld", {}, input);
		expect(output).toContain("G1 E-2 F1800");
	});

	it("breaks the run on a Z change unless allow3dArcs is set", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = [
			"G28", "G90", "M83", travelTo(20, 0),
			...circle.lines.slice(0, 5),
			"G1 Z0.4 F720",
			...circle.lines.slice(5),
		].join("\n");
		const output = runStep("arcWeld", {}, input);
		expect(output).toContain("G1 Z0.4 F720");
	});

	it("breaks the run on a layer change", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = [
			"G28", "G90", "M83", travelTo(20, 0),
			...circle.lines.slice(0, 5),
			";LAYER_CHANGE",
			...circle.lines.slice(5),
		].join("\n");
		const output = runStep("arcWeld", {}, input);
		const arcs = arcLines(output);
		expect(arcs.length).toBeGreaterThanOrEqual(1);
		expect(output).toContain(";LAYER_CHANGE");
	});

	it("breaks the run on a feature-type boundary", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = [
			"G28", "G90", "M83", ";TYPE:Perimeter", travelTo(20, 0),
			...circle.lines.slice(0, 5),
			";TYPE:Bridge infill",
			...circle.lines.slice(5),
		].join("\n");
		const output = runStep("arcWeld", {}, input);
		expect(output).toContain(";TYPE:Bridge infill");
	});

	it("breaks the run on a zero-length move", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = [
			"G28", "G90", "M83", travelTo(20, 0),
			...circle.lines.slice(0, 5),
			"G1 F1800",
			...circle.lines.slice(5),
		].join("\n");
		const output = runStep("arcWeld", {}, input);
		expect(output).toContain("G1 F1800");
	});

	it("breaks the run when extrusion rate varies beyond the configured tolerance", () => {
		const circle = circleMoves(0, 0, 20, ANGLES, { ePerMm: 0.03 });
		// Splice in one segment extruded at 10x the established rate
		const spliced = [...circle.lines];
		const target = spliced[5];
		spliced[5] = target.replace(/E[\d.]+/, (m) => `E${(Number(m.slice(1)) * 10).toFixed(5)}`);
		const input = ["G28", "G90", "M83", travelTo(20, 0), ...spliced].join("\n");
		const output = runStep("arcWeld", { extrusionRateVariancePercent: 5 }, input);
		expect(output).toContain(spliced[5]);
	});

	it("carries a helical Z change onto the arc when allow3dArcs is set", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const withZ = circle.lines.map((l, i) => l.replace(/^G1 /, `G1 Z${(0.2 + i * 0.001).toFixed(4)} `));
		const input = ["G28", "G90", "M83", "G1 Z0.2 F720", travelTo(20, 0), ...withZ].join("\n");
		const output = runStep("arcWeld", { allow3dArcs: true }, input);
		const arcs = arcLines(output);
		expect(arcs).toHaveLength(1);
		expect(arcs[0]).toMatch(/\bZ[\d.]+\b/);
	});

	it("does not weld across a G92 (E reset)", () => {
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = [
			"G28", "G90", "M83", travelTo(20, 0),
			...circle.lines.slice(0, 5),
			"G92 E0",
			...circle.lines.slice(5),
		].join("\n");
		const output = runStep("arcWeld", {}, input);
		expect(output).toContain("G92 E0");
	});

	it("a step ordered after arc welding sees arcs as arcs, not the original moves", () => {
		// The one G1 line legitimately left over is the travel move that approaches the curve — it
		// is its own single-point run, never part of the circle. A findReplace targeting G1 that ran
		// on the *unwelded* input would still see every one of the circle's own moves; ordered after
		// welding, it sees only that one.
		const circle = circleMoves(0, 0, 20, ANGLES);
		const input = ["G28", "G90", "M83", travelTo(20, 0), ...circle.lines].join("\n");
		const countG1 = (text: string) => text.split("\n").filter((l) => /^G1 X/.test(l)).length;

		const weld = makeStep("arcWeld");
		const matcher = makeStep("findReplace", { find: "G1 X", replace: "G1 X", regex: false, caseSensitive: true, all: true });
		const { output: welded } = runSteps([weld, matcher], input);

		expect(countG1(welded)).toBe(1);
		expect(countG1(welded)).toBeLessThan(countG1(input));
	});

	it("substantially shrinks the curved fixture, ending where the original path ended", () => {
		const input = readFileSync(resolve(__dirname, "../../test/fixtures/arc-circle.gcode"), "utf-8");
		const output = runStep("arcWeld", {}, input);

		expect(output.split("\n").length).toBeLessThan(input.split("\n").length / 2);
		expect(arcLines(output).length).toBeGreaterThan(0);

		// The traced endpoint (the last coordinate touched, whether by a G1 or the final arc) must
		// match the original within resolutionMm (default 0.05) plus a little slack for rounding
		const lastCoords = (text: string): { x: number; y: number } => {
			let last = { x: 0, y: 0 };
			for (const line of text.split("\n")) {
				const mx = /\bX(-?[\d.]+)/.exec(line);
				const my = /\bY(-?[\d.]+)/.exec(line);
				if (mx !== null) last = { ...last, x: Number(mx[1]) };
				if (my !== null) last = { ...last, y: Number(my[1]) };
			}
			return last;
		};
		const before = lastCoords(input);
		const after = lastCoords(output);
		expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.1);
	});
});
