/**
 * Recipe persistence.
 *
 * Recipes live in DWC's plugin settings, which follow the board rather than the browser — open DWC
 * from a phone and the same recipes are there. Import/export is the escape hatch for moving them
 * between machines.
 *
 * `registerPluginData`/`setPluginData` are recent settings-store additions, so their absence is
 * handled rather than assumed: without them the recipes fall back to `localStorage`, which keeps
 * the plugin fully usable (just per-browser rather than per-board) on an older DWC. The test kit's
 * settings stub is one such environment, which is how the fallback stays exercised.
 *
 * `scriptsTrusted` is deliberately stripped on the way in and out: trust is a decision a person
 * makes about code they have read, in this browser, now. Persisting it would let a recipe synced
 * from another machine run its own JavaScript unprompted.
 */

import { computed, ref, type Ref } from "vue";
import { useSettingsStore } from "@/stores/settings";

import { PLUGIN_ID } from "../model/constants";
import { createRecipe, newUid, type Recipe } from "../model/recipe";

const KEY = "recipes";
const LS_KEY = "gCodePostProcessor.recipes";

interface StoredState {
	recipes: Array<Recipe>;
	activeId: string | null;
}

function defaults(): StoredState {
	// A first run starts with nothing built — the presets are one click away from an empty list
	// (RecipeEditor's "add" flow), not something silently pre-applied to a file the user hasn't
	// chosen yet.
	return { recipes: [], activeId: null };
}

/** Per-session trust decisions, keyed by recipe id. Never persisted. */
const trusted = ref<Set<string>>(new Set());

/** Bumped on every local-storage write so the computed state re-reads it. */
const fallbackRevision = ref(0);

interface SettingsLike {
	plugins?: Record<string, Record<string, unknown> | undefined>;
	registerPluginData?: (plugin: string, key: string, value: unknown) => void;
	setPluginData?: (plugin: string, key: string, value: unknown) => void;
}

function sanitise(recipes: Array<Recipe>): Array<Recipe> {
	return recipes.map((r) => ({ ...r, scriptsTrusted: false }));
}

function readFallback(): StoredState | null {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as StoredState;
		return Array.isArray(parsed?.recipes) ? parsed : null;
	} catch {
		return null;
	}
}

function writeFallback(state: StoredState): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(state));
	} catch {
		// Storage disabled: recipes then live only for this session, which is still better than
		// refusing to let the user build one
	}
	fallbackRevision.value++;
}

export function useRecipes() {
	const settingsStore = useSettingsStore() as unknown as SettingsLike;
	const hasPluginData = typeof settingsStore.registerPluginData === "function"
		&& typeof settingsStore.setPluginData === "function";

	if (hasPluginData) {
		settingsStore.registerPluginData?.(PLUGIN_ID, KEY, defaults());
	}

	const state = computed<StoredState>(() => {
		if (hasPluginData) {
			const stored = settingsStore.plugins?.[PLUGIN_ID]?.[KEY] as StoredState | undefined;
			if (stored !== undefined && Array.isArray(stored.recipes)) return stored;
			return defaults();
		}
		// Touch the revision so a write invalidates this computed
		void fallbackRevision.value;
		return readFallback() ?? defaults();
	});

	function persist(next: StoredState): void {
		const clean: StoredState = { recipes: sanitise(next.recipes), activeId: next.activeId };
		if (hasPluginData) settingsStore.setPluginData?.(PLUGIN_ID, KEY, clean);
		else writeFallback(clean);
	}

	const recipes = computed(() => state.value.recipes);
	const activeId = computed(() => state.value.activeId);
	const active = computed<Recipe | null>(
		() => state.value.recipes.find((r) => r.id === state.value.activeId)
			?? state.value.recipes[0]
			?? null,
	);

	function save(recipe: Recipe): void {
		const list = state.value.recipes.slice();
		const index = list.findIndex((r) => r.id === recipe.id);
		if (index === -1) list.push(recipe);
		else list[index] = recipe;
		persist({ recipes: list, activeId: recipe.id });
	}

	function add(recipe: Recipe = createRecipe("New recipe")): Recipe {
		save(recipe);
		return recipe;
	}

	function remove(id: string): void {
		const list = state.value.recipes.filter((r) => r.id !== id);
		persist({ recipes: list, activeId: list[0]?.id ?? null });
	}

	function select(id: string): void {
		persist({ recipes: state.value.recipes, activeId: id });
	}

	function duplicate(id: string): Recipe | null {
		const source = state.value.recipes.find((r) => r.id === id);
		if (source === undefined) return null;
		const copy: Recipe = {
			...JSON.parse(JSON.stringify({ ...source, scriptsTrusted: false })) as Recipe,
			id: newUid(),
			name: `${source.name} (copy)`,
		};
		save(copy);
		return copy;
	}

	return { recipes, active, activeId, save, add, remove, select, duplicate, persistsToBoard: hasPluginData };
}

/** Whether the user has approved running this recipe's scripts in this session. */
export function scriptsTrusted(recipeId: string | null): boolean {
	return recipeId !== null && trusted.value.has(recipeId);
}

export function setScriptsTrusted(recipeId: string, value: boolean): void {
	const next = new Set(trusted.value);
	if (value) next.add(recipeId);
	else next.delete(recipeId);
	trusted.value = next;
}

/** Reactive handle so a component can watch the trust state. */
export function trustedRecipes(): Ref<Set<string>> {
	return trusted;
}
