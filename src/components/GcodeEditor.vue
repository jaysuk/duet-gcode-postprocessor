<style scoped>
.gcode-editor-host {
	min-height: 0;
	overflow: hidden;
	border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
	border-radius: 4px;
}
.gcode-editor-host :deep(.cm-editor) {
	height: 100%;
}
.gcode-editor-host :deep(.cm-scroller) {
	overflow: auto;
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
	font-size: 0.8125rem;
}
.gcode-editor-host :deep(.cm-gcode-line-state-gutter) {
	color: rgba(var(--v-theme-on-surface), 0.6);
	font-size: 0.6875rem;
	padding: 0 0.5em;
}
.gcode-editor-host :deep(.cm-gcode-line-state) {
	white-space: pre;
}
</style>

<template>
	<div class="pa-3 d-flex flex-column" style="height: 100%">
		<v-alert v-if="path === null" type="info" variant="tonal" density="compact">
			Select a G-code file to edit it.
		</v-alert>

		<template v-else>
			<div class="d-flex align-center ga-2 mb-2">
				<v-btn :loading="checking" :disabled="editorReady === false" prepend-icon="mdi-alert-circle-check-outline"
					   variant="tonal" @click="checkForErrors">
					Check for errors
				</v-btn>
				<span v-if="diagnosticCount !== null" class="text-caption text-medium-emphasis">
					{{ diagnosticCount === 0 ? "No issues found" : `${diagnosticCount} issue${diagnosticCount === 1 ? "" : "s"} found` }}
				</span>
				<v-spacer />
				<v-btn v-if="editorReady" variant="text" icon="mdi-magnify" title="Search (Ctrl+F)" @click="openSearch" />
				<v-btn v-if="editorReady" variant="text" icon="mdi-help-circle-outline" title="G-code reference" :href="docsUrl" target="_blank" rel="noopener noreferrer" />
				<v-btn v-if="editorReady" variant="text" icon="mdi-format-indent-increase" title="Align comments" @click="alignComments" />
				<v-btn v-if="editorReady" variant="text" icon="mdi-restore" :disabled="!dirty" title="Revert" @click="revert" />
				<span class="text-caption text-medium-emphasis text-truncate">
						{{ path }}<span v-if="dirty" class="text-warning">&nbsp;*</span>
					</span>
			</div>

			<v-alert v-if="error !== null" type="error" variant="tonal" density="compact" class="mb-2">{{ error }}</v-alert>
			<v-progress-linear v-if="busy" indeterminate class="mb-2" />

			<div ref="editorHostEl" class="gcode-editor-host flex-grow-1"></div>
		</template>
	</div>
</template>

<script setup lang="ts">
/**
 * A real editor view for one G-code file, replacing Monaco with `dwc-gcode-editor` — see
 * `docs/gcode-editor-plan.md`. Deliberately a SINGLE file per instance for this first slice, not
 * the full tabs/split-panes workspace shell `dwc-gcode-editor/workspace` provides — that is real,
 * separate scope for a follow-up once this path is proven against a real machine.
 */
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import { lintGutter } from "@codemirror/lint";
import { EditorView, lineNumbers } from "@codemirror/view";
import { diagnoseDocument, parseDocument } from "dwc-gcode-core";
import {
	alignLineComments, applyDiagnostics, buildDocFromChunks, codeAtCursor, createEditorInstance,
	createThemeController, gcodeCompletion, gcodeLanguage, gcodeLintUi, gcodeSearch, openSearchPanel,
	type EditorInstance, type ThemeController,
} from "dwc-gcode-editor";
import type { Text } from "@codemirror/state";

import { useMachineStore } from "@/stores/machine";
import { useSettingsStore } from "@/stores/settings";
import { createGateway } from "../dwc/gateway";
import { mainboardFirmwareVersion } from "../dwc/machineSnapshot";
import { blobToTextChunks } from "../model/gcode/editorDoc";
import { buildLineStateIndex, type LineStateIndex } from "../model/gcode/lineState";
import { lineStateGutter } from "../model/gcode/lineStateGutter";

const props = defineProps<{ path: string | null }>();

const machineStore = useMachineStore();
// Narrow cast, matching this repo's own convention (pluginSettings.ts's SettingsLike) rather than
// importing DWC's full settings store type - this component only ever reads the one field.
const settingsStore = useSettingsStore() as unknown as { darkTheme: boolean };
const editorHostEl = ref<HTMLElement | null>(null);
const busy = ref(false);
const checking = ref(false);
const error = ref<string | null>(null);
const diagnosticCount = ref<number | null>(null);
// shallowRef, not ref: EditorInstance wraps a live CM6 EditorView - Vue must never try to deep-
// reactive-proxy it (it would silently break CM6's own internal identity checks)
const editorInstance = shallowRef<EditorInstance | null>(null);
const editorReady = ref(false);
const dirty = ref(false);
const cursorCode = ref<string | null>(null);

const docsUrl = computed(() => {
	const base = "https://docs.duet3d.com/en/User_manual/Reference/Gcodes";
	return cursorCode.value !== null ? `${base}/${cursorCode.value}` : base;
});

let loadedPath: string | null = null;
// Snapshot of the document as loaded, for revert() - a real CM6 Text (not a string) so reverting is a
// single `insert: originalDoc` change, no string round-trip needed (ChangeSpec's own `insert` field
// accepts a Text directly).
let originalDoc: Text | null = null;
// Read by lineStateGutter's markers() callback on every repaint - not a ref, since a gutter
// recompute is forced explicitly (see load()) rather than through Vue's own reactivity, and this
// value can be read many times per second while scrolling a large file.
let lineIndex: LineStateIndex | null = null;
// One ThemeController per live editor instance (a Compartment belongs to exactly one EditorView) -
// recreated on every load(), read by the darkTheme watcher below to push a live swap.
let themeController: ThemeController | null = null;

