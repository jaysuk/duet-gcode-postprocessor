import { describe, expect, it } from "vitest";

import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";

import { createState } from "../model/gcode/state";
import { emptyMetadata, parseMetadata } from "../model/gcode/metadata";
import { SandboxEngine, serialiseLineState } from "../model/steps/quickjs/sandboxEngine";
import { tokenise } from "../model/gcode/tokenise";
import { ScriptAbortError, StepConfigError } from "../model/steps/types";
import type { LineContext, StepFactoryContext } from "../model/steps/types";
import type { QuickJsModuleLike } from "../model/steps/quickjs/loader";
import { __resetQuickJsLoaderForTests, __setQuickJsLoadedForTests } from "../model/steps/quickjs/loader";
import { scriptStep, type ScriptConfig } from "../model/steps/script";
import { findReplaceStep } from "../model/steps/findReplace";
import { rulesStep } from "../model/steps/rules";
import { runToString } from "../model/pipeline";

async function loadQuickJs(): Promise<QuickJsModuleLike> {
	return (await newQuickJSWASMModuleFromVariant(variant)) as unknown as QuickJsModuleLike;
}

function ctxFor(line: string, overrides: Partial<LineContext> = {}): LineContext {
	const state = createState();
	return { ...state, token: tokenise(line), meta: emptyMetadata(), totalLayers: null, progress: null, ...overrides };
}

describe("SandboxEngine — one VM call per line (task 14 replaced the earlier chunked design)", () => {
	it("transforms a line via a simple replacement", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "return line.replace('M104', 'M568');");
		try {
			expect(engine.runLine("M104 S210", serialiseLineState(ctxFor("M104 S210"))).line).toBe("M568 S210");
			expect(engine.runLine("M104 S180", serialiseLineState(ctxFor("M104 S180"))).line).toBe("M568 S180");
		} finally {
			engine.dispose();
		}
	});

	it("drops a line by returning null", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "return line.startsWith('M') ? null : line;");
		try {
			expect(engine.runLine("M104", serialiseLineState(ctxFor("M104"))).line).toBeNull();
			expect(engine.runLine("G28", serialiseLineState(ctxFor("G28"))).line).toBe("G28");
		} finally {
			engine.dispose();
		}
	});

	it("drops a line via drop(), same as returning null", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "if (line === 'M104') drop(); return line;");
		try {
			expect(engine.runLine("M104", serialiseLineState(ctxFor("M104"))).line).toBeNull();
		} finally {
			engine.dispose();
		}
	});

	it("emits extra lines before and after the current one", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, `
			if (line === 'G28') { emitBefore('; before'); emit('; after'); }
			return line;
		`);
		try {
			const outcome = engine.runLine("G28", serialiseLineState(ctxFor("G28")));
			expect(outcome.before).toEqual(["; before"]);
			expect(outcome.line).toBe("G28");
			expect(outcome.after).toEqual(["; after"]);
		} finally {
			engine.dispose();
		}
	});

	it("persists state across separate runLine calls, within one engine instance", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "state.n = (state.n || 0) + 1; return line + ' ; ' + state.n;");
		try {
			expect(engine.runLine("A", serialiseLineState(ctxFor("A"))).line).toBe("A ; 1");
			expect(engine.runLine("B", serialiseLineState(ctxFor("B"))).line).toBe("B ; 2");
			expect(engine.runLine("C", serialiseLineState(ctxFor("C"))).line).toBe("C ; 3");
		} finally {
			engine.dispose();
		}
	});

	it("collects log() messages and returns only the new ones from each call", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "log('saw ' + line); return line;");
		try {
			expect(engine.runLine("G28", serialiseLineState(ctxFor("G28"))).logs).toEqual(["saw G28"]);
			expect(engine.runLine("G1 X1", serialiseLineState(ctxFor("G1 X1"))).logs).toEqual(["saw G1 X1"]);
		} finally {
			engine.dispose();
		}
	});

	it("reports a compile error as a config error, not a crash", async () => {
		const QuickJS = await loadQuickJs();
		expect(() => new SandboxEngine(QuickJS, "this is not javascript")).toThrow(StepConfigError);
	});

	it("wraps a runtime error with the line number", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "throw new Error('boom');");
		try {
			expect(() => engine.runLine("G28", serialiseLineState(ctxFor("G28", { lineNo: 7 })))).toThrow(/line 7: boom/);
		} finally {
			engine.dispose();
		}
	});

	it("aborts a genuine infinite loop via the fixed interrupt backstop, rather than hanging", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "while (true) {}");
		try {
			expect(() => engine.runLine("G28", serialiseLineState(ctxFor("G28")))).toThrow(ScriptAbortError);
		} finally {
			engine.dispose();
		}
	}, 10000);

	it("gives the sandboxed script no network or storage globals to begin with", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "log((typeof fetch) + ',' + (typeof localStorage) + ',' + (typeof XMLHttpRequest)); return line;");
		try {
			const outcome = engine.runLine("G28", serialiseLineState(ctxFor("G28")));
			expect(outcome.logs[0]).toBe("undefined,undefined,undefined");
		} finally {
			engine.dispose();
		}
	});
});

