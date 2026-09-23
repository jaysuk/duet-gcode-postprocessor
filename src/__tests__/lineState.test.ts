import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildLineStateIndex, statesForLineRange, stateAtLine } from "../model/gcode/lineState";
import { applyLineToState, createState } from "dwc-gcode-core/stepper/machineState";

/** Reference implementation: replay from line 1 every time. Slow, obviously correct - the
 *  invariant every checkpoint-based lookup must match. */
function naiveStateAtLine(doc: Text, lineNo: number) {
	const state = createState();
	for (let n = 1; n <= lineNo; n++) applyLineToState(state, doc.line(n).text);
	return state;
}

function docOf(lines: Array<string>): Text {
	return Text.of(lines);
}

describe("buildLineStateIndex / statesForLineRange", () => {
	it("matches the naive full-replay reference for every line, across several checkpoint boundaries", () => {
		const lines: Array<string> = [];
		for (let layer = 0; layer < 12; layer++) {
			lines.push(";LAYER_CHANGE", `;Z:${(layer * 0.2).toFixed(2)}`, `G1 Z${(layer * 0.2).toFixed(2)} F600`);
			for (let i = 0; i < 5; i++) lines.push(`G1 X${i} Y${i} E${i}`);
		}
		const doc = docOf(lines);
		const index = buildLineStateIndex(doc, 7); // deliberately small + not a multiple of the pattern length

		for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
			const fromIndex = stateAtLine(index, doc, lineNo);
			const reference = naiveStateAtLine(doc, lineNo);
			expect(fromIndex).toEqual(reference);
		}
	});

	it("tracks layer and Z correctly across a checkpoint boundary", () => {
		const lines = [
			";LAYER_CHANGE", ";Z:0.20", "G1 Z0.2 F600",
			";LAYER_CHANGE", ";Z:0.40", "G1 Z0.4 F600",
			";LAYER_CHANGE", ";Z:0.60", "G1 Z0.6 F600",
		];
		const doc = docOf(lines);
		const index = buildLineStateIndex(doc, 2); // checkpoint lands mid-layer
		const state = stateAtLine(index, doc, 9); // after the third layer's Z move
		expect(state).not.toBeNull();
		expect(state!.layer).toBe(2);
		expect(state!.z).toBe(0.6);
	});

	it("correctly attributes a Z move riding along on a multi-command line (splitCommands)", () => {
		const doc = docOf(["G90 G1 Z5", "G1 X1 Y1"]);
		const index = buildLineStateIndex(doc, 500);
		const state = stateAtLine(index, doc, 1);
		expect(state!.z).toBe(5);
	});

	it("statesForLineRange returns one entry per line in the requested range, in order", () => {
		const doc = docOf(["G1 X1", "G1 X2", "G1 X3", "G1 X4", "G1 X5"]);
		const index = buildLineStateIndex(doc, 2);
		const states = statesForLineRange(index, doc, 2, 4);
		expect([...states.keys()]).toEqual([2, 3, 4]);
	});

	it("clamps a range that runs past the end of the document", () => {
		const doc = docOf(["G1 X1", "G1 X2", "G1 X3"]);
		const index = buildLineStateIndex(doc, 2);
		const states = statesForLineRange(index, doc, 2, 100);
		expect([...states.keys()]).toEqual([2, 3]);
	});

	it("returns an empty map when fromLine is past toLine", () => {
		const doc = docOf(["G1 X1", "G1 X2"]);
		const index = buildLineStateIndex(doc, 2);
		expect(statesForLineRange(index, doc, 5, 2).size).toBe(0);
	});

	it("stateAtLine returns null for a line number outside the document", () => {
		const doc = docOf(["G1 X1"]);
		const index = buildLineStateIndex(doc, 2);
		expect(stateAtLine(index, doc, 0)).toBeNull();
		expect(stateAtLine(index, doc, 5)).toBeNull();
	});

	it("works with checkpointEvery = 1 (a checkpoint at every line)", () => {
		const doc = docOf(["G90", "G1 Z1", "G1 Z2", "G1 Z3"]);
		const index = buildLineStateIndex(doc, 1);
		expect(index.checkpoints.length).toBe(5); // initial + one per line
		expect(stateAtLine(index, doc, 3)!.z).toBe(2);
	});

	it("tool tracking survives a checkpoint boundary", () => {
		const lines = ["T0", "G1 X1", "G1 X2", "T1", "G1 X3", "G1 X4"];
		const doc = docOf(lines);
		const index = buildLineStateIndex(doc, 2);
		expect(stateAtLine(index, doc, 3)!.tool).toBe(0);
		expect(stateAtLine(index, doc, 6)!.tool).toBe(1);
	});
});
