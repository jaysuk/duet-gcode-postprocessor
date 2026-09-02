/**
 * Insert a small retraction — and optionally a brief temperature drop — before a travel move longer
 * than a threshold, for a file sliced without one that is oozing on long travels. See `travel.ts`
 * for the shared travel-detection this and `zHop.ts` both build on.
 */

import { formatNumber, paramNumber, parseParams } from "../gcode/tokenise";
import { advanceTravelState, createTravelState, isFirmwareRetractOrUnretract } from "./travel";
import type { LineContext, RunContext, StepDefinition, Transform } from "./types";

export interface OozeControlConfig {
	thresholdMm: number;
	retractMm: number;
	dropTemperature: boolean;
	tempDropC: number;
	decimals: number;
}

/** Fixed retract/unretract feedrate, mm/min — not exposed as a field for the same reason
 *  `zHop.ts`'s hop feedrate is not: this step already has the numbers that matter. */
const RETRACT_FEEDRATE = 1800;

export const oozeControlStep: StepDefinition<OozeControlConfig> = {
	id: "oozeControl",
	label: "Ooze control on long travels",
	description: "Retracts (and optionally cools) before a travel move longer than a threshold, for a file sliced without protection that is oozing strings across long travels.",
	tip: "Run this BEFORE \"Weld curves into arcs\" in the recipe — arc-welding changes line counts "
		+ "and coordinates outright, and this step needs to see the file's own original travel moves. "
		+ "Skips a travel that already has a retraction on the line immediately before it, and skips "
		+ "the whole rest of the file once it sees G10/G11 (RepRapFirmware's own firmware retraction — "
		+ "see zHop's tip for why that is trusted rather than second-guessed). The temperature drop, "
		+ "if enabled, only fires when the file has already commanded a hot end temperature earlier "
		+ "(M104/M109) to restore afterwards; without one it retracts but leaves temperature alone "
		+ "rather than guessing at a value to return to.",
	docsAnchor: "ooze-control-on-long-travels",
	icon: "mdi-water-off",
	fields: [
		{
			key: "thresholdMm", label: "Travel length threshold (mm)", type: "number", default: 5, min: 0, step: 0.5,
			help: "Only travels at least this long get a retraction. Default: 5.",
		},
		{
			key: "retractMm", label: "Retraction length (mm)", type: "number", default: 0.4, min: 0.01, step: 0.05,
			help: "Filament pulled back before the travel, and pushed back after. A small value — this "
				+ "is on top of anything the file already does elsewhere, not a replacement for it. Default: 0.4.",
		},
		{
			key: "dropTemperature", label: "Also drop temperature", type: "boolean", default: false,
			help: "Lower the hot end temperature for the duration of the travel, restoring it "
				+ "afterwards. Off by default. Default: off.",
		},
		{
			key: "tempDropC", label: "Temperature drop (°C)", type: "number", default: 10, min: 1, max: 100,
			showWhen: { key: "dropTemperature", equals: [true] },
			help: "How many degrees to lower by. Default: 10.",
		},
		{
			key: "decimals", label: "Decimal places", type: "number", default: 3, min: 0, max: 6,
			help: "Trailing zeros are trimmed. Default: 3.",
		},
	],

	create(config): Transform {
		const state = createTravelState();
		let usesFirmwareRetraction = false;
		let lastWasRetraction = false;
		let lastCommandedTemp: number | null = null;
		let skipped = 0;
		let inserted = 0;

		return {
			id: "oozeControl",

			onLine(ctx: LineContext, line: string) {
				const token = ctx.token;
				if (isFirmwareRetractOrUnretract(token)) usesFirmwareRetraction = true;
				if (token.code === "M104" || token.code === "M109") {
					const s = paramNumber(parseParams(token.body), "S");
					if (s !== null) lastCommandedTemp = s;
				}

				const info = advanceTravelState(state, ctx, token);
				if (info === null) return undefined;

				if (info.isRetraction) {
					lastWasRetraction = true;
					return undefined;
				}
				if (!info.isTravel || info.distance < config.thresholdMm) {
					lastWasRetraction = false;
					return undefined;
				}
				if (usesFirmwareRetraction || lastWasRetraction) {
					skipped++;
					lastWasRetraction = false;
					return undefined;
				}

				lastWasRetraction = false;
				inserted++;
				const before: Array<string> = [];
				const after: Array<string> = [];
				const dropTemp = config.dropTemperature && lastCommandedTemp !== null;

				if (ctx.relativeE) {
					before.push(`G1 E-${formatNumber(config.retractMm, config.decimals)} F${RETRACT_FEEDRATE}`);
				} else {
					before.push(`G1 E${formatNumber(state.e - config.retractMm, config.decimals)} F${RETRACT_FEEDRATE}`);
				}
				if (dropTemp) before.push(`M104 S${formatNumber((lastCommandedTemp as number) - config.tempDropC, 0)}`);

				if (dropTemp) after.push(`M104 S${formatNumber(lastCommandedTemp as number, 0)}`);
				if (ctx.relativeE) {
					after.push(`G1 E${formatNumber(config.retractMm, config.decimals)} F${RETRACT_FEEDRATE}`);
				} else {
					after.push(`G1 E${formatNumber(state.e, config.decimals)} F${RETRACT_FEEDRATE}`);
				}

				return [...before, line, ...after];
			},

			onEnd(runCtx: RunContext) {
				if (skipped > 0) {
					runCtx.warn(
						`Ooze control: skipped ${skipped} travel${skipped === 1 ? "" : "s"} that already had a `
						+ "retraction or used firmware retraction (G10/G11), out of "
						+ `${inserted + skipped} candidate travel${inserted + skipped === 1 ? "" : "s"}.`,
					);
				}
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (config.retractMm <= 0) errors.push("Retraction length must be greater than 0");
		if (config.dropTemperature && config.tempDropC <= 0) errors.push("Temperature drop must be greater than 0");
		return errors;
	},
};
