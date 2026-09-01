/**
 * Rewrite one command as another, moving its parameters across.
 *
 * A plain find/replace gets `M900 K0.05` to `M572 K0.05` — which RepRapFirmware rejects, because
 * the factor belongs in S and the drive has to be named in D. Mapping parameters explicitly is the
 * difference between a substitution that looks right and one that runs, so this step understands
 * the command structure rather than the text.
 */

import { formatNumber, parseParams, setParam, tokenise, withBody } from "../gcode/tokenise";
import { inLayerRange, type LineContext, type StepDefinition, type Transform } from "./types";

export interface CommandMapConfig {
	from: string;
	to: string;
	paramMap: string;
	addParams: string;
	dropParams: string;
	/** Only map a line that carries this parameter. Empty means map every occurrence. */
	onlyWithParam: string;
	keepOriginal: boolean;
	layerFrom: number;
	layerTo: number;
}

/** Parse "K=S, T=D" into an ordered list of renames. Tolerant of spacing and of a trailing comma. */
export function parseParamMap(text: string): Array<{ from: string; to: string }> {
	const result: Array<{ from: string; to: string }> = [];
	for (const part of text.split(",")) {
		const trimmed = part.trim();
		if (trimmed === "") continue;
		const m = /^([A-Za-z])\s*(?:=|->|:)\s*([A-Za-z])$/.exec(trimmed);
		if (m !== null) result.push({ from: m[1].toUpperCase(), to: m[2].toUpperCase() });
	}
	return result;
}

/** Parse "D0, S1" into parameters to append. */
export function parseAddParams(text: string): Array<{ letter: string; value: string }> {
	const result: Array<{ letter: string; value: string }> = [];
	for (const part of text.split(",")) {
		const trimmed = part.trim();
		if (trimmed === "") continue;
		const m = /^([A-Za-z])\s*=?\s*(.*)$/.exec(trimmed);
		if (m !== null) result.push({ letter: m[1].toUpperCase(), value: m[2].trim() });
	}
	return result;
}

/** Parse "T, P" into a list of parameter letters to remove. */
export function parseLetters(text: string): Array<string> {
	return text.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]$/.test(s));
}

/**
 * Rewrite a single line according to a mapping. Exported for testing and reused by the preset
 * recipes; returns null when the line's command does not match — including when `onlyWithParam` is
 * set and this line does not carry it, which is what lets `M104 S200 T1` (Marlin: tool 1's
 * temperature) be rewritten to `M568 P1 S200` while a bare `M104 S200` (targets the current tool in
 * both firmwares) is correctly left alone rather than gaining a `P` it never had.
 */
export function mapCommand(
	line: string,
	spec: {
		from: string;
		to: string;
		renames: Array<{ from: string; to: string }>;
		adds: Array<{ letter: string; value: string }>;
		drops: Array<string>;
		onlyWithParam: string;
		keepOriginal: boolean;
	},
): string | null {
	const token = tokenise(line);
	if (token.code === null || token.code.toUpperCase() !== spec.from) return null;

	const params = parseParams(token.body);
	if (spec.onlyWithParam !== "" && !params.some((p) => p.letter === spec.onlyWithParam)) return null;

	// Rebuild rather than patch: renaming K to S in place would leave the parameters in an order
	// that reads oddly, and appending is what makes the result look hand-written
	const kept: Array<{ letter: string; value: string }> = [];
	for (const p of params) {
		if (spec.drops.includes(p.letter)) continue;
		const rename = spec.renames.find((r) => r.from === p.letter);
		kept.push({ letter: rename === undefined ? p.letter : rename.to, value: p.value });
	}
	for (const add of spec.adds) {
		if (!kept.some((k) => k.letter === add.letter)) kept.push(add);
	}

	// Keep whatever whitespace sat between the command and its comment, so a rewritten line does
	// not lose the gap and read as "M572 K0.05; comment"
	const trailing = token.body.slice(token.body.replace(/\s+$/, "").length);
	const body = [spec.to, ...kept.map((k) => `${k.letter}${k.value}`)].join(" ");
	const rewritten = withBody(token, body + trailing);
	return spec.keepOriginal ? `${rewritten} ; was: ${token.body.trim()}` : rewritten;
}

