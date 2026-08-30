/**
 * The step contract every transformation implements, plus the field-schema that lets one generic
 * Vue form render the editor for all of them.
 *
 * The schema exists so adding a step type is a single model file and a registry entry — no new
 * component, no new i18n block, and the registry-driven smoke test picks it up automatically.
 */

import type { SlicerMetadata } from "../gcode/metadata";
import type { MachineState } from "../gcode/state";
import type { Tokenised } from "../gcode/tokenise";

/** Read-only view of the machine state plus the tokenised source line. */
export interface LineContext extends Readonly<MachineState> {
	/** Tokenised form of the **original** source line (not the possibly-rewritten current text). */
	readonly token: Tokenised;
	/** Slicer metadata pre-scanned from the head and tail of the file. */
	readonly meta: SlicerMetadata;
	/** Total layers when known (from metadata), else null. */
	readonly totalLayers: number | null;
	/** Fraction of the file processed so far, 0..1, or null when the size is unknown. */
	readonly progress: number | null;
}

export interface RunContext {
	readonly meta: SlicerMetadata;
	readonly sourcePath: string;
	readonly totalLayers: number | null;
	/** Recorded by a step to surface a non-fatal problem in the run report. */
	warn(message: string): void;
}

/**
 * A step's return value for one line:
 * - `undefined` — leave the line exactly as it was (the fast path; no allocation)
 * - `string` — replace it
 * - `string[]` — replace it with several lines (an empty array drops it)
 * - `null` — drop the line
 */
export type StepResult = string | Array<string> | null | undefined;

export interface Transform {
	/** Step type id, matching the registry key. */
	readonly id: string;
	/** Lines to emit before the first source line. */
	onStart?(ctx: RunContext): Array<string> | void;
	/** Transform one line. Called for every line, in recipe order. */
	onLine(ctx: LineContext, line: string): StepResult;
	/** Lines to emit after the last source line. */
	onEnd?(ctx: RunContext): Array<string> | void;
}

// #region Field schema

export type FieldType = "text" | "textarea" | "number" | "boolean" | "select" | "gcode" | "regex";

export interface StepField {
	key: string;
	label: string;
	type: FieldType;
	/** Shown as a help tooltip. State the default here — every sibling plugin does. */
	help?: string;
	default: unknown;
	options?: Array<{ value: string; label: string }>;
	min?: number;
	max?: number;
	step?: number;
	/** Only show this field when another boolean/select field has one of these values. */
	showWhen?: { key: string; equals: Array<unknown> };
	/** Field is required — validation fails when it is blank. */
	required?: boolean;
	placeholder?: string;
}

export interface StepDefinition<C = Record<string, unknown>> {
	id: string;
	label: string;
	/** One line, shown under the label in the "add step" menu. */
	description: string;
	icon: string;
	fields: Array<StepField>;
	/** Build the transform. Throws a {@link StepConfigError} when the config is unusable. */
	create(config: C, ctx: StepFactoryContext): Transform;
	/** Optional extra validation beyond required/min/max; returns error messages. */
	validate?(config: C): Array<string>;
}

/** Anything a step needs from outside its own config (currently: script trust). */
export interface StepFactoryContext {
	/** True when the user has explicitly approved running scripts for this recipe. */
	scriptsTrusted: boolean;
}

export class StepConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StepConfigError";
	}
}

/** Fill in defaults for any field the stored config does not have. */
export function withDefaults(def: StepDefinition, config: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const field of def.fields) {
		result[field.key] = Object.prototype.hasOwnProperty.call(config, field.key)
			? config[field.key]
			: field.default;
	}
	return result;
}

/** Validate a step config against its schema. Returns human-readable messages, empty when valid. */
export function validateStep(def: StepDefinition, config: Record<string, unknown>): Array<string> {
	const errors: Array<string> = [];
	for (const field of def.fields) {
		if (!isFieldVisible(field, config)) continue;
		const value = config[field.key];
		if (field.required === true && (value === undefined || value === null || value === "")) {
			errors.push(`${field.label} is required`);
			continue;
		}
		if (field.type === "number") {
			// Vuetify's v-model.number leaves "" (not 0/NaN) in a cleared field, and the global
			// isFinite("") is true — so the check has to be typeof-first, and an empty field has
			// to be an error in its own right rather than something to skip past
			if (typeof value !== "number" || !Number.isFinite(value)) {
				errors.push(`${field.label} must be a number`);
			} else {
				if (field.min !== undefined && value < field.min) errors.push(`${field.label} must be at least ${field.min}`);
				if (field.max !== undefined && value > field.max) errors.push(`${field.label} must be at most ${field.max}`);
			}
		}
		if (field.type === "regex" && typeof value === "string" && value !== "") {
			try {
				new RegExp(value);
			} catch (e) {
				errors.push(`${field.label} is not a valid regular expression: ${(e as Error).message}`);
			}
		}
	}
	return errors;
}

/** Whether a field's `showWhen` condition is currently satisfied. */
export function isFieldVisible(field: StepField, config: Record<string, unknown>): boolean {
	if (field.showWhen === undefined) return true;
	return field.showWhen.equals.includes(config[field.showWhen.key]);
}

// #endregion

// #region Shared config helpers used by several steps

/** Layer-range gate shared by most steps; `from`/`to` of -1 mean "unbounded". */
export function inLayerRange(layer: number, from: unknown, to: unknown): boolean {
	const lo = typeof from === "number" && Number.isFinite(from) ? from : -1;
	const hi = typeof to === "number" && Number.isFinite(to) ? to : -1;
	if (lo >= 0 && layer < lo) return false;
	if (hi >= 0 && layer > hi) return false;
	return true;
}

/** Escape a literal string for use inside a RegExp. */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the matcher for the find/replace-style steps.
 * Literal mode escapes; whole-word wraps in \b; `all` adds the global flag.
 */
export function buildMatcher(opts: {
	pattern: string;
	regex: boolean;
	caseSensitive: boolean;
	wholeWord?: boolean;
	all?: boolean;
}): RegExp {
	let source = opts.regex ? opts.pattern : escapeRegExp(opts.pattern);
	if (opts.wholeWord === true) source = `\\b(?:${source})\\b`;
	let flags = "";
	if (!opts.caseSensitive) flags += "i";
	if (opts.all === true) flags += "g";
	try {
		return new RegExp(source, flags);
	} catch (e) {
		throw new StepConfigError(`Invalid pattern: ${(e as Error).message}`);
	}
}

/**
 * Expand `{layer}`, `{z}`, `{tool}`, `{line}`, `{file}`, `{feedrate}`, `{object}` placeholders in
 * text a user typed into an insert/emit field.
 */
export function expandPlaceholders(text: string, ctx: LineContext, sourcePath = ""): string {
	if (!text.includes("{")) return text;
	return text.replace(/\{(layer|z|tool|line|file|feedrate|object)\}/g, (_all, key: string) => {
		switch (key) {
			case "layer": return String(ctx.layer);
			case "z": return ctx.z === null ? "" : String(ctx.z);
			case "tool": return String(ctx.tool);
			case "line": return String(ctx.lineNo);
			case "file": return sourcePath;
			case "feedrate": return ctx.feedrate === null ? "" : String(ctx.feedrate);
			case "object": return ctx.object ?? "";
			default: return _all;
		}
	});
}

/** Split a multi-line text field into lines, dropping a trailing blank. */
export function textToLines(text: string): Array<string> {
	if (text === "") return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	return lines;
}

// #endregion
