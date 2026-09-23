/**
 * A CM6 gutter showing this plugin's own machine-state tracking (layer / Z / tool) per line —
 * `dwc-gcode-editor`'s own doc comment calls this out as the kind of "G-code-native panel Monaco
 * never had a concept for" that a host is expected to build, not something the generic editor
 * package provides.
 *
 * Only ever computes state for the currently VISIBLE line range (`view.viewport`), never the whole
 * file — `@codemirror/view`'s own built-in `lineNumbers()` gutter uses the exact same
 * `config.markers(view)` contract and the same restriction (confirmed by reading its compiled
 * source: `SingleGutterView` calls `config.markers(view)` on every relevant update, and it is the
 * callback's own job to scope its work, the same way CM6's built-in search-match highlighting scopes
 * itself to `view.visibleRanges`). Combined with `lineState.ts`'s checkpoint-based lookup, one gutter
 * repaint costs at most one checkpoint-to-viewport replay, never a whole-file replay.
 */

import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";

import { statesForLineRange, type LineStateIndex } from "./lineState";
import type { MachineState } from "dwc-gcode-core/stepper/machineState";

class LineStateMarker extends GutterMarker {
	constructor(private readonly label: string) {
		super();
	}

	eq(other: GutterMarker): boolean {
		return other instanceof LineStateMarker && other.label === this.label;
	}

	toDOM(): Node {
		const span = document.createElement("span");
		span.className = "cm-gcode-line-state";
		span.textContent = this.label;
		return span;
	}
}

/** Human-shaped, compact per-line label. `null` when there is nothing worth showing yet (before
 *  any Z move, tool selection, or layer marker has been seen) - an empty gutter cell, not "0"/"-1"
 *  noise on every line before the print has actually started. */
export function formatLineStateLabel(state: MachineState): string | null {
	const parts: Array<string> = [];
	if (state.layer >= 0) parts.push(`L${state.layer}`);
	if (state.z !== null) parts.push(`Z${state.z.toFixed(2)}`);
	if (state.tool >= 0) parts.push(`T${state.tool}`);
	return parts.length === 0 ? null : parts.join(" ");
}

/**
 * `getIndex` is called on every repaint rather than passed once, since the real index is not built
 * until the file has finished loading (see `GcodeEditor.vue`) - returning `null` until then simply
 * shows an empty gutter rather than requiring the extension to be reconfigured once the index is
 * ready.
 */
export function lineStateGutter(getIndex: () => LineStateIndex | null): Extension {
	return gutter({
		class: "cm-gcode-line-state-gutter",
		markers(view: EditorView) {
			const index = getIndex();
			const builder = new RangeSetBuilder<GutterMarker>();
			if (index === null) return builder.finish();

			const fromLine = view.state.doc.lineAt(view.viewport.from).number;
			const toLine = view.state.doc.lineAt(view.viewport.to).number;
			const states = statesForLineRange(index, view.state.doc, fromLine, toLine);

			for (let lineNo = fromLine; lineNo <= toLine; lineNo++) {
				const state = states.get(lineNo);
				const label = state === undefined ? null : formatLineStateLabel(state);
				if (label === null) continue;
				const linePos = view.state.doc.line(lineNo).from;
				builder.add(linePos, linePos, new LineStateMarker(label));
			}
			return builder.finish();
		},
	});
}
