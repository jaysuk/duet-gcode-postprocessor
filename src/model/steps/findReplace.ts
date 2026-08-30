/**
 * Find and replace — the workhorse, and deliberately compatible with PrusaSlicer's
 * "G-code Substitutions" (Print Settings -> Output options): the same literal/regex, case-sensitive
 * and whole-word switches, so an existing rule ports across unchanged.
 *
 * One documented difference: PrusaSlicer applies patterns to a whole layer block, so a regex there
 * can span lines. This runs per line. Everything single-line behaves identically; a multi-line
 * pattern will not match here (see the limitation note in docs/usage.md).
 */

import {
	buildMatcher, inLayerRange, type LineContext, type StepDefinition, type Transform,
} from "./types";

export interface FindReplaceConfig {
	find: string;
	replace: string;
	regex: boolean;
	caseSensitive: boolean;
	wholeWord: boolean;
	all: boolean;
	layerFrom: number;
	layerTo: number;
}

export const findReplaceStep: StepDefinition<FindReplaceConfig> = {
	id: "findReplace",
	label: "Find and replace",
	description: "Replace text on matching lines, literally or by regular expression.",
	icon: "mdi-find-replace",
	fields: [
		{
			key: "find", label: "Find", type: "regex", required: true, default: "",
			placeholder: "M900 K",
			help: "Text to look for. With 'Regular expression' off this is matched literally.",
		},
		{
			key: "replace", label: "Replace with", type: "text", default: "",
			placeholder: "M572 D0 S",
			help: "Replacement text. In regex mode $1, $2 … insert capture groups. Empty deletes the match.",
		},
		{
			key: "regex", label: "Regular expression", type: "boolean", default: false,
			help: "Treat 'Find' as a JavaScript (ECMAScript) regular expression. Default: off.",
		},
		{
			key: "caseSensitive", label: "Case sensitive", type: "boolean", default: true,
			help: "Match upper and lower case exactly. Default: on — G-code is conventionally upper case.",
		},
		{
			key: "wholeWord", label: "Whole word only", type: "boolean", default: false,
			help: "Require a word boundary either side, so 'M10' does not match inside 'M104'. Default: off.",
		},
		{
			key: "all", label: "Replace every occurrence on a line", type: "boolean", default: true,
			help: "Off replaces only the first match on each line. Default: on.",
		},
		{
			key: "layerFrom", label: "From layer", type: "number", default: -1, min: -1,
			help: "Only apply at or after this layer index. -1 means from the start of the file. Default: -1.",
		},
		{
			key: "layerTo", label: "To layer", type: "number", default: -1, min: -1,
			help: "Only apply at or before this layer index. -1 means to the end of the file. Default: -1.",
		},
	],

	create(config): Transform {
		const matcher = buildMatcher({
			pattern: config.find,
			regex: config.regex,
			caseSensitive: config.caseSensitive,
			wholeWord: config.wholeWord,
			all: config.all,
		});
		const replacement = config.replace;
		const { layerFrom, layerTo } = config;

		return {
			id: "findReplace",
			onLine(ctx: LineContext, line: string) {
				if (!inLayerRange(ctx.layer, layerFrom, layerTo)) return undefined;
				// A global regex carries lastIndex between calls; reset so line N+1 is matched from 0
				matcher.lastIndex = 0;
				if (!matcher.test(line)) return undefined;
				matcher.lastIndex = 0;
				const next = line.replace(matcher, replacement);
				return next === line ? undefined : next;
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (config.find === "") errors.push("Find is required");
		if (typeof config.layerFrom === "number" && typeof config.layerTo === "number"
			&& config.layerFrom >= 0 && config.layerTo >= 0 && config.layerFrom > config.layerTo) {
			errors.push("'From layer' is after 'To layer'");
		}
		return errors;
	},
};
