import { describe, expect, it, vi } from "vitest";

// This harness's happy-dom `localStorage` is a non-functional stub (`localStorage.setItem` is not a
// function — same environment gap `autoRun.test.ts` documents and works around for `recipeStore`). A
// tiny in-memory stand-in is the only way to exercise the persistence tests below; real DWC runs in an
// actual browser, where the real localStorage works.
const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => memoryStorage.get(key) ?? null,
	setItem: (key: string, value: string) => { memoryStorage.set(key, value); },
	removeItem: (key: string) => { memoryStorage.delete(key); },
});

import {
	loadMessageBoxAnswers, saveMessageBoxAnswers, type MessageBoxAnswerOverrides,
} from "../model/gcode/messageBoxAnswers";

// The pure resolver logic this module re-exports (createMessageBoxResolver, messageBoxKey) is tested
// at its real source, dwc-gcode-core/test/executionIndex.test.ts - only this module's own addition,
// localStorage persistence, is tested here.
describe("message-box answer persistence", () => {
	it("round-trips through localStorage, keyed by file path", () => {
		const path = "0:/gcodes/mbox-persistence-1.gcode";
		const overrides: MessageBoxAnswerOverrides = new Map([["k1", { input: 5, cancelled: false }]]);
		saveMessageBoxAnswers(path, overrides);
		expect(loadMessageBoxAnswers(path)).toEqual(overrides);
	});

	it("loading a path with nothing saved returns an empty map", () => {
		expect(loadMessageBoxAnswers("0:/gcodes/mbox-never-saved.gcode").size).toBe(0);
	});

	it("saving an empty map clears any previously-saved entry", () => {
		const path = "0:/gcodes/mbox-persistence-clear.gcode";
		saveMessageBoxAnswers(path, new Map([["k", { input: null, cancelled: false }]]));
		expect(loadMessageBoxAnswers(path).size).toBe(1);
		saveMessageBoxAnswers(path, new Map());
		expect(loadMessageBoxAnswers(path).size).toBe(0);
	});
});
