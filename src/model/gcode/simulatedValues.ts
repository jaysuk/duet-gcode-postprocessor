/**
 * The persistence half of an offline stepper's simulated object-model values — the pure resolver
 * logic (`createSimulatedResolvePath`, `parseSimulatedValueInput`, the `SimulatedValueOverrides`
 * type) now lives in `dwc-gcode-core/stepper/simulatedValues` (shared with `Flexible-Layouts`) and
 * is re-exported here unchanged; this module keeps only what's inherently host-specific:
 * `localStorage`-backed persistence, which `dwc-gcode-core` can't depend on (zero runtime
 * dependencies, no browser APIs).
 */

import type { EvalValue } from "dwc-gcode-core";
import {
	createSimulatedResolvePath, parseSimulatedValueInput, type SimulatedValueOverrides,
} from "dwc-gcode-core/stepper/simulatedValues";

export { createSimulatedResolvePath, parseSimulatedValueInput, type SimulatedValueOverrides };

// ── persistence ──────────────────────────────────────────────────────────────────────────────────
//
// Lightweight per-file UI state (which hypothetical values a user picked while stepping through THIS
// file), not data worth syncing across devices via DWC's plugin settings store the way recipes are
// (recipeStore.ts) - plain localStorage, namespaced under the plugin's camelCase ID, matching the
// scaffolding guide's own convention for exactly this kind of selection. Keyed by file path, since a
// simulated value is meaningful only in the context of the specific file/macro it was answered for.

const LS_KEY_PREFIX = "gCodePostProcessor.stepperSimulatedValues.";

function storageKeyFor(filePath: string): string {
	return LS_KEY_PREFIX + filePath;
}

/** Loads any simulated values previously saved for `filePath`. Never throws - a disabled/corrupt
 *  store just means "nothing saved yet", same fallback `recipeStore.ts` uses for its own storage. */
export function loadSimulatedOverrides(filePath: string): SimulatedValueOverrides {
	try {
		const raw = localStorage.getItem(storageKeyFor(filePath));
		if (raw === null) return new Map();
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? new Map(parsed as Array<[string, EvalValue]>) : new Map();
	} catch {
		return new Map();
	}
}

/** Saves `overrides` for `filePath`, or clears the entry once it's empty again (`resetSimulatedValues`)
 *  rather than leaving a stale empty array behind. Never throws - storage can be disabled; the
 *  overrides then simply live only for this session, same as everywhere else in this plugin that
 *  falls back this way. */
export function saveSimulatedOverrides(filePath: string, overrides: SimulatedValueOverrides): void {
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
