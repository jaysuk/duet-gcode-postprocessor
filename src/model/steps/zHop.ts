/**
 * Add a Z-hop to travels above a length threshold, for a file sliced without one that is knocking
 * over a tall or fragile part. See `travel.ts` for the shared travel-detection this and
 * `oozeControl.ts` both build on.
 */

import { formatNumber } from "../gcode/tokenise";
import { advanceTravelState, createTravelState, isFirmwareRetractOrUnretract } from "./travel";
import type { LineContext, RunContext, StepDefinition, Transform } from "./types";

export interface ZHopConfig {
	thresholdMm: number;
	hopHeightMm: number;
	decimals: number;
}

/** Fixed Z feedrate for the inserted hop moves — mm/min, a conservative speed safe on typical
 *  leadscrews and belts alike. Not exposed as a field: this step already has two numbers that
 *  matter (the threshold and the height); a third for a value almost nobody needs to change is the
 *  shape CLAUDE.md's field-schema rule exists to discourage. */
const HOP_FEEDRATE = 600;

export const zHopStep: StepDefinition<ZHopConfig> = {
	id: "zHop",
	label: "Z-hop on long travels",
	description: "Lifts the nozzle before a travel move longer than a threshold, and lowers it again after — for a file sliced without a hop that is knocking over a part.",
	tip: "Run this BEFORE \"Weld curves into arcs\" in the recipe — arc-welding changes line counts "
		+ "and coordinates outright, and this step needs to see the file's own original travel moves, "
		+ "not arcs that used to be several of them. Skips a travel that already has an explicit "
		+ "Z-rise immediately before it (a slicer-emitted hop of its own), and skips the whole rest of "
		+ "the file once it sees G10/G11 (RepRapFirmware's own firmware retraction, which already "
		+ "performs whatever hop the machine's M207 is configured with — invisible from the file's own "
		+ "text, so trusted rather than guessed at). Both kinds of skip are counted and reported, so "
		+ "\"nothing changed\" is distinguishable from \"it was not needed\".",
	docsAnchor: "z-hop-on-long-travels",
	icon: "mdi-arrow-expand-vertical",
	fields: [
		{
			key: "thresholdMm", label: "Travel length threshold (mm)", type: "number", default: 5, min: 0, step: 0.5,
			help: "Only travels at least this long get a hop. Default: 5.",
		},
		{
			key: "hopHeightMm", label: "Hop height (mm)", type: "number", default: 0.4, min: 0.01, step: 0.05,
			help: "How far to lift before the travel, and lower again after. Default: 0.4.",
		},
		{
			key: "decimals", label: "Decimal places", type: "number", default: 3, min: 0, max: 6,
			help: "Trailing zeros are trimmed. Default: 3.",
		},
	],

	create(config): Transform {
		const state = createTravelState();
		let usesFirmwareRetraction = false;
		let lastWasRise = false;
		let skipped = 0;
		let inserted = 0;

		return {
			id: "zHop",

			onLine(ctx: LineContext, line: string) {
				const token = ctx.token;
				if (isFirmwareRetractOrUnretract(token)) usesFirmwareRetraction = true;

				const info = advanceTravelState(state, ctx, token);
				if (info === null) return undefined; // comments etc. don't cancel a pending "just hopped" flag

				if (info.isZOnlyRise) {
					lastWasRise = true;
					return undefined;
				}
				if (!info.isTravel || info.distance < config.thresholdMm) {
					lastWasRise = false;
					return undefined;
				}
				if (usesFirmwareRetraction || lastWasRise) {
					skipped++;
					lastWasRise = false;
					return undefined;
				}

				lastWasRise = false;
				inserted++;
				const up = ctx.relativeMoves
					? `G1 Z${formatNumber(config.hopHeightMm, config.decimals)} F${HOP_FEEDRATE}`
					: `G1 Z${formatNumber(info.z + config.hopHeightMm, config.decimals)} F${HOP_FEEDRATE}`;
				const down = ctx.relativeMoves
					? `G1 Z${formatNumber(-config.hopHeightMm, config.decimals)} F${HOP_FEEDRATE}`
					: `G1 Z${formatNumber(info.z, config.decimals)} F${HOP_FEEDRATE}`;
				return [up, line, down];
			},

			onEnd(runCtx: RunContext) {
				if (skipped > 0) {
					runCtx.warn(
						`Z-hop: skipped ${skipped} travel${skipped === 1 ? "" : "s"} that already had a hop `
						+ "or used firmware retraction (G10/G11), out of "
						+ `${inserted + skipped} candidate travel${inserted + skipped === 1 ? "" : "s"}.`,
					);
				}
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (config.hopHeightMm <= 0) errors.push("Hop height must be greater than 0");
		return errors;
	},
};
