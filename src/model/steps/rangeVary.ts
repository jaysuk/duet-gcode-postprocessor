/**
 * Sweep a value across the height of the print — the calibration-tower step.
 *
 * This is the one transformation that is genuinely hard to do any other way: it turns a print you
 * already sliced into a pressure-advance, temperature, retraction or speed tower without going back
 * to the slicer. At each band boundary it emits a rendered command and, optionally, a display
 * message so the finished part can be read off against the values.
 */

import { formatNumber } from "../gcode/tokenise";
import { expandPlaceholders, textToLines, type LineContext, type RunContext, type StepDefinition, type Transform } from "./types";

export interface RangeVaryConfig {
	template: string;
	from: number;
	to: number;
	bands: number;
	layersPerBand: number;
	mode: "bands" | "perLayer";
	startLayer: number;
	decimals: number;
	announce: boolean;
	announceTemplate: string;
}

/**
 * Value for a given band index. Bands are inclusive of both ends: with 5 bands from 0 to 0.1 the
 * values are 0, 0.025, 0.05, 0.075, 0.1 — which is what someone measuring a tower expects.
 */
export function bandValue(index: number, bands: number, from: number, to: number): number {
	if (bands <= 1) return from;
	const clamped = Math.min(Math.max(index, 0), bands - 1);
	return from + ((to - from) * clamped) / (bands - 1);
}

/** Which band a layer belongs to, or -1 when it is before the start of the sweep. */
export function bandForLayer(layer: number, startLayer: number, layersPerBand: number, bands: number): number {
	if (layer < startLayer) return -1;
	const index = Math.floor((layer - startLayer) / Math.max(1, layersPerBand));
	return index >= bands ? -1 : index;
}

export const rangeVaryStep: StepDefinition<RangeVaryConfig> = {
	id: "rangeVary",
	label: "Vary a value up the print (calibration tower)",
	description: "Emit a command with a value that steps from one number to another as the print gets taller.",
	tip: "Turns a print you already sliced into a pressure-advance, temperature, retraction or speed "
		+ "tower without going back to the slicer — the one transformation genuinely hard to do any "
		+ "other way. Works on a plain single object: run it on a tall calibration cube or tower "
		+ "model, not a multi-part plate, since it steps by layer height, not by feature. \"In a "
		+ "fixed number of bands\" is the usual choice — easier to measure against the finished part "
		+ "than \"every layer\", which produces a smoother but harder-to-read gradient and needs the "
		+ "file to state its own layer count to reach the end value exactly.",
	docsAnchor: "vary-a-value-up-the-print-calibration-tower",
	icon: "mdi-stairs-up",
	fields: [
		{
			key: "template", label: "Command", type: "gcode", required: true, default: "M572 D0 S{value}",
			placeholder: "M572 D0 S{value}",
			help: "Emitted at each band. {value} is the swept number, formatted to 'Decimal places' "
				+ "below; {band} is the 1-based band number; {layer}, {z}, {tool}, {line}, {file} and "
				+ "{feedrate} are also available, same as \"Insert G-code\".",
		},
		{
			key: "from", label: "From", type: "number", default: 0, step: 0.01,
			help: "Value at the bottom of the print.",
		},
		{
			key: "to", label: "To", type: "number", default: 0.1, step: 0.01,
			help: "Value at the top of the sweep.",
		},
		{
			key: "mode", label: "Change", type: "select", default: "bands",
			options: [
				{ value: "bands", label: "In a fixed number of bands" },
				{ value: "perLayer", label: "Every layer" },
			],
			help: "Default: bands — easier to measure on the finished part.",
		},
		{
			key: "bands", label: "Number of bands", type: "number", default: 10, min: 2, max: 500,
			showWhen: { key: "mode", equals: ["bands"] },
			help: "How many distinct values to step through. Default: 10.",
		},
		{
			key: "layersPerBand", label: "Layers per band", type: "number", default: 10, min: 1,
			showWhen: { key: "mode", equals: ["bands"] },
			help: "How tall each band is. Default: 10.",
		},
		{
			key: "startLayer", label: "Start at layer", type: "number", default: 1, min: 0,
			help: "Skip the first layers so the sweep does not disturb bed adhesion. Default: 1.",
		},
		{
			key: "decimals", label: "Decimal places", type: "number", default: 3, min: 0, max: 6,
			help: "How precisely {value} is formatted in the emitted command. Default: 3.",
		},
		{
			key: "announce", label: "Show the value on the display", type: "boolean", default: true,
			help: "Emits a message alongside each change so you can follow the sweep. Default: on.",
		},
		{
			key: "announceTemplate", label: "Message command", type: "gcode",
			default: "M117 band {band}: {value}",
			showWhen: { key: "announce", equals: [true] },
			help: "Use M117 for the panel, or M291 P\"…\" S0 for a DWC message box.",
		},
	],

	create(config): Transform {
		const template = textToLines(config.template);
		const announceLines = config.announce ? textToLines(config.announceTemplate) : [];
		const perLayer = config.mode === "perLayer";
		const decimals = Math.max(0, Math.min(6, Math.trunc(config.decimals)));
		const layersPerBand = perLayer ? 1 : Math.max(1, Math.trunc(config.layersPerBand));
		const bands = perLayer ? Number.MAX_SAFE_INTEGER : Math.max(2, Math.trunc(config.bands));
		const startLayer = Math.max(0, Math.trunc(config.startLayer));

		let lastBand = -1;
		let totalLayers: number | null = null;
		let warned = false;

		function render(lines: Array<string>, ctx: LineContext, value: number, band: number): Array<string> {
			return lines.map((l) =>
				expandPlaceholders(l, ctx)
					.replace(/\{value\}/g, formatNumber(value, decimals))
					.replace(/\{band\}/g, String(band + 1)),
			);
		}

		return {
			id: "rangeVary",

			onStart(ctx: RunContext) {
				lastBand = -1;
				warned = false;
				totalLayers = ctx.totalLayers;
				if (perLayer && totalLayers === null) {
					ctx.warn("'Every layer' mode needs the total layer count, which this file does not state. The sweep will step per layer from the start value but may not reach the end value.");
				}
			},

			onLine(ctx: LineContext, line: string) {
				if (!ctx.layerChanged) return undefined;

				let band: number;
				let value: number;
				if (perLayer) {
					// Spread the range over the whole print when the layer count is known; without it,
					// fall back to a fixed step so the file is still processed rather than refused
					const span = totalLayers === null ? null : Math.max(1, totalLayers - startLayer);
					band = ctx.layer - startLayer;
					if (band < 0) return undefined;
					value = span === null
						? config.from + (config.to - config.from) * 0
						: bandValue(band, span, config.from, config.to);
					if (span === null && !warned) warned = true;
				} else {
					band = bandForLayer(ctx.layer, startLayer, layersPerBand, bands);
					if (band < 0 || band === lastBand) return undefined;
					value = bandValue(band, bands, config.from, config.to);
				}
				if (band === lastBand) return undefined;
				lastBand = band;

				const emitted = [
					...render(template, ctx, value, band),
					...render(announceLines, ctx, value, band),
				];
				return emitted.length === 0 ? undefined : [line, ...emitted];
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (!config.template.includes("{value}")) errors.push("The command should contain {value} — otherwise nothing varies");
		if (config.from === config.to) errors.push("'From' and 'To' are the same, so nothing would change");
		return errors;
	},
};
