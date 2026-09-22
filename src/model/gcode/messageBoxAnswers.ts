/**
 * The user-facing side of simulating a blocking `M291` message box — `walkExecution`
 * (`dwc-gcode-core`) pauses at one via `UnresolvedMessageBoxError`; this module is the map of
 * "what would I click/type/choose here" answers the user has supplied, and the `resolveMessageBox`
 * callback `executionIndex.ts` wires to `walkExecution`, backed by that map.
 *
 * Keyed by the prompt's own CONTENT (`messageBoxKey`), not by line number — `walkExecution`'s
 * `resolveMessageBox` only receives the parsed prompt, not which line triggered it, and content-based
 * identity is the same philosophy `simulatedValues.ts`'s object-model-path overrides already use (two
 * occurrences that ask the exact same question share one remembered answer).
 */

import { UnresolvedMessageBoxError, type MessageBoxAnswer, type MessageBoxPrompt } from "dwc-gcode-core";

export type MessageBoxAnswerOverrides = ReadonlyMap<string, MessageBoxAnswer>;

/** A stable content key for a prompt — two prompts that ask the exact same question (same mode,
 *  message, title and limits) get the same key, so an earlier answer to one is reused for the other. */
export function messageBoxKey(prompt: MessageBoxPrompt): string {
	return JSON.stringify(prompt);
}

/** Builds a `walkExecution`-compatible `resolveMessageBox`: answers from `overrides` when this exact
 *  prompt has a remembered answer, otherwise throws `UnresolvedMessageBoxError` so the walk pauses
 *  there and the caller can prompt for one. */
export function createMessageBoxResolver(overrides: MessageBoxAnswerOverrides): (prompt: MessageBoxPrompt) => MessageBoxAnswer {
	return (prompt) => {
		const answer = overrides.get(messageBoxKey(prompt));
		if (answer === undefined) throw new UnresolvedMessageBoxError();
		return answer;
	};
}

// ── persistence ──────────────────────────────────────────────────────────────────────────────────
//
// Same lightweight per-file, localStorage-backed convention as simulatedValues.ts's own overrides -
// see that module's doc comment for why (not DWC plugin-settings data, keyed by file path).

const LS_KEY_PREFIX = "gCodePostProcessor.stepperMessageBoxAnswers.";

function storageKeyFor(filePath: string): string {
	return LS_KEY_PREFIX + filePath;
}

/** Loads any message-box answers previously saved for `filePath`. Never throws - a disabled/corrupt
 *  store just means "nothing saved yet". */
export function loadMessageBoxAnswers(filePath: string): MessageBoxAnswerOverrides {
	try {
		const raw = localStorage.getItem(storageKeyFor(filePath));
		if (raw === null) return new Map();
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? new Map(parsed as Array<[string, MessageBoxAnswer]>) : new Map();
	} catch {
		return new Map();
	}
}

/** Saves `overrides` for `filePath`, or clears the entry once it's empty again rather than leaving a
 *  stale empty array behind. Never throws - storage can be disabled. */
export function saveMessageBoxAnswers(filePath: string, overrides: MessageBoxAnswerOverrides): void {
	try {
		if (overrides.size === 0) {
			localStorage.removeItem(storageKeyFor(filePath));
			return;
		}
		localStorage.setItem(storageKeyFor(filePath), JSON.stringify([...overrides.entries()]));
	} catch {
		// Storage disabled - nothing to do, the in-memory overrides remain usable for this session.
	}
}
