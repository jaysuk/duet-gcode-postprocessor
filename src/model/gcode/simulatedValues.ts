/**
 * The offline stepper has no live machine, so an `if`/`while` condition referencing an object-model
 * path (`sensors.gpIn[0].value`, `heat.heaters[0].current`, `move.axes[0].homed`, ...) genuinely has
 * no known value - not just the hardware-dependent ones, ALL of them, since this is a static file
 * being read, not a connected board. `walkExecution` (`dwc-gcode-core`) pauses at exactly that point
 * via `UnresolvedPathError`; this module is the user-facing side of resolving it: a map of path ->
 * hypothetical value the user has supplied, and the `resolvePath` callback `executionIndex.ts` wires
 * to `walkExecution`, backed by that map.
 */

import { UnresolvedPathError, type EvalValue } from "dwc-gcode-core";

export type SimulatedValueOverrides = ReadonlyMap<string, EvalValue>;

/** Builds a `walkExecution`-compatible `resolvePath`: answers from `overrides` when the exact
 *  (already-indexed, e.g. `"sensors.gpIn[0].value"`) path has one, otherwise throws
 *  `UnresolvedPathError` so the walk pauses there and the caller can prompt for a value. */
export function createSimulatedResolvePath(overrides: SimulatedValueOverrides): (path: string) => EvalValue {
	return (path) => {
		const value = overrides.get(path);
		if (value !== undefined || overrides.has(path)) return value as EvalValue;
		throw new UnresolvedPathError(path);
	};
}

/**
 * Parses what a user typed into the "what value should the simulation use?" prompt: `true`/`false`
 * (case-insensitive) become a boolean, a valid finite number becomes a number, anything else is kept
 * as the literal string - ordinary "type what you mean" input, not a separate type selector, since
 * the vast majority of conditions this pauses on are numeric sensor readings or boolean pin states.
 */
export function parseSimulatedValueInput(text: string): EvalValue {
	const trimmed = text.trim();
	if (/^true$/i.test(trimmed)) return true;
	if (/^false$/i.test(trimmed)) return false;
	if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
	return trimmed;
}

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
