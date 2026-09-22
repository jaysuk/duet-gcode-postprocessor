/**
 * The shared, site-wide G-code editor color scheme: one reactive ref every open `GcodeEditor.vue`
 * instance reads and watches, backed by a single file on the SD card
 * (`dwc-gcode-editor`'s `GCODE_EDITOR_COLORS_SD_PATH`) rather than this plugin's own
 * `registerPluginData`-based settings (`pluginSettings.ts`) — see that package's own
 * `colorSchemeStorage.ts` doc comment for why: genuinely site-wide (this same file is also read/written
 * by `Flexible-Layouts`) and guaranteed to reach the SD card regardless of the user's own
 * `settingsStorageLocal` toggle, neither of which `registerPluginData` gives.
 *
 * `editorColorScheme` is `null` until the user has genuinely customised something — either a real,
 * valid file already exists on the SD card, or they've explicitly saved one this session. `null` means
 * "no customisation exists", and `ThemeController.setCustomColors(view, null)` already means exactly
 * that: revert to the fixed light/dark palette. Deliberately NOT defaulted to
 * `DEFAULT_COLOR_SCHEME_FILE` — that would change every existing user's editor colors the moment this
 * shipped, even for someone who never opens the settings dialog; `DEFAULT_COLOR_SCHEME_FILE` is only
 * ever shown as a starting point to EDIT (`EditorColorSettingsDialog.vue`'s own draft), never applied
 * on its own.
 *
 * Load-once-per-session, shared-ref pattern (mirrors `Flexible-Layouts`' own `sdBackup.ts` for the
 * read/write shape, and this plugin's own `lineStateGutter(() => lineIndex)` for the "one shared piece
 * of external state every editor instance reads live" idea): every `GcodeEditor.vue` calls
 * `loadEditorColorScheme()` on mount (a no-op after the first real call), and `watch`es the exported
 * `editorColorScheme` ref to push a live `themeController.setCustomColors(...)` update — so saving from
 * ANY open tab's settings dialog applies to every other open tab immediately, not just the one that
 * opened it.
 */

import { ref } from "vue";
import { useMachineStore } from "@/stores/machine";
import {
	GCODE_EDITOR_COLORS_SD_PATH, parseColorSchemeFile, serializeColorSchemeFile, type GcodeColorSchemeFile,
} from "dwc-gcode-editor";

export const editorColorScheme = ref<GcodeColorSchemeFile | null>(null);

let loaded = false;
let loadPromise: Promise<void> | null = null;

async function blobToText(v: unknown): Promise<string> {
	if (typeof v === "string") return v;
	if (v instanceof Blob) return v.text();
	return String(v);
}

/** Loads the shared scheme from the SD card once per plugin session; every call after the first
 *  (from every other open editor instance) awaits the same in-flight or already-resolved load
 *  instead of re-downloading. Best-effort and silent on failure (offline, no file yet, a corrupt
 *  file) — the ref just stays `null`, matching `parseColorSchemeFile`'s own "fall back rather than
 *  propagate a parse error" choice. */
export function loadEditorColorScheme(): Promise<void> {
	if (loaded) return Promise.resolve();
	if (loadPromise !== null) return loadPromise;
	loadPromise = (async () => {
		try {
			const machineStore = useMachineStore();
			if (!machineStore.isConnected) return;
			const res = await machineStore.download({ filename: GCODE_EDITOR_COLORS_SD_PATH, type: "text" }, false, false, false);
			const text = await blobToText(res);
			const parsed = parseColorSchemeFile(text);
			if (parsed !== null) editorColorScheme.value = parsed;
		} catch {
			// No file yet, offline, or unreadable - stays null (the fixed theme applies).
		} finally {
			loaded = true;
		}
	})();
	return loadPromise;
}

/** Persists a new scheme to the SD card, then updates the shared ref so every open editor instance's
 *  own `watch` picks it up live. Throws on a real upload failure (offline, disk full, ...) - the
 *  caller (the settings dialog) is responsible for surfacing that to the user. */
export async function saveEditorColorScheme(scheme: GcodeColorSchemeFile): Promise<void> {
	const machineStore = useMachineStore();
	const text = serializeColorSchemeFile(scheme);
	await machineStore.upload(
		{ filename: GCODE_EDITOR_COLORS_SD_PATH, content: new Blob([text], { type: "application/json" }) },
		false, false, false,
	);
	editorColorScheme.value = scheme;
}

/** Test-only: resets the module-level "loaded once this session" state and the shared ref back to
 *  their fresh-load starting point. This module is a real singleton (one `loaded`/`loadPromise` pair
 *  for the whole plugin session, by design - see the module doc comment), which needs unwinding
 *  between test cases that would otherwise leak into each other since ES modules are shared instances
 *  across a test file's cases, not the app's own real multi-session lifetime. */
export function resetEditorColorSettingsForTests(): void {
	editorColorScheme.value = null;
	loaded = false;
	loadPromise = null;
}