describe("SandboxEngine.setMeta — metadata hoisted once per run, not marshalled per line", () => {
	it("exposes ctx.meta.values as an empty object before setMeta is ever called", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "log(JSON.stringify(ctx.meta)); return line;");
		try {
			const outcome = engine.runLine("G28", serialiseLineState(ctxFor("G28")));
			const meta = JSON.parse(outcome.logs[0]) as { values: unknown; totalLayers: unknown };
			expect(meta.values).toEqual({});
			expect(meta.totalLayers).toBeNull();
		} finally {
			engine.dispose();
		}
	});

	it("exposes the hoisted metadata on every subsequent line", async () => {
		const QuickJS = await loadQuickJs();
		const engine = new SandboxEngine(QuickJS, "log(ctx.meta.totalLayers + ',' + ctx.meta.values.foo); return line;");
		try {
			engine.setMeta({ ...emptyMetadata(), totalLayers: 42, values: new Map([["foo", "bar"]]) });
			expect(engine.runLine("G28", serialiseLineState(ctxFor("G28"))).logs[0]).toBe("42,bar");
			expect(engine.runLine("G1 X1", serialiseLineState(ctxFor("G1 X1"))).logs[0]).toBe("42,bar");
		} finally {
			engine.dispose();
		}
	});
});

// #region Pipeline-level regression tests for task 14's audit findings

/** `find` config helper, matching `findReplaceStep`'s field shape. */
function findReplaceConfig(find: string, replace: string) {
	return {
		find, replace, regex: false, caseSensitive: true, wholeWord: false, all: true, layerFrom: -1, layerTo: -1,
	};
}

describe("Finding A — a downstream step sees every line, with the right context", () => {
	it("applies a downstream step to every line of a 600-line file (well past the old 500-line chunk boundary)", async () => {
		const QuickJS = await loadQuickJs();
		__setQuickJsLoadedForTests(QuickJS);
		try {
			const script = scriptStep.create(
				{ source: "return line;", maxMsPerLine: 1000, engine: "sandboxed" }, { scriptsTrusted: true },
			);
			const downstream = findReplaceStep.create(findReplaceConfig("G1", "MARKED") as never, { scriptsTrusted: true });

			const lines: Array<string> = [];
			for (let i = 0; i < 600; i++) lines.push(`G1 X${i}`);
			const { output } = runToString({ transforms: [script, downstream] }, lines.join("\n"));

			expect(output.split("\n").filter((l) => l.startsWith("G1"))).toHaveLength(0);
			expect(output.split("\n").filter((l) => l.startsWith("MARKED"))).toHaveLength(600);
		} finally {
			__resetQuickJsLoaderForTests();
		}
	});

	it("applies a downstream step to every line of a file shorter than the old chunk size too", async () => {
		const QuickJS = await loadQuickJs();
		__setQuickJsLoadedForTests(QuickJS);
		try {
			const script = scriptStep.create(
				{ source: "return line;", maxMsPerLine: 1000, engine: "sandboxed" }, { scriptsTrusted: true },
			);
			const downstream = findReplaceStep.create(findReplaceConfig("G1", "MARKED") as never, { scriptsTrusted: true });
			const { output } = runToString({ transforms: [script, downstream] }, "G1 X1\nG1 X2\nG1 X3");
			expect(output).toBe("MARKED X1\nMARKED X2\nMARKED X3");
		} finally {
			__resetQuickJsLoaderForTests();
		}
	});

	it("gives a downstream layer-gated step the right layer for every line", async () => {
		const QuickJS = await loadQuickJs();
		__setQuickJsLoadedForTests(QuickJS);
		try {
			const script = scriptStep.create(
				{ source: "return line;", maxMsPerLine: 1000, engine: "sandboxed" }, { scriptsTrusted: true },
			);
			// 3 layers x 200 moves. Downstream rule fires only on layer 0.
			const downstream = rulesStep.create({
				rules: JSON.stringify([{
					when: [{ type: "command", codes: ["G1"] }, { type: "layer", from: 0, to: 0 }],
					then: [{ type: "appendComment", text: "L0" }],
				}]),
			} as never, { scriptsTrusted: true });

			const lines: Array<string> = [];
			for (let layer = 0; layer < 3; layer++) {
				lines.push(";LAYER_CHANGE");
				for (let i = 0; i < 200; i++) lines.push(`G1 X${i}`);
			}
			const { output } = runToString({ transforms: [script, downstream] }, lines.join("\n"));
			const tagged = output.split("\n").filter((l) => l.includes("L0"));
			expect(tagged).toHaveLength(200);
		} finally {
			__resetQuickJsLoaderForTests();
		}
	});

	it("reports no changes for an identity sandboxed script — the dry-run diff and stats stay accurate", async () => {
		const QuickJS = await loadQuickJs();
		__setQuickJsLoadedForTests(QuickJS);
		try {
			const script = scriptStep.create(
				{ source: "return line;", maxMsPerLine: 1000, engine: "sandboxed" }, { scriptsTrusted: true },
			);
			const { pipeline } = runToString({ transforms: [script] }, "G1 X1\nG1 X2\nG1 X3");
			expect(pipeline.stats.linesRemoved).toBe(0);
			expect(pipeline.stats.linesAdded).toBe(0);
			expect(pipeline.stats.linesChanged).toBe(0);
			expect(pipeline.diff).toHaveLength(0);
		} finally {
			__resetQuickJsLoaderForTests();
		}
	});
});