function editorExtensions(theme: ThemeController) {
	return [
		lineNumbers(),
		lineStateGutter(() => lineIndex),
		gcodeLanguage,
		theme.extension,
		gcodeCompletion(),
		gcodeLintUi(),
		lintGutter(),
		gcodeSearch(),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) dirty.value = true;
			if (update.docChanged || update.selectionSet) cursorCode.value = codeAtCursor(update.view);
		}),
	];
}

function destroyEditor(): void {
	editorInstance.value?.destroy();
	editorInstance.value = null;
	editorReady.value = false;
	loadedPath = null;
	lineIndex = null;
	themeController = null;
	originalDoc = null;
	dirty.value = false;
	cursorCode.value = null;
}

async function load(path: string): Promise<void> {
	destroyEditor();
	busy.value = true;
	error.value = null;
	diagnosticCount.value = null;
	try {
		const blob = await createGateway().download(path);
		// The selection can change while a large file is still downloading - discard a stale
		// result rather than mount an editor for a file the user has since navigated away from
		// (the same guard FileInspector.vue's own `inspect()` uses for exactly this reason).
		if (props.path !== path || editorHostEl.value === null) return;
		const doc = await buildDocFromChunks(blobToTextChunks(blob));
		if (props.path !== path || editorHostEl.value === null) return;

		themeController = createThemeController(settingsStore.darkTheme);
		originalDoc = doc;
		editorInstance.value = createEditorInstance({
			doc,
			parent: editorHostEl.value,
			extensions: editorExtensions(themeController),
		});
		loadedPath = path;
		editorReady.value = true;
		dirty.value = false;

		// Deferred rather than built inline above: buildLineStateIndex is a real, synchronous
		// O(n) walk of the whole file (this plugin's own state.ts tracker is inherently
		// sequential - see lineState.ts's own doc comment) - running it before the editor's own
		// createEditorInstance call would delay the first paint by the same amount on a huge
		// file. Deferring lets the editor mount and paint first; the gutter simply stays empty
		// (lineStateGutter's own documented behaviour for a null index) until this resolves.
		// NOT chunked/yielding yet - a real, known scope boundary for a later pass if a very
		// large file's index build is ever shown to cost enough to matter on real hardware.
		const instance = editorInstance.value;
		setTimeout(() => {
			if (editorInstance.value !== instance) return; // superseded by a newer load() already
			lineIndex = buildLineStateIndex(instance.view.state.doc);
			instance.view.dispatch({}); // force the gutter to pick up the now-ready index
		}, 0);
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	} finally {
		busy.value = false;
	}
}

watch(() => props.path, (path) => {
	destroyEditor();
	diagnosticCount.value = null;
	error.value = null;
	if (path !== null) void load(path);
}, { immediate: true });

// Always goes through destroyEditor() (never `editorInstance.value?.view.destroy()` directly) so
// flush() always runs first - see dwc-gcode-editor's own editorCore.ts doc comment for the gap
// this closes (PR #517's "unmounting a dirty editor would silently lose the edits").
onUnmounted(() => destroyEditor());

// Follow DWC's own dark/light toggle live - the same flag MonacoEditor.vue reads to pick "vs" vs
// "vs-dark". Only meaningful once an instance exists; a toggle flip with no file open just becomes
// the initial value the next load() reads via createThemeController above.
watch(() => settingsStore.darkTheme, (dark) => {
	const instance = editorInstance.value;
	if (instance !== null && themeController !== null) themeController.setDark(instance.view, dark);
});

async function checkForErrors(): Promise<void> {
	const instance = editorInstance.value;
	if (instance === null || loadedPath === null) return;
	checking.value = true;
	try {
		// A whole-document string round-trip - the documented, accepted cost of a MANUAL check
		// (dwc-gcode-editor's own diagnostics.ts explains why this is never done automatically).
		const text = instance.view.state.doc.toString();
		const parsed = parseDocument(text);
		const firmwareVersion = mainboardFirmwareVersion(machineStore.model) ?? "0.0.0";
		const diagnostics = diagnoseDocument(parsed, loadedPath, { firmwareVersion });
		applyDiagnostics(instance.view, diagnostics);
		diagnosticCount.value = diagnostics.length;
	} finally {
		checking.value = false;
	}
}

function openSearch(): void {
	const instance = editorInstance.value;
	if (instance !== null) openSearchPanel(instance.view);
}

function alignComments(): void {
	const instance = editorInstance.value;
	if (instance !== null) alignLineComments(instance.view);
}

// Resets the buffer back to what load() originally fetched - in-session edits only, since this
// component never saves anywhere (view + diagnose + edit, no upload path at all).
function revert(): void {
	const instance = editorInstance.value;
	if (instance === null || originalDoc === null) return;
	instance.view.dispatch({ changes: { from: 0, to: instance.view.state.doc.length, insert: originalDoc } });
	dirty.value = false;
}

// Exposed purely for testability, matching GcodeCmEditor.vue's own established precedent in
// Flexible-Layouts - lets a test drive a real CM6 edit/selection directly rather than faking a DOM
// input event (see dwc-gcode-editor's own gotcha: synthetic DOM events don't reliably reach CM6's
// internal handlers the way `view.dispatch()` does).
defineExpose({ editorInstance });
</script>
