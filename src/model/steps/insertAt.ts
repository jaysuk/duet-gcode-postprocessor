/**
 * Insert G-code at an anchor.
 *
 * This is the step that covers most of what people actually post-process for: pause at a layer,
 * fire a timelapse macro every layer, put a message on the screen at 50%, run a purge before every
 * tool change. All of those are "put these lines here", so they are one step with an anchor
 * selector rather than eight near-identical steps.
 */

import {
	buildMatcher, expandPlaceholders, textToLines,
	type LineContext, type RunContext, type StepDefinition, type Transform,
} from "./types";

export type AnchorType =
	| "fileStart" | "fileEnd" | "layer" | "everyLayer" | "firstLayerChange"
	| "z" | "toolChange" | "match" | "objectStart" | "percent";

export interface InsertAtConfig {
	anchor: AnchorType;
	text: string;
	position: "before" | "after";
	layer: number;
	interval: number;
	offset: number;
	z: number;
	tolerance: number;
	tool: number;
	pattern: string;
	regex: boolean;
	caseSensitive: boolean;
	percent: number;
	once: boolean;
}

export const insertAtStep: StepDefinition<InsertAtConfig> = {
	id: "insertAt",
	label: "Insert G-code",
	description: "Add lines at the start or end of the file, at a layer, at a Z height, at a tool change, or wherever a pattern matches.",
	tip: "Covers most day-to-day post-processing on its own: pause at a layer, fire a timelapse "
		+ "macro every layer, show a message at 50%, run a purge before every tool change — all of "
		+ "those are \"put these lines here\", picked apart only by which anchor they attach to. "
		+ "Add several insert steps to a recipe to combine anchors (a park move at a layer plus a "
		+ "message at a percentage, say). Placeholders in the inserted text are resolved per "
		+ "occurrence, using this line's own machine state at the point of insertion — {layer} is "
		+ "always the anchor's layer even if you inserted \"after\" and the next line changes it.",
	docsAnchor: "insert-g-code",
	icon: "mdi-playlist-plus",
	fields: [
		{
			key: "anchor", label: "Where", type: "select", default: "layer",
			options: [
				{ value: "fileStart", label: "Start of file" },
				{ value: "fileEnd", label: "End of file" },
				{ value: "firstLayerChange", label: "At the first layer change" },
				{ value: "layer", label: "At a specific layer" },
				{ value: "everyLayer", label: "At every layer change" },
				{ value: "z", label: "At a Z height" },
				{ value: "toolChange", label: "At a tool change" },
				{ value: "objectStart", label: "At the start of each object (M486)" },
				{ value: "percent", label: "At a percentage through the file" },
				{ value: "match", label: "Wherever a pattern matches" },
			],
			help: "The anchor the inserted lines attach to — the fields below change to match. "
				+ "\"At the start/end of each object\" needs the file to already carry M486 labels "
				+ "(the \"Convert Klipper object markers\" step adds them if it does not).",
		},
		{
			key: "text", label: "G-code to insert", type: "gcode", required: true, default: "",
			placeholder: "M291 P\"Layer {layer} reached\" S0",
			help: "One command per line. Placeholders, expanded per occurrence from this line's own "
				+ "machine state: {layer} the layer index, {z} the current Z height, {tool} the "
				+ "current tool number, {line} the 1-based source line number, {file} the file's own "
				+ "SD-card path, {feedrate} the sticky F value last set, {object} the current M486 "
				+ "label. A placeholder with nothing to resolve to (e.g. {z} before any Z move) "
				+ "expands to an empty string, not the literal text.",
		},
		{
			key: "position", label: "Position", type: "select", default: "after",
			options: [
				{ value: "before", label: "Before the anchor line" },
				{ value: "after", label: "After the anchor line" },
			],
			showWhen: {
				key: "anchor",
				equals: ["layer", "everyLayer", "firstLayerChange", "z", "toolChange", "match", "objectStart", "percent"],
			},
			help: "\"The anchor line\" is the actual source line that satisfied the anchor — the "
				+ "specific move that reached the Z height, the T command that changed tool, the line "
				+ "the pattern matched. \"After\" is the natural choice for reacting to something "
				+ "that just happened (a purge after a tool change); \"before\" for something that "
				+ "must happen first (a park move before the layer that needs to pause). Default: after.",
		},
		{
			key: "layer", label: "Layer index", type: "number", default: 1, min: 0,
			showWhen: { key: "anchor", equals: ["layer"] },
			help: "0 is the first layer. The inspector shows the layer count for the selected file.",
		},
		{
			key: "interval", label: "Every N layers", type: "number", default: 1, min: 1,
			showWhen: { key: "anchor", equals: ["everyLayer"] },
			help: "1 inserts at every layer change, 5 at every fifth. Default: 1.",
		},
		{
			key: "offset", label: "Starting from layer", type: "number", default: 0, min: 0,
			showWhen: { key: "anchor", equals: ["everyLayer"] },
			help: "Skip layers before this index. Default: 0.",
		},
		{
			key: "z", label: "Z height (mm)", type: "number", default: 1, step: 0.1,
			showWhen: { key: "anchor", equals: ["z"] },
			help: "Insert at the first move that reaches this height.",
		},
		{
			key: "tolerance", label: "Z tolerance (mm)", type: "number", default: 0.05, min: 0, step: 0.01,
			showWhen: { key: "anchor", equals: ["z"] },
			help: "How close a Z move has to be to count as reaching the height. Default: 0.05.",
		},
		{
			key: "tool", label: "Only for tool", type: "number", default: -1, min: -1,
			showWhen: { key: "anchor", equals: ["toolChange"] },
			help: "-1 means any tool change. Default: -1.",
		},
		{
			key: "pattern", label: "Pattern", type: "regex", default: "",
			showWhen: { key: "anchor", equals: ["match"] },
			help: "Insert relative to every line this matches.",
		},
		{
			key: "regex", label: "Regular expression", type: "boolean", default: false,
			showWhen: { key: "anchor", equals: ["match"] },
			help: "Treat 'Pattern' as a JavaScript regular expression rather than literal text. Default: off.",
		},
		{
			key: "caseSensitive", label: "Case sensitive", type: "boolean", default: true,
			showWhen: { key: "anchor", equals: ["match"] },
			help: "Match upper and lower case exactly. Default: on — G-code is conventionally upper case.",
		},
		{
			key: "percent", label: "Percent through file", type: "number", default: 50, min: 0, max: 100,
			showWhen: { key: "anchor", equals: ["percent"] },
			help: "By file size, not by print time — the two differ on prints with dense top layers. "
				+ "If the file's size cannot be determined, this anchor never fires and the run "
				+ "reports it rather than silently doing nothing.",
		},
		{
			key: "once", label: "Only the first time", type: "boolean", default: false,
			showWhen: { key: "anchor", equals: ["match", "toolChange", "objectStart"] },
			help: "Insert once, at the first match, then stop — instead of at every tool change, "
				+ "every object, or every line 'Pattern' matches. Default: off.",
		},
	],

	create(config): Transform {
		const lines = textToLines(config.text);
		const before = config.position === "before";
		const anchor = config.anchor;
		const matcher = anchor === "match" && config.pattern !== ""
			? buildMatcher({ pattern: config.pattern, regex: config.regex, caseSensitive: config.caseSensitive })
			: null;

		let fired = false;
		let lastTool = -2;
		let lastObject: string | null = null;
		let sourcePath = "";

		function emit(ctx: LineContext, line: string, sourcePath: string): Array<string> {
			const rendered = lines.map((l) => expandPlaceholders(l, ctx, sourcePath));
			return before ? [...rendered, line] : [line, ...rendered];
		}

		return {
			id: "insertAt",

			onStart(ctx: RunContext): Array<string> | void {
				sourcePath = ctx.sourcePath;
				fired = false;
				lastTool = -2;
				lastObject = null;
				if (anchor === "fileStart") return lines.slice();
			},

			onEnd(): Array<string> | void {
				if (anchor === "fileEnd") return lines.slice();
			},

			onLine(ctx: LineContext, line: string) {
				if (lines.length === 0) return undefined;
				switch (anchor) {
					case "fileStart":
					case "fileEnd":
						return undefined;

					case "layer":
						if (ctx.layerChanged && ctx.layer === config.layer) {
							return emit(ctx, line, sourcePath);
						}
						return undefined;

					case "firstLayerChange":
						if (ctx.layerChanged && !fired) {
							fired = true;
							return emit(ctx, line, sourcePath);
						}
						return undefined;

					case "everyLayer": {
						if (!ctx.layerChanged || ctx.layer < config.offset) return undefined;
						const interval = Math.max(1, Math.trunc(config.interval));
						if ((ctx.layer - config.offset) % interval !== 0) return undefined;
						return emit(ctx, line, sourcePath);
					}

					case "z": {
						if (fired || ctx.z === null) return undefined;
						// The state machine has already applied this line's Z, so a match here means
						// "this is the move that reaches the height"
						if (Math.abs(ctx.z - config.z) > Math.max(0, config.tolerance)) return undefined;
						fired = true;
						return emit(ctx, line, sourcePath);
					}

					case "toolChange": {
						if (ctx.token.letter !== "T" || ctx.token.number === null) return undefined;
						if (config.tool >= 0 && ctx.token.number !== config.tool) return undefined;
						if (ctx.token.number === lastTool) return undefined;
						lastTool = ctx.token.number;
						if (config.once && fired) return undefined;
						fired = true;
						return emit(ctx, line, sourcePath);
					}

					case "objectStart": {
						if (ctx.object === null || ctx.object === lastObject) return undefined;
						lastObject = ctx.object;
						if (config.once && fired) return undefined;
						fired = true;
						return emit(ctx, line, sourcePath);
					}

					case "percent": {
						if (fired || ctx.progress === null) return undefined;
						if (ctx.progress * 100 < config.percent) return undefined;
						fired = true;
						return emit(ctx, line, sourcePath);
					}

					case "match": {
						if (matcher === null || (config.once && fired)) return undefined;
						matcher.lastIndex = 0;
						if (!matcher.test(line)) return undefined;
						fired = true;
						return emit(ctx, line, sourcePath);
					}
				}
				return undefined;
			},
		};
	},

	validate(config) {
		const errors: Array<string> = [];
		if (textToLines(config.text).length === 0) errors.push("Nothing to insert");
		if (config.anchor === "match" && config.pattern === "") errors.push("A pattern is required for 'wherever a pattern matches'");
		return errors;
	},
};

/**
 * Anchors that need to know the file size up front (so the transfer layer can refuse a
 * percent-anchored recipe when it cannot determine the size).
 */
export function anchorNeedsFileSize(anchor: AnchorType): boolean {
	return anchor === "percent";
}

/** Warn from a run when a percent anchor never fired because the size was unknown. */
export function warnUnfiredPercent(ctx: RunContext, anchor: AnchorType, progressKnown: boolean): void {
	if (anchor === "percent" && !progressKnown) {
		ctx.warn("A 'percentage through file' insertion was skipped because the file size was not known.");
	}
}