describe("Finding B — real slicer metadata does not blow up the sandboxed engine", () => {
	function metadataFixture(keyCount: number): ReturnType<typeof parseMetadata> {
		const settings: Array<string> = [];
		for (let i = 0; i < keyCount; i++) settings.push(`; setting_key_number_${i} = value_${i}`);
		return parseMetadata(["G1 X1", ...settings].join("\n"));
	}

	it("runs an identity script over a 2000-line file with 300 metadata keys, on default settings", async () => {
		const QuickJS = await loadQuickJs();
		__setQuickJsLoadedForTests(QuickJS);
		try {
			const meta = metadataFixture(300);
			const body: Array<string> = [];
			for (let i = 0; i < 2000; i++) body.push(`G1 X${i} Y${i} E${(i * 0.01).toFixed(4)} F1800`);

			// The actual default field value (script.ts's own `fields` entry), not a hand-tuned one.
			const script = scriptStep.create(
				{ source: "return line;", maxMsPerLine: 0.5, engine: "sandboxed" }, { scriptsTrusted: true },
			);
			const { pipeline } = runToString({ transforms: [script], meta }, body.join("\n"));
			expect(pipeline.stats.linesRemoved).toBe(0);
			expect(pipeline.diff).toHaveLength(0);
		} finally {
			__resetQuickJsLoaderForTests();
		}
	});

	/**
	 * Pins the per-line cost of the sandboxed engine on a fixture that carries real slicer metadata —
	 * the specific regression this guards is re-serialising that metadata block on every line, which
	 * cost ~1000µs/line (20s for 20,000 lines) before the fix against ~40µs/line after it.
	 *
	 * **Deliberately asserts an absolute per-line cost, not a ratio against the fast engine.** The
	 * ratio is not a stable quantity to gate on: measured over six back-to-back repeats it drifted
	 * from 17× to 35×, entirely because the *fast* engine's own run JIT-warms from ~17ms to ~5ms while
	 * the sandboxed one holds steady at ~190ms. A ratio bound loose enough never to be flaky would be
	 * too loose to catch anything; the absolute figure is both stable and the thing actually at risk.
	 */
	it("keeps the sandboxed per-line cost near its measured floor on a metadata-heavy fixture", async () => {
		const QuickJS = await loadQuickJs();
		__setQuickJsLoadedForTests(QuickJS);
		try {
			const meta = metadataFixture(300);
			const LINES = 5000;
			const body: Array<string> = [];
			for (let i = 0; i < LINES; i++) body.push(`G1 X${i} Y${i} E${(i * 0.01).toFixed(4)} F1800`);
			const input = body.join("\n");

			const sandboxed = scriptStep.create(
				{ source: "return line;", maxMsPerLine: 100000, engine: "sandboxed" }, { scriptsTrusted: true },
			);
			const started = performance.now();
			runToString({ transforms: [sandboxed], meta }, input);
			const usPerLine = ((performance.now() - started) * 1000) / LINES;

			// ~40µs/line measured on the development machine; 250 leaves roughly 6x headroom for a
			// slower or loaded CI box while still failing decisively on the ~1000µs/line regression.
			expect(usPerLine).toBeLessThan(250);
		} finally {
			__resetQuickJsLoaderForTests();
		}
	}, 30000);
});

