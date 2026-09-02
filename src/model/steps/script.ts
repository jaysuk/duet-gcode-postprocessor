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

import { getLoadedQuickJs } from "./quickjs/loader";
import { SandboxEngine, serialiseLineState } from "./quickjs/sandboxEngine";
import { createGcodeApi, type GcodeApi } from "./scriptApi";
import { ScriptAbortError, StepConfigError, type LineContext, type StepDefinition, type Transform } from "./types";

// Re-exported for existing importers (`ScriptAbortError` used to be declared in this module,
// before task 14 moved it to types.ts so quickjs/sandboxEngine.ts could throw it too without a
// circular import).
export { ScriptAbortError };

export interface ScriptConfig {
	source: string;
	/** Time budget in ms, checked as a running average by both engines, sampled every `CHECK_EVERY`
	 *  lines rather than every single one (checking on literally the first line would leave zero
	 *  averaging to smooth out one slow line — a real concern for the sandboxed engine's own
	 *  construction/warm-up cost, not just a micro-optimisation). The sandboxed engine additionally
	 *  enforces a fixed, non-configurable hard backstop per *individual* line
	 *  (`quickjs/sandboxEngine.ts`'s `INTERRUPT_BACKSTOP_MS`) via QuickJS's own interrupt hook — the
	 *  one thing this averaged check cannot do, since a single pathological line can hang it for up to
	 *  `CHECK_EVERY` lines before the next sample. */
	maxMsPerLine: number;
	/** "fast" (default): `new Function` with network/storage globals shadowed — a guardrail, see the
	 *  module comment. "sandboxed": a real QuickJS VM with no network/DOM globals to begin with, and a
	 *  genuine per-line interrupt backstop underneath the same averaged time budget — at the cost of a
	 *  one-time asset download the first time a recipe using it runs. Every existing saved recipe has
	 *  no `engine` key and defaults here to "fast", so nothing already saved changes behaviour. */
	engine: "fast" | "sandboxed";
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

/** Sample the clock every CHECK_EVERY lines rather than per line — `performance.now()` per line on a
 *  five-million-line file costs more than the check is worth. Shared by both engines: checking on
 *  literally the first line would leave zero averaging to smooth out a slow first call (already-
 *  measurable VM warm-up for the sandboxed engine, JIT warm-up for the fast one), which is exactly
 *  the false-positive the fast engine's own sampling already avoided — reusing its cadence for the
 *  sandboxed engine avoids reintroducing that problem rather than trading it for a different one. */
const CHECK_EVERY = 2000;

/**
 * Shared by both engines so there is exactly one implementation of "abort if the running average
 * time-per-line exceeds the budget", not two copies that could quietly drift apart. `started` and the
 * comparison both use `performance.now()`, not `Date.now()`: at `CHECK_EVERY`'s cadence resolution
 * barely matters, but this is also the only budget check the sandboxed engine has that isn't the
 * fixed interrupt backstop, and a real per-line VM cost of a few microseconds is well inside
 * `Date.now()`'s 1ms rounding — rounding a single call up to "1ms" is enough to make a tight budget
 * look tripped when it was not.
 */
function checkAveragedBudget(lines: number, started: number, budget: number): void {
	if (lines % CHECK_EVERY !== 0) return;
	const elapsed = performance.now() - started;
	if (elapsed / lines > budget) {
		throw new ScriptAbortError(
			`Script exceeded its time budget (${(elapsed / lines).toFixed(2)} ms/line over ${lines} lines, budget ${budget} ms). Aborted before it could hang the browser.`,
		);
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

/**
 * The sandboxed engine's `Transform` — one VM call per line, the same shape as the fast engine below
 * (same return-value combining logic, same averaged watchdog), so it is a drop-in for it rather than
 * a structurally different step. `getLoadedQuickJs()` throws if the module was somehow never awaited
 * before this ran (see `quickjs/loader.ts`'s module comment) — a caller bug, not something a user can
 * trigger through normal use, since `processFile` always awaits the loader first.
 */
function createSandboxedTransform(config: ScriptConfig): Transform {
	const module = getLoadedQuickJs();
	const budget = Number.isFinite(config.maxMsPerLine) && config.maxMsPerLine > 0 ? config.maxMsPerLine : 0.5;
	const engine = new SandboxEngine(module, config.source);

	const pendingLogs: Array<string> = [];
	let lines = 0;
	let started = 0;

	return {
		id: "script",

		onStart(ctx) {
			// Hoisted once per run, not marshalled per line — see sandboxEngine.ts's module comment
			// for why that distinction is the whole fix for this engine's original performance defect.
			// Done before starting the clock so this one-time cost is never attributed to the
			// per-line budget.
			engine.setMeta(ctx.meta);
			lines = 0;
			started = performance.now();
		},

		onLine(ctx: LineContext, line: string) {
			const outcome = engine.runLine(line, serialiseLineState(ctx));

			lines++;
			checkAveragedBudget(lines, started, budget);

			for (const message of outcome.logs) {
				if (pendingLogs.length < 200) pendingLogs.push(message);
			}

			if (outcome.before.length === 0 && outcome.after.length === 0) {
				if (outcome.line === null) return null;
				return outcome.line === line ? undefined : outcome.line;
			}
			const out = [...outcome.before];
			if (outcome.line !== null) out.push(outcome.line);
			out.push(...outcome.after);
			return out.length === 0 ? null : out;
		},

		onEnd(ctx) {
			for (const message of pendingLogs) ctx.warn(`script: ${message}`);
		},

		dispose() {
			engine.dispose();
		},
	};
}

export const scriptStep: StepDefinition<ScriptConfig> = {
	id: "script",
	label: "JavaScript",
	description: "Run your own JavaScript over each line. Powerful, and runs with the privileges of this page — read it before you trust it.",
	tip: "The escape hatch for what the \"Rules\" step cannot express — reach for Rules first, since "
		+ "most \"scripts\" people want turn out to be a when/then list. Two engines, a real tradeoff "
		+ "either way: \"Fast\" compiles with new Function and only shadows network/storage globals "
		+ "(fetch, localStorage, Worker, and others) to undefined, so using them is a TypeError rather "
		+ "than a request — a guardrail against accidents, not a real sandbox, since a determined "
		+ "script can still reach the true global object. \"Sandboxed\" runs inside a real QuickJS VM "
		+ "that never has those globals at all — nothing to shadow, nothing to escape to — at the cost "
		+ "of a one-time download the first time a recipe using it runs, and around 15-20x the per-line "
		+ "cost — the real price of a genuine boundary rather than a shadowed one, and the reason Fast "
		+ "is still the default. Both engines "
		+ "require this recipe's scripts to be explicitly trusted (having read them) before any run, "
		+ "and both abort the whole run if the script starts taking too long — a running average for "
		+ "both, plus a hard per-line wall-clock backstop underneath it for \"Sandboxed\", which the "
		+ "\"Fast\" engine's averaging genuinely cannot offer — so a genuine infinite loop stops the "
		+ "run rather than hanging the browser tab. A thrown error inside your script aborts the whole "
		+ "run either way — wrap risky code in try/catch if a line failing should not stop the file.",
	docsAnchor: "javascript",
	icon: "mdi-language-javascript",
	fields: [
		{
			key: "engine", label: "Engine", type: "select", default: "fast",
			options: [
				{ value: "fast", label: "Fast (guardrail only)" },
				{ value: "sandboxed", label: "Sandboxed (real isolation, one-time download)" },
			],
			help: "\"Fast\" is the original engine: quick, no download, but only a guardrail against "
				+ "accidents (see the tip above). \"Sandboxed\" runs your script inside a real QuickJS "
				+ "VM with no network or DOM globals to begin with — genuine isolation, not just "
				+ "shadowing — at the cost of a roughly 1 MB one-time download the first time a recipe "
				+ "using it runs in this browser tab. Default: Fast.",
		},
		{
			key: "source", label: "Script", type: "textarea", required: true, default: DEFAULT_SCRIPT,
			help: "Called once per line with (line, ctx, api). Return a replacement string, null to "
				+ "drop the line, or nothing (or the same line) to leave it unchanged. ctx carries "
				+ "layer, z, tool, feedrate, relativeE, object, meta, lineNo. The api gives you "
				+ "emit(text)/emitBefore(text) to insert lines after/before this one, drop() as an "
				+ "alternative to returning null, state (a plain object that persists for the whole "
				+ "run, for anything that needs to remember something across lines), log(message) to "
				+ "add a line to the run report, and gcode (parse/num/has/set/scale/offset/remove/"
				+ "isMove/isExtrusion/format) — the same tokeniser every other step in this plugin "
				+ "uses, rather than hand-rolled string splitting. The same API on both engines, with "
				+ "two differences in the Sandboxed one: ctx.meta.values is a plain object rather than "
				+ "a Map, and ctx.token/sawLayerMarker/geometricFallback are not carried across the VM "
				+ "boundary at all.",
		},
		{
			key: "maxMsPerLine", label: "Time budget (ms per line)", type: "number", default: 0.5, min: 0.01, max: 100, step: 0.1,
			help: "The run aborts if the script averages more than this per line, checked periodically "
				+ "rather than after every single line (checking has its own cost, on both engines). "
				+ "The Sandboxed engine also enforces a fixed, non-configurable per-line hard limit "
				+ "underneath this average, for the one thing an average genuinely cannot catch: a "
				+ "single pathological line. Raise it only if a script doing genuinely heavy per-line "
				+ "work keeps tripping the watchdog on a large file that is otherwise working correctly. "
				+ "Default: 0.5.",
		},
	],

	create(config, factoryCtx): Transform {
		if (!factoryCtx.scriptsTrusted) {
			throw new StepConfigError("This recipe contains a script step. Review the script and enable \"Trust scripts in this recipe\" before running it.");
		}
		if (config.engine === "sandboxed") {
			return createSandboxedTransform(config);
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
		let lines = 0;
		let started = 0;

		return {
			id: "script",

			onStart() {
				lines = 0;
				started = performance.now();
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
				checkAveragedBudget(lines, started, budget);

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
		// The sandboxed engine's own QuickJS module cannot be compile-checked here — it loads
		// asynchronously (see quickjs/loader.ts's module comment) and validate() has no way to await
		// that. But both engines run the same JavaScript grammar, so compiling with `new Function` is
		// a real (if partial) syntax gate for a sandboxed script too — it catches "this is not
		// javascript" at save time instead of at the first run, matching the fast engine's own
		// feedback for the same mistake. It is a syntax check only: it says nothing about whether the
		// script will actually run inside the VM (no host globals to fail on there, for one).
		try {
			compileScript(config.source);
			return [];
		} catch (e) {
			return [(e as Error).message];
		}
	},
};