export const commandMapStep: StepDefinition<CommandMapConfig> = {
	id: "commandMap",
	label: "Map a command",
	description: "Rewrite one G/M command as another, renaming, adding or dropping its parameters.",
	tip: "For when find/replace would produce something the firmware rejects — e.g. Marlin's "
		+ "\"M900 K0.05\" has to become RepRapFirmware's \"M572 D0 S0.05\", not \"M572 K0.05\", "
		+ "because the factor belongs in S and the drive has to be named in D. This understands the "
		+ "command's own parameter structure, so renames/adds/drops apply correctly regardless of "
		+ "what order the original parameters were written in, and a rewritten line's parameters "
		+ "come out in a sensible order rather than patched in place.",
	docsAnchor: "map-a-command",
	icon: "mdi-swap-horizontal",
	fields: [
		{
			key: "from", label: "Replace command", type: "text", required: true, default: "",
			placeholder: "M900",
			help: "The command to match, e.g. M900. Matched on the command only, not its parameters.",
		},
		{
			key: "to", label: "With command", type: "text", required: true, default: "",
			placeholder: "M572",
			help: "The command to write instead.",
		},
		{
			key: "paramMap", label: "Rename parameters", type: "text", default: "",
			placeholder: "K=S",
			help: "Comma-separated renames, e.g. \"K=S, T=P\". Parameters not listed keep their letter.",
		},
		{
			key: "addParams", label: "Add parameters", type: "text", default: "",
			placeholder: "D0",
			help: "Comma-separated additions, e.g. \"D0\". Skipped when the parameter is already present.",
		},
		{
			key: "dropParams", label: "Drop parameters", type: "text", default: "",
			placeholder: "T",
			help: "Comma-separated letters to remove, e.g. \"T, P\".",
		},
		{
			key: "onlyWithParam", label: "Only when this parameter is present", type: "text", default: "",
			placeholder: "T",
			help: "A single letter. Lines without it are left completely alone, instead of gaining a parameter they never had. Empty maps every occurrence. Default: empty.",
		},
		{
			key: "keepOriginal", label: "Keep the original as a comment", type: "boolean", default: true,
			help: "Appends \"; was: …\" so the change is auditable in the file itself. Default: on.",
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
		const spec = {
			from: config.from.trim().toUpperCase(),
			to: config.to.trim().toUpperCase(),
			renames: parseParamMap(config.paramMap),
			adds: parseAddParams(config.addParams),
			drops: parseLetters(config.dropParams),
			onlyWithParam: config.onlyWithParam.trim().toUpperCase(),
			keepOriginal: config.keepOriginal,
		};
		const { layerFrom, layerTo } = config;

		return {
			id: "commandMap",
			onLine(ctx: LineContext, line: string) {
				if (!inLayerRange(ctx.layer, layerFrom, layerTo)) return undefined;
				const mapped = mapCommand(line, spec);
				return mapped === null ? undefined : mapped;
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (!/^[GMT]\d+(\.\d+)?$/i.test(config.from.trim())) errors.push("'Replace command' should look like M900, G29 or T1");
		if (!/^[GMT]\d+(\.\d+)?$/i.test(config.to.trim())) errors.push("'With command' should look like M572, G32 or T0");
		if (config.onlyWithParam.trim() !== "" && !/^[A-Za-z]$/.test(config.onlyWithParam.trim())) {
			errors.push("'Only when this parameter is present' must be a single letter");
		}
		return errors;
	},
};

/** Re-exported for the preset recipes, which build mappings without going through the UI. */
export { formatNumber, setParam };
