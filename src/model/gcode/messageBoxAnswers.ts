/**
 * The persistence half of simulating a blocking `M291` message box — the pure resolver logic
 * (`messageBoxKey`, `createMessageBoxResolver`, the `MessageBoxAnswerOverrides` type) now lives in
 * `dwc-gcode-core/stepper/messageBoxAnswers` (shared with `Flexible-Layouts`) and is re-exported
 * here unchanged; this module keeps only what's inherently host-specific: `localStorage`-backed
 * persistence, which `dwc-gcode-core` can't depend on (zero runtime dependencies, no browser APIs).
 */

import type { MessageBoxAnswer } from "dwc-gcode-core";
import { createMessageBoxResolver, messageBoxKey, type MessageBoxAnswerOverrides } from "dwc-gcode-core/stepper/messageBoxAnswers";

export { createMessageBoxResolver, messageBoxKey, type MessageBoxAnswerOverrides };

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
