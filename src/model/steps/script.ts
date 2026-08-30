/**
 * The JavaScript step — the escape hatch for what the rules tier cannot express.
 *
 * Honest description of the isolation, because overstating it would be worse than having none:
 * the user's code is compiled with `new Function` and invoked with the network and storage globals
 * *shadowed* by undefined parameters, so `fetch(...)` inside a script is a TypeError rather than a
 * request. That is a **guardrail, not a sandbox** — a determined script can still reach the real
 * global object via `[].constructor.constructor`. It is a fence against accidents and casual
 * copy-paste, not against hostile code. Two things carry the actual safety:
 *
 *   1. A script step refuses to run until the user has explicitly marked the recipe's scripts as
 *      trusted (`StepFactoryContext.scriptsTrusted`), having seen the source.
 *   2. A watchdog aborts the run when the script is spending an unreasonable amount of time per
 *      line, so an accidental infinite loop stops the run rather than the browser.
 *
 * The real fix is running this in a worker with the globals genuinely deleted; that is a build-level
 * change (the worker needs the pipeline bundled into it) and is tracked in PLAN.md.
 */

import { createGcodeApi, type GcodeApi } from "./scriptApi";
import { StepConfigError, type LineContext, type StepDefinition, type Transform } from "./types";

export interface ScriptConfig {
	source: string;
	maxMsPerLine: number;
}

/** Globals shadowed to `undefined` inside a script. */
export const SHADOWED_GLOBALS = [
	"fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker",
	"indexedDB", "localStorage", "sessionStorage", "caches",
	"window", "document", "globalThis", "self", "top", "parent", "navigator", "postMessage",
	"Function",
	// "eval" is deliberately absent: a strict-mode function cannot have a parameter named eval,
	// and the script body is compiled in strict mode. One more reason this is a guardrail rather
	// than a sandbox — see the module comment.
] as const;

export class ScriptAbortError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScriptAbortError";
	}
}

export interface ScriptApi {
	/** Queue a line to be emitted after the current one. */
	emit(text: string): void;
	/** Queue a line to be emitted before the current one. */
	emitBefore(text: string): void;
	/** Drop the current line. */
	drop(): void;
	/** Scratch object that persists for the whole run. */
	state: Record<string, unknown>;
	/** Record a message in the run report. */
	log(message: string): void;
	/** G-code helpers — the same tested tokeniser the rest of the plugin uses. */
	gcode: GcodeApi;
}

export type CompiledScript = (
	line: string,
	ctx: LineContext,
	api: ScriptApi,
	...shadowed: Array<undefined>
) => unknown;

/**
 * Compile a user script into a callable. The body may `return` a replacement string, return `null`
 * to drop the line, or return nothing to leave it alone.
 */
export function compileScript(source: string): CompiledScript {
	const params = ["line", "ctx", "__api", ...SHADOWED_GLOBALS];
	const body = `
"use strict";
const { emit, emitBefore, drop, state, log, gcode } = __api;
${source}
`;
	try {
		// eslint-disable-next-line no-new-func -- documented above: this IS the scripting feature
		return new Function(...params, body) as CompiledScript;
	} catch (e) {
		throw new StepConfigError(`Script does not compile: ${(e as Error).message}`);
	}
}

const DEFAULT_SCRIPT = `// Runs once per line. Return a string to replace it, null to drop it,
// or nothing to leave it alone.
//
// Available: line, ctx (layer, z, tool, feedrate, relativeE, object, meta, lineNo),
//            emit(text), emitBefore(text), drop(), state, log(message)
//            gcode.parse/num/has/set/scale/offset/remove/isMove/isExtrusion/format
//
// Example: slow every extruding move on the first two layers.

if (ctx.layer <= 1 && gcode.isExtrusion(line, ctx.relativeE)) {
	return gcode.scale(line, "F", 0.5, 0);
}
return line;
`;

export const scriptStep: StepDefinition<ScriptConfig> = {
	id: "script",
	label: "JavaScript",
	description: "Run your own JavaScript over each line. Powerful, and runs with the privileges of this page — read it before you trust it.",
	icon: "mdi-language-javascript",
	fields: [
		{
			key: "source", label: "Script", type: "textarea", required: true, default: DEFAULT_SCRIPT,
			help: "Called once per line. Return a replacement string, null to drop the line, or nothing to leave it unchanged.",
		},
		{
			key: "maxMsPerLine", label: "Time budget (ms per line)", type: "number", default: 0.5, min: 0.01, max: 100, step: 0.1,
			help: "The run aborts if the script averages more than this per line — the guard against an accidental infinite loop. Default: 0.5.",
		},
	],

	create(config, factoryCtx): Transform {
		if (!factoryCtx.scriptsTrusted) {
			throw new StepConfigError("This recipe contains a script step. Review the script and enable \"Trust scripts in this recipe\" before running it.");
		}
		const fn = compileScript(config.source);
		const budget = Number.isFinite(config.maxMsPerLine) && config.maxMsPerLine > 0 ? config.maxMsPerLine : 0.5;

		const state: Record<string, unknown> = {};
		const gcode = createGcodeApi();
		const logs: Array<string> = [];
		let before: Array<string> = [];
		let after: Array<string> = [];
		let dropped = false;

		const api: ScriptApi = {
			emit(text: string) { after.push(...String(text).split("\n")); },
			emitBefore(text: string) { before.push(...String(text).split("\n")); },
			drop() { dropped = true; },
			state,
			log(message: string) { if (logs.length < 200) logs.push(String(message)); },
			gcode,
		};

		const shadowed = SHADOWED_GLOBALS.map(() => undefined);
		// Sample the clock every CHECK_EVERY lines rather than per line — Date.now() per line on a
		// five-million-line file costs more than the check is worth
		const CHECK_EVERY = 2000;
		let lines = 0;
		let started = 0;

		return {
			id: "script",

			onStart() {
				lines = 0;
				started = Date.now();
				before = [];
				after = [];
			},

			onLine(ctx: LineContext, line: string) {
				before = [];
				after = [];
				dropped = false;

				let result: unknown;
				try {
					result = fn(line, ctx, api, ...shadowed);
				} catch (e) {
					throw new ScriptAbortError(`Script failed on line ${ctx.lineNo}: ${(e as Error).message}`);
				}

				lines++;
				if (lines % CHECK_EVERY === 0) {
					const elapsed = Date.now() - started;
					if (elapsed / lines > budget) {
						throw new ScriptAbortError(
							`Script exceeded its time budget (${(elapsed / lines).toFixed(2)} ms/line over ${lines} lines, budget ${budget} ms). Aborted before it could hang the browser.`,
						);
					}
				}

				const replaced = dropped ? null : (typeof result === "string" ? result : (result === null ? null : line));
				if (before.length === 0 && after.length === 0) {
					if (replaced === null) return null;
					return replaced === line ? undefined : replaced;
				}
				const out = [...before];
				if (replaced !== null) out.push(replaced);
				out.push(...after);
				return out.length === 0 ? null : out;
			},

			onEnd(ctx) {
				for (const message of logs) ctx.warn(`script: ${message}`);
			},
		};
	},

	validate(config) {
		try {
			compileScript(config.source);
			return [];
		} catch (e) {
			return [(e as Error).message];
		}
	},
};
