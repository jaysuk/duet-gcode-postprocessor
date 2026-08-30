/**
 * Delete or comment out matching lines.
 *
 * Commenting out is the default rather than deleting outright: it keeps the file readable, keeps
 * line-for-line correspondence with a backup, and is what you actually want when disabling a
 * command you might need to put back.
 */

import {
	buildMatcher, inLayerRange, type LineContext, type StepDefinition, type Transform,
} from "./types";

export interface DeleteLinesConfig {
	pattern: string;
	regex: boolean;
	caseSensitive: boolean;
	action: "comment" | "delete";
	note: string;
	layerFrom: number;
	layerTo: number;
}

export const deleteLinesStep: StepDefinition<DeleteLinesConfig> = {
	id: "deleteLines",
	label: "Delete or disable lines",
	description: "Remove matching lines, or comment them out so they stay visible.",
	icon: "mdi-comment-remove-outline",
	fields: [
		{
			key: "pattern", label: "Matching", type: "regex", required: true, default: "",
			placeholder: "^M420",
			help: "A line is affected when this matches anywhere in it.",
		},
		{
			key: "regex", label: "Regular expression", type: "boolean", default: false,
			help: "Treat the pattern as a regular expression. Default: off.",
		},
		{
			key: "caseSensitive", label: "Case sensitive", type: "boolean", default: true,
			help: "Default: on.",
		},
		{
			key: "action", label: "Action", type: "select", default: "comment",
			options: [
				{ value: "comment", label: "Comment out (keep the line, disabled)" },
				{ value: "delete", label: "Delete the line entirely" },
			],
			help: "Default: comment out — reversible and easier to audit in a diff.",
		},
		{
			key: "note", label: "Note to append", type: "text", default: "disabled by post-processor",
			showWhen: { key: "action", equals: ["comment"] },
			help: "Appended after the commented-out line so its origin is obvious later.",
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
		const matcher = buildMatcher({
			pattern: config.pattern,
			regex: config.regex,
			caseSensitive: config.caseSensitive,
		});
		const commentOut = config.action !== "delete";
		const note = config.note === "" ? "" : ` ${config.note}`;
		const { layerFrom, layerTo } = config;

		return {
			id: "deleteLines",
			onLine(ctx: LineContext, line: string) {
				if (!inLayerRange(ctx.layer, layerFrom, layerTo)) return undefined;
				matcher.lastIndex = 0;
				if (!matcher.test(line)) return undefined;
				return commentOut ? `;${line}${note}` : null;
			},
		};
	},

	validate(config) {
		return config.pattern === "" ? ["A pattern is required"] : [];
	},
};
