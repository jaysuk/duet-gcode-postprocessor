/**
 * Converts Klipper's bare-word object-exclusion macros — `EXCLUDE_OBJECT_DEFINE`,
 * `EXCLUDE_OBJECT_START`, `EXCLUDE_OBJECT_END` — into RepRapFirmware's `M486`, so DWC's own
 * cancel-object UI works on a file that was sliced for Klipper rather than RRF.
 *
 * **`EXCLUDE_OBJECT_DEFINE` has no direct `M486` equivalent** and is dropped: RRF's `M486 S<n> A"…"`
 * both assigns an object its index *and* marks it current in one command, where Klipper separates
 * "declare this object exists, with this polygon" (`DEFINE`) from "printing it now" (`START`). Its
 * `NAME=` is still registered here so a `START` for the same name later gets the same index even if
 * `DEFINE` is never repeated.
 *
 * **Never touches a file that already uses `M486`** — declared via an `analysis()` collector, since
 * that has to be known before the very first line is decided on, which a single forward pass cannot
 * do. Converting anyway risks a Klipper-derived index colliding with one the slicer assigned itself.
 *
 * Klipper commands are bare words, not `G`/`M`/`T` codes — `tokenise()` returns `code: null` for
 * them (see `dialect.ts`'s own `bareMacroName`, the established handling for this), so this step
 * matches against the raw line text directly rather than `LineContext.token`.
 */

import type { AnalysisCollector } from "../analysisPass";
import type { LineContext, RunContext, StepDefinition, StepFactoryContext, Transform } from "./types";

const COLLECTOR_ID = "objectLabels";

/** Namespaces the collector id by this step's position in the recipe — see `rewriteTime.ts`'s own
 *  helper of the same name and task 07's defect A, which is what this pattern exists to avoid. */
function collectorId(ctx: StepFactoryContext): string {
	return ctx.stepIndex !== undefined ? `${COLLECTOR_ID}#${ctx.stepIndex}` : COLLECTOR_ID;
}

class HasM486Collector implements AnalysisCollector<boolean> {
	private found = false;

	constructor(readonly id: string) {}

	onLine(ctx: LineContext): void {
		if (ctx.token.letter === "M" && ctx.token.code === "M486") this.found = true;
	}

	result(): boolean {
		return this.found;
	}
}

const RE_DEFINE = /^\s*EXCLUDE_OBJECT_DEFINE\b/i;
const RE_START = /^\s*EXCLUDE_OBJECT_START\b(.*)$/i;
const RE_END = /^\s*EXCLUDE_OBJECT_END\b/i;
/** Klipper's own convention: a bare token, or a quoted one when it contains spaces. */
const RE_NAME = /\bNAME=("(?:[^"\\]|\\.)*"|\S+)/i;

function extractName(rest: string): string | null {
	const m = RE_NAME.exec(rest);
	if (m === null) return null;
	const raw = m[1];
	return raw.startsWith("\"") && raw.endsWith("\"") ? raw.slice(1, -1) : raw;
}

/** RRF's own quoted-string convention: an internal `"` is written as `""`. */
function quoteName(name: string): string {
	return `"${name.replace(/"/g, "\"\"")}"`;
}

export const objectLabelsStep: StepDefinition<Record<string, never>> = {
	id: "objectLabels",
	label: "Convert Klipper object markers to M486",
	description: "Rewrites EXCLUDE_OBJECT_DEFINE/START/END into RepRapFirmware's M486, for DWC's cancel-object.",
	tip: "Nothing to configure. Only worth adding for a file sliced with Klipper's own object markers "
		+ "(EXCLUDE_OBJECT_DEFINE/START/END) instead of M486 — check the Inspect tab's flavour "
		+ "detection first. Each distinct object name gets a stable index, reused if the same name "
		+ "reappears later in the file, and EXCLUDE_OBJECT_END always becomes M486 S-1. A file that "
		+ "already carries real M486 (already sliced for RepRapFirmware, or run through this step "
		+ "once already) is left completely untouched rather than double-labelled — converting "
		+ "anyway would risk a Klipper-derived index colliding with one the slicer assigned itself.",
	docsAnchor: "convert-klipper-object-markers-to-m486",
	icon: "mdi-shape-outline",
	fields: [],

	analysis(_config: Record<string, never>, ctx: StepFactoryContext): Array<AnalysisCollector> {
		return [new HasM486Collector(collectorId(ctx))];
	},

	create(_config: Record<string, never>, ctx: StepFactoryContext): Transform {
		const resultKey = collectorId(ctx);
		let hasExistingM486 = false;
		const indexByName = new Map<string, number>();
		let nextIndex = 0;
		let convertedCount = 0;
		let unresolvedCount = 0;

		function indexFor(name: string): number {
			let index = indexByName.get(name);
			if (index === undefined) {
				index = nextIndex++;
				indexByName.set(name, index);
			}
			return index;
		}

		return {
			id: "objectLabels",

			onStart(runCtx: RunContext): void {
				hasExistingM486 = (runCtx.analysis.get(resultKey) as boolean | undefined) ?? false;
			},

			onLine(_lineCtx: LineContext, line: string): string | null | undefined {
				if (hasExistingM486) return undefined;

				if (RE_DEFINE.test(line)) {
					const name = extractName(line);
					if (name !== null) indexFor(name);
					return null;
				}

				const startMatch = RE_START.exec(line);
				if (startMatch !== null) {
					const name = extractName(startMatch[1]);
					if (name === null) {
						unresolvedCount++;
						return undefined;
					}
					convertedCount++;
					return `M486 S${indexFor(name)} A${quoteName(name)}`;
				}

				if (RE_END.test(line)) {
					convertedCount++;
					return "M486 S-1";
				}

				return undefined;
			},

			onEnd(runCtx: RunContext): void {
				if (hasExistingM486) {
					runCtx.warn(
						"This file already uses M486 — Klipper EXCLUDE_OBJECT markers were left untouched "
						+ "to avoid double-labelling.",
					);
					return;
				}
				if (convertedCount > 0) {
					runCtx.warn(
						`Converted ${convertedCount} Klipper EXCLUDE_OBJECT command${convertedCount === 1 ? "" : "s"} `
						+ `to M486, across ${indexByName.size} object${indexByName.size === 1 ? "" : "s"}.`,
					);
				}
				if (unresolvedCount > 0) {
					runCtx.warn(
						`${unresolvedCount} EXCLUDE_OBJECT_START command${unresolvedCount === 1 ? "" : "s"} had no `
						+ "NAME parameter and could not be converted.",
					);
				}
			},
		};
	},
};
