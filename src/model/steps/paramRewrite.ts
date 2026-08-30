/**
 * Rewrite a numeric parameter on matching commands — scale every feedrate, nudge every Z, clamp
 * extrusion. The arithmetic is done on the parsed value and written back into the same span, so
 * everything else about the line (spacing, other parameters, the trailing comment) survives
 * untouched and the diff stays readable.
 */

import { formatNumber, parseParams, setParam, tokenise, withBody } from "../gcode/tokenise";
import { inLayerRange, StepConfigError, type LineContext, type StepDefinition, type Transform } from "./types";

export type RewriteOp = "scale" | "offset" | "set" | "clamp";

export interface ParamRewriteConfig {
	commands: string;
	param: string;
	op: RewriteOp;
	value: number;
	min: number;
	max: number;
	decimals: number;
	skipMissing: boolean;
	layerFrom: number;
	layerTo: number;
}

/** Apply the arithmetic. Exported so the unit tests can hit every operation without a pipeline. */
export function applyOp(op: RewriteOp, current: number, config: { value: number; min: number; max: number }): number {
	switch (op) {
		case "scale": return current * config.value;
		case "offset": return current + config.value;
		case "set": return config.value;
		case "clamp": {
			const lo = Number.isFinite(config.min) ? config.min : -Infinity;
			const hi = Number.isFinite(config.max) ? config.max : Infinity;
			return Math.min(Math.max(current, lo), hi);
		}
	}
}

export const paramRewriteStep: StepDefinition<ParamRewriteConfig> = {
	id: "paramRewrite",
	label: "Rewrite a parameter",
	description: "Scale, offset, set or clamp a numeric parameter on chosen commands.",
	icon: "mdi-calculator-variant-outline",
	fields: [
		{
			key: "commands", label: "On commands", type: "text", required: true, default: "G1",
			placeholder: "G0, G1",
			help: "Comma-separated command list, e.g. \"G0, G1\". Only these commands are touched.",
		},
		{
			key: "param", label: "Parameter", type: "text", required: true, default: "F",
			placeholder: "F",
			help: "The single letter to rewrite, e.g. F for feedrate, Z for height, E for extrusion.",
		},
		{
			key: "op", label: "Operation", type: "select", default: "scale",
			options: [
				{ value: "scale", label: "Multiply by" },
				{ value: "offset", label: "Add" },
				{ value: "set", label: "Set to" },
				{ value: "clamp", label: "Clamp between min and max" },
			],
			help: "Default: multiply.",
		},
		{
			key: "value", label: "Value", type: "number", default: 1, step: 0.01,
			showWhen: { key: "op", equals: ["scale", "offset", "set"] },
			help: "0.8 with 'multiply' makes everything 20% slower; 0.02 with 'add' raises Z by 0.02 mm.",
		},
		{
			key: "min", label: "Minimum", type: "number", default: 0,
			showWhen: { key: "op", equals: ["clamp"] },
			help: "Lower bound for the clamp.",
		},
		{
			key: "max", label: "Maximum", type: "number", default: 0,
			showWhen: { key: "op", equals: ["clamp"] },
			help: "Upper bound for the clamp.",
		},
		{
			key: "decimals", label: "Decimal places", type: "number", default: 3, min: 0, max: 6,
			help: "Trailing zeros are trimmed, so 3 gives 1200 rather than 1200.000. Default: 3.",
		},
		{
			key: "skipMissing", label: "Skip lines without the parameter", type: "boolean", default: true,
			help: "Off adds the parameter to matching commands that lack it (only sensible with 'Set to'). Default: on.",
		},
		{
			key: "layerFrom", label: "From layer", type: "number", default: -1, min: -1,
			help: "-1 means from the start of the file. Default: -1.",
		},
		{
			key: "layerTo", label: "To layer", type: "number", default: -1, min: -1,
			help: "-1 means to the end of the file. Default: -1.",
		},
	],

	create(config): Transform {
		const commands = new Set(
			config.commands.split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter((c) => c !== ""),
		);
		if (commands.size === 0) throw new StepConfigError("At least one command is required");
		const letter = config.param.trim().toUpperCase();
		if (!/^[A-Z]$/.test(letter)) throw new StepConfigError("The parameter must be a single letter");
		const decimals = Math.max(0, Math.min(6, Math.trunc(config.decimals)));
		const { layerFrom, layerTo, op, skipMissing } = config;

		return {
			id: "paramRewrite",
			onLine(ctx: LineContext, line: string) {
				if (!inLayerRange(ctx.layer, layerFrom, layerTo)) return undefined;
				// Tokenise the CURRENT text, not ctx.token: an earlier step may already have
				// rewritten this line, and the second rewrite has to see the first one's output
				const token = tokenise(line);
				if (token.code === null || !commands.has(token.code.toUpperCase())) return undefined;

				const params = parseParams(token.body);
				const existing = params.find((p) => p.letter === letter) ?? null;
				if (existing === null) {
					if (skipMissing || op !== "set") return undefined;
					const body = setParam(token.body, letter, formatNumber(config.value, decimals));
					return withBody(token, body);
				}

				const current = Number(existing.value);
				if (!Number.isFinite(current)) return undefined; // a string or expression: leave alone

				const next = applyOp(op, current, config);
				if (!Number.isFinite(next)) return undefined;
				const text = formatNumber(next, decimals);
				if (text === existing.value) return undefined;

				const body = token.body.slice(0, existing.start + 1) + text + token.body.slice(existing.end);
				return withBody(token, body);
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (!/^[A-Za-z]$/.test(config.param.trim())) errors.push("The parameter must be a single letter");
		if (config.commands.trim() === "") errors.push("At least one command is required");
		if (config.op === "clamp" && config.min > config.max) errors.push("Minimum is greater than maximum");
		if (config.op === "scale" && config.value === 0) errors.push("Multiplying by zero would flatten every value to 0");
		return errors;
	},
};
