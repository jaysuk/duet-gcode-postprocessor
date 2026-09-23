import { EditorState, Text } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { formatLineStateLabel, lineStateGutter } from "../model/gcode/lineStateGutter";
import { buildLineStateIndex } from "../model/gcode/lineState";
import { createState } from "dwc-gcode-core/stepper/machineState";

describe("formatLineStateLabel", () => {
	it("shows nothing for the untouched initial state", () => {
		expect(formatLineStateLabel(createState())).toBeNull();
	});

	it("shows layer, Z and tool together once all three are known", () => {
		const state = createState();
		state.layer = 3;
		state.z = 12.4;
		state.tool = 1;
		expect(formatLineStateLabel(state)).toBe("L3 Z12.40 T1");
	});

	it("omits Z when no move has happened yet, even with a known layer", () => {
		const state = createState();
		state.layer = 0;
		expect(formatLineStateLabel(state)).toBe("L0");
	});

	it("omits tool when none has been selected", () => {
		const state = createState();
		state.z = 0.2;
		expect(formatLineStateLabel(state)).toBe("Z0.20");
	});
});

describe("lineStateGutter (real CM6 mount)", () => {
	function mount(doc: Text, index: ReturnType<typeof buildLineStateIndex> | null) {
		const state = EditorState.create({
			doc,
			extensions: [lineNumbers(), lineStateGutter(() => index)],
		});
		return new EditorView({ state, parent: document.createElement("div") });
	}

	it("renders a label for a visible line with known state", () => {
		const doc = Text.of([";LAYER_CHANGE", ";Z:0.20", "G1 Z0.2 F600", "G1 X1 Y1"]);
		const index = buildLineStateIndex(doc, 500);
		const view = mount(doc, index);
		expect(view.dom.textContent).toContain("L0");
		expect(view.dom.textContent).toContain("Z0.20");
		view.destroy();
	});

	it("renders an empty gutter (no thrown error) when the index is not ready yet", () => {
		const doc = Text.of(["G28", "G1 X1"]);
		expect(() => {
			const view = mount(doc, null);
			view.destroy();
		}).not.toThrow();
	});

	it("shows different labels for different layers as the file progresses", () => {
		const doc = Text.of([
			";LAYER_CHANGE", ";Z:0.20", "G1 Z0.2",
			";LAYER_CHANGE", ";Z:0.40", "G1 Z0.4",
		]);
		const index = buildLineStateIndex(doc, 500);
		const view = mount(doc, index);
		const text = view.dom.textContent ?? "";
		expect(text).toContain("L0");
		expect(text).toContain("L1");
		expect(text).toContain("Z0.40");
		view.destroy();
	});
});
