/**
 * Keeps only a range of layers, discarding the rest — including the source's own start block, which
 * sits before layer 0 and is not part of any layer range. Deliberately **not** state-reconstructing:
 * the result is a partial file for extraction/debugging/splitting, not a runnable print. Prepending
 * the vanished temperatures, tool selection and homing here would let this quietly grow into a worse
 * version of `restartFrom.ts`; a user who wants a runnable resumed print should use that step, which
 * does the state reconstruction properly.
 *
 * Splitting a file at a layer is just two extractions — `[-1, N]` and `[N+1, -1]` — so this one step
 * covers both this task's "extract a range" and "split at a layer".
 */

import { inLayerRange, type LineContext, type RunContext, type StepDefinition, type Transform } from "./types";

export interface ExtractRangeConfig {
	layerFrom: number;
	layerTo: number;
}

export const extractRangeStep: StepDefinition<ExtractRangeConfig> = {
	id: "extractRange",
	label: "Extract a layer range",
	description: "Keeps only a range of layers — a partial file for debugging or splitting, not a runnable print on its own.",
	icon: "mdi-content-cut",
	fields: [
		{
			key: "layerFrom", label: "From layer", type: "number", default: -1, min: -1,
			help: "-1 means from the start of the file. Default: -1.",
		},
		{
			key: "layerTo", label: "To layer", type: "number", default: -1, min: -1,
			help: "-1 means to the end of the file. Default: -1.",
		},
	],

	create(config: ExtractRangeConfig): Transform {
		const { layerFrom, layerTo } = config;
		let keptLines = 0;
		let sawAnyMarker = false;

		return {
			id: "extractRange",

			onStart(runCtx: RunContext): Array<string> {
				const from = layerFrom < 0 ? "the start" : `layer ${layerFrom}`;
				const to = layerTo < 0 ? "the end" : `layer ${layerTo}`;
				return [
					`; --- Extracted by G-code Post-Processor: ${from} to ${to} of ${runCtx.sourcePath || "the source file"} ---`,
					"; This is a PARTIAL file, not a runnable start-to-finish print: the original start block",
					"; (homing, bed levelling, initial temperatures) has been removed, along with everything",
					"; outside the extracted range. Prepare the machine manually before running this, or use",
					"; \"Restart from layer\" instead if you want a file that reconstructs machine state for you.",
				];
			},

			onLine(lineCtx: LineContext, line: string): string | null | undefined {
				if (lineCtx.sawLayerMarker) sawAnyMarker = true;
				if (!inLayerRange(lineCtx.layer, layerFrom, layerTo)) return null;
				keptLines++;
				return undefined;
			},

			onEnd(runCtx: RunContext): void {
				if (keptLines === 0) {
					runCtx.warn(
						`No lines fell within layers ${layerFrom < 0 ? "start" : layerFrom}–`
						+ `${layerTo < 0 ? "end" : layerTo} — the extracted file is empty. Check the layer `
						+ "range against this file's actual layer count.",
					);
				}
				if (!sawAnyMarker) {
					runCtx.warn(
						"This file has no layer-change markers of its own — layer numbers were inferred from "
						+ "Z rises and may not exactly match what the slicer itself would call each layer.",
					);
				}
			},
		};
	},

	validate(config: ExtractRangeConfig): Array<string> {
		const errors: Array<string> = [];
		if (config.layerFrom >= 0 && config.layerTo >= 0 && config.layerFrom > config.layerTo) {
			errors.push("From layer must not be after to layer");
		}
		return errors;
	},
};