describe("Finding C — the QuickJS runtime is disposed even when a run does not finish normally", () => {
	it("disposes the sandboxed transform when a downstream transform throws mid-run", async () => {
		const QuickJS = await loadQuickJs();
		__setQuickJsLoadedForTests(QuickJS);
		try {
			const script = scriptStep.create(
				{ source: "return line;", maxMsPerLine: 1000, engine: "sandboxed" }, { scriptsTrusted: true },
			);
			let disposed = false;
			const originalDispose = script.dispose?.bind(script);
			script.dispose = () => {
				disposed = true;
				originalDispose?.();
			};

			const exploding = {
				id: "boom",
				onLine(_ctx: LineContext, line: string): string | undefined {
					if (line.includes("X50")) throw new Error("simulated mid-run failure");
					return undefined;
				},
			};

			const lines: Array<string> = [];
			for (let i = 0; i < 100; i++) lines.push(`G1 X${i}`);
			expect(() => runToString({ transforms: [script, exploding] }, lines.join("\n")))
				.toThrow(/simulated mid-run failure/);
			expect(disposed).toBe(true);
		} finally {
			__resetQuickJsLoaderForTests();
		}
	});

	it("disposes cleanly on the normal completion path too (no double-dispose error)", async () => {
		const QuickJS = await loadQuickJs();
		__setQuickJsLoadedForTests(QuickJS);
		try {
			const script = scriptStep.create(
				{ source: "return line;", maxMsPerLine: 1000, engine: "sandboxed" }, { scriptsTrusted: true },
			);
			expect(() => runToString({ transforms: [script] }, "G1 X1\nG1 X2")).not.toThrow();
		} finally {
			__resetQuickJsLoaderForTests();
		}
	});
});

// #endregion

describe("cross-engine parity — fast and sandboxed produce identical output and statistics", () => {
	const CASES: Array<{ name: string; source: string; lines: Array<string> }> = [
		{ name: "identity", source: "return line;", lines: ["G1 X1", "G1 X2", "G28"] },
		{ name: "replacement", source: "return line.replace('M104', 'M568');", lines: ["M104 S210", "M104 S180", "G28"] },
		{ name: "drop via null", source: "return line.startsWith('M') ? null : line;", lines: ["M104", "G28", "M105"] },
		{ name: "drop via drop()", source: "if (line === 'M104') drop(); return line;", lines: ["M104", "G28", "M105"] },
		{
			name: "emit and emitBefore",
			source: "if (line === 'G28') { emitBefore('; before'); emit('; after'); } return line;",
			lines: ["G28", "G1 X1"],
		},
		{
			name: "state persisted across lines",
			source: "state.n = (state.n || 0) + 1; return line + ' ; ' + state.n;",
			lines: ["A", "B", "C"],
		},
		{
			name: "gcode.* helpers",
			source: "return gcode.isExtrusion(line) ? gcode.scale(line, 'F', 0.5, 0) : line;",
			lines: ["G1 X10 E1 F1200", "G1 X20 F9000", "G28"],
		},
	];

	for (const { name, source, lines } of CASES) {
		it(name, async () => {
			const QuickJS = await loadQuickJs();
			__setQuickJsLoadedForTests(QuickJS);
			try {
				const input = lines.join("\n");
				const base: Omit<ScriptConfig, "engine"> = { source, maxMsPerLine: 1000 };
				const factoryCtx: StepFactoryContext = { scriptsTrusted: true };

				const fastTransform = scriptStep.create({ ...base, engine: "fast" }, factoryCtx);
				const fastResult = runToString({ transforms: [fastTransform] }, input);

				const sandboxedTransform = scriptStep.create({ ...base, engine: "sandboxed" }, factoryCtx);
				const sandboxedResult = runToString({ transforms: [sandboxedTransform] }, input);

				expect(sandboxedResult.output).toBe(fastResult.output);
				expect(sandboxedResult.pipeline.stats.linesChanged).toBe(fastResult.pipeline.stats.linesChanged);
				expect(sandboxedResult.pipeline.stats.linesAdded).toBe(fastResult.pipeline.stats.linesAdded);
				expect(sandboxedResult.pipeline.stats.linesRemoved).toBe(fastResult.pipeline.stats.linesRemoved);
				expect(sandboxedResult.pipeline.diff).toHaveLength(fastResult.pipeline.diff.length);
			} finally {
				__resetQuickJsLoaderForTests();
			}
		});
	}
});

describe("Finding E — a sandboxed script is syntax-checked at validate() time, same as the fast engine", () => {
	it("rejects a syntactically invalid sandboxed script", () => {
		const errors = scriptStep.validate?.({
			source: "this is not javascript", maxMsPerLine: 0.5, engine: "sandboxed",
		} as ScriptConfig);
		expect(errors).toBeDefined();
		expect(errors!.length).toBeGreaterThan(0);
	});

	it("accepts a syntactically valid sandboxed script", () => {
		const errors = scriptStep.validate?.({
			source: "return line;", maxMsPerLine: 0.5, engine: "sandboxed",
		} as ScriptConfig);
		expect(errors).toEqual([]);
	});
});
