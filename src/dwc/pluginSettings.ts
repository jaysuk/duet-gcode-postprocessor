/**
 * Small per-board plugin settings — currently just the preflight gate (E13).
 *
 * Board-scoped, not browser-scoped, for the same reason recipes are (`recipeStore.ts`): a gate that
 * blocks Apply while a file has outstanding preflight errors is a policy about *this machine*, so it
 * should follow the printer. Uses the same `registerPluginData`/`setPluginData` path with a
 * `localStorage` fallback for an older DWC (or the test kit) that lacks them.
 */

import { computed, ref } from "vue";
import { useSettingsStore } from "@/stores/settings";

import { PLUGIN_ID } from "../model/constants";

const KEY = "settings";
const LS_KEY = "gCodePostProcessor.settings";

export interface PluginSettings {
	/** When true, Apply is blocked while the selected file has an error-level preflight check
	 *  outstanding. Off by default — the checks are heuristic, and a false positive that blocks a
	 *  legitimate job is worse than a warning the user reads and overrides. */
	preflightGate: boolean;
}

function defaults(): PluginSettings {
	return { preflightGate: false };
}

const fallbackRevision = ref(0);

interface SettingsLike {
	plugins?: Record<string, Record<string, unknown> | undefined>;
	registerPluginData?: (plugin: string, key: string, value: unknown) => void;
	setPluginData?: (plugin: string, key: string, value: unknown) => void;
}

function readFallback(): PluginSettings | null {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as Partial<PluginSettings>;
		return { ...defaults(), ...parsed };
	} catch {
		return null;
	}
}

function writeFallback(value: PluginSettings): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(value));
	} catch {
		// Storage disabled: the setting lives only for this session, which is acceptable for a gate
	}
	fallbackRevision.value++;
}

export function usePluginSettings() {
	const store = useSettingsStore() as unknown as SettingsLike;
	const hasPluginData = typeof store.registerPluginData === "function" && typeof store.setPluginData === "function";
	if (hasPluginData) store.registerPluginData?.(PLUGIN_ID, KEY, defaults());

	const state = computed<PluginSettings>(() => {
		if (hasPluginData) {
			const stored = store.plugins?.[PLUGIN_ID]?.[KEY] as Partial<PluginSettings> | undefined;
			return { ...defaults(), ...(stored ?? {}) };
		}
		void fallbackRevision.value;
		return readFallback() ?? defaults();
	});

	function patch(changes: Partial<PluginSettings>): void {
		const next = { ...state.value, ...changes };
		if (hasPluginData) store.setPluginData?.(PLUGIN_ID, KEY, next);
		else writeFallback(next);
	}

	const preflightGate = computed(() => state.value.preflightGate);
	function setPreflightGate(value: boolean): void {
		patch({ preflightGate: value });
	}

	return { preflightGate, setPreflightGate };
}
