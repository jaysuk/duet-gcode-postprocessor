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
				<v-btn v-if="editorReady" variant="text" icon="mdi-tag-search" :title="quickSearchTitle" @click="openCodeSearch" />
				<v-btn v-if="editorReady" variant="text" icon="mdi-magnify" title="Search (Ctrl+F)" @click="openSearch" />
				<v-btn v-if="editorReady" variant="text" icon="mdi-help-circle-outline" title="G-code reference" :href="docsUrl" target="_blank" rel="noopener noreferrer" />
				<v-btn v-if="editorReady" variant="text" icon="mdi-format-indent-increase" title="Align comments" @click="alignComments" />
				<v-btn v-if="editorReady" variant="text" icon="mdi-restore" :disabled="!dirty" title="Revert" @click="revert" />
				<v-btn variant="text" icon="mdi-palette" title="Editor colors" @click="colorSettingsOpen = true" />
				<v-btn v-if="editorReady" variant="text" :color="stepperOpen ? 'primary' : undefined" icon="mdi-motion-play-outline"
					   title="Step through file" @click="stepperOpen = !stepperOpen" />
				<span class="text-caption text-medium-emphasis text-truncate">
						{{ path }}<span v-if="dirty" class="text-warning">&nbsp;*</span>
					</span>
			</div>

			<v-alert v-if="error !== null" type="error" variant="tonal" density="compact" class="mb-2">{{ error }}</v-alert>
			<v-progress-linear v-if="busy" indeterminate class="mb-2" />

			<GcodeStepperPanel v-if="stepperOpen && editorReady" :current-step="stepperStep" :total-steps="stepperTotalSteps"
								:line="stepperDisplayLine" :state="stepperState" :status="stepperStatus" :pending-path="stepperPendingPath"
								:error-message="stepperErrorMessage" :has-simulated-values="simulatedOverrides.size > 0" class="mb-2"
								@update:current-step="setStepperStep" @resolve-path="resolveSimulatedPath"
								@reset-simulated-values="resetSimulatedValues" />

			<div ref="editorHostEl" class="gcode-editor-host flex-grow-1"></div>
		</template>

		<EditorColorSettingsDialog v-model="colorSettingsOpen" />
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
	createThemeController, gcodeCompletion, gcodeCurrentLine, gcodeLanguage, gcodeLintUi,
	gcodeQuickSearchKeymap, gcodeSearch, isInsideExpression, openExpressionQuickSearch,
	openGcodeQuickSearch, openSearchPanel, setCurrentLine, type EditorInstance, type ThemeController,
} from "dwc-gcode-editor";
import type { Text } from "@codemirror/state";

import { useMachineStore } from "@/stores/machine";
import { useSettingsStore } from "@/stores/settings";
import EditorColorSettingsDialog from "./EditorColorSettingsDialog.vue";
import GcodeStepperPanel from "./GcodeStepperPanel.vue";
import { createGateway } from "../dwc/gateway";
import { editorColorScheme, loadEditorColorScheme } from "../dwc/editorColorSettings";
import { mainboardFirmwareVersion } from "../dwc/machineSnapshot";
import { blobToTextChunks } from "../model/gcode/editorDoc";
import { buildExecutionIndex, type ExecutionIndex } from "../model/gcode/executionIndex";
import { buildLineStateIndex, type LineStateIndex } from "../model/gcode/lineState";
import { lineStateGutter } from "../model/gcode/lineStateGutter";
import { createSimulatedResolvePath, parseSimulatedValueInput, type SimulatedValueOverrides } from "../model/gcode/simulatedValues";

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
const cursorInExpression = ref(false);
const colorSettingsOpen = ref(false);
const stepperOpen = ref(false);
// shallowRef, not a plain let: the stepper panel's own state readout is a real Vue computed that
// needs to re-render once the deferred background build below finishes - lineStateGutter's own
// getIndex() callback reads .value the same way it read the plain variable before.
const lineIndex = shallowRef<LineStateIndex | null>(null);

// Offline CONDITIONAL stepping: executionIndex.value is null until the deferred build in load()
// below finishes, same tradeoff lineIndex makes. stepperStep indexes executionIndex.steps (0-based -
// a step, not a physical line, since a false if/while branch contributes none and a loop body
// contributes one per iteration), never a raw line number - see executionIndex.ts's own doc comment.
const executionIndex = shallowRef<ExecutionIndex | null>(null);
const stepperStep = ref(0);
// User-supplied hypothetical values for object-model paths a condition referenced but this offline
// simulation (no live machine) has no way to know - keyed by the exact concrete path
// (`"sensors.gpIn[0].value"`), populated via the stepper panel's pause/prompt UI. A shallowRef holding
// a fresh Map on every change (rather than mutating in place) so Vue's reactivity actually notices.
const simulatedOverrides = shallowRef<SimulatedValueOverrides>(new Map());

const docsUrl = computed(() => {
	const base = "https://docs.duet3d.com/en/User_manual/Reference/Gcodes";
	return cursorCode.value !== null ? `${base}/${cursorCode.value}` : base;
});

// Matches MonacoEditor.vue's own toolbar wording exactly ("Find Code (F4)" / "Find Expression (F4)").
const quickSearchTitle = computed(() => cursorInExpression.value ? "Find Expression (F4)" : "Find Code (F4)");

const stepperTotalSteps = computed(() => executionIndex.value?.steps.length ?? 0);
const stepperCurrentStepInfo = computed(() => executionIndex.value?.steps[stepperStep.value] ?? null);
// 1-based, matching setCurrentLine's own convention - executionIndex.ts's steps are 0-based physical
// line indices (dwc-gcode-core's own convention, shared with `walkExecution`).
const stepperDisplayLine = computed(() => {
	const info = stepperCurrentStepInfo.value;
	return info === null ? null : info.line + 1;
});
const stepperState = computed(() => stepperCurrentStepInfo.value?.state ?? null);
const stepperStatus = computed(() => executionIndex.value?.status ?? "complete");
const stepperPendingPath = computed(() => {
	const index = executionIndex.value;
	return index?.status === "paused" ? index.path : null;
});
const stepperErrorMessage = computed(() => {
	const index = executionIndex.value;
	return index?.status === "error" ? index.message : null;
});

watch([stepperOpen, stepperDisplayLine], ([open, line]) => {
	const instance = editorInstance.value;
	if (instance === null) return;
	setCurrentLine(instance.view, open ? line : null, { scroll: open });
});

/** Rebuilds executionIndex from the live doc and the current simulatedOverrides - the same deferred
 *  (setTimeout) pattern load() already uses for lineIndex, so a rebuild (e.g. right after the user
 *  answers a pause prompt) doesn't block the next paint. Clamps stepperStep back into range, since a
 *  new simulated value can shrink OR grow the step count (a newly-false branch skips a body that used
 *  to run; a newly-resolved pause can run much further than before). */
function rebuildExecutionIndex(): void {
	const instance = editorInstance.value;
	if (instance === null) return;
	setTimeout(() => {
		if (editorInstance.value !== instance) return; // superseded by a newer load() already
		executionIndex.value = buildExecutionIndex(instance.view.state.doc, createSimulatedResolvePath(simulatedOverrides.value));
		const total = executionIndex.value.steps.length;
		stepperStep.value = total === 0 ? 0 : Math.min(stepperStep.value, total - 1);
	}, 0);
}

function resolveSimulatedPath(path: string, rawValue: string): void {
	const next = new Map(simulatedOverrides.value);
	next.set(path, parseSimulatedValueInput(rawValue));
	simulatedOverrides.value = next;
	rebuildExecutionIndex();
}

function resetSimulatedValues(): void {
	simulatedOverrides.value = new Map();
	rebuildExecutionIndex();
}

let loadedPath: string | null = null;
// Snapshot of the document as loaded, for revert() - a real CM6 Text (not a string) so reverting is a
// single `insert: originalDoc` change, no string round-trip needed (ChangeSpec's own `insert` field
// accepts a Text directly).
let originalDoc: Text | null = null;
// One ThemeController per live editor instance (a Compartment belongs to exactly one EditorView) -
// recreated on every load(), read by the darkTheme watcher below to push a live swap.
let themeController: ThemeController | null = null;

function editorExtensions(theme: ThemeController) {
	return [
		lineNumbers(),
		lineStateGutter(() => lineIndex.value),
		gcodeLanguage,
		theme.extension,
		gcodeCompletion(),
		gcodeLintUi(),
		lintGutter(),
		gcodeSearch(),
		gcodeQuickSearchKeymap(() => machineStore.model),
		gcodeCurrentLine(),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) dirty.value = true;
			if (update.docChanged || update.selectionSet) {
				cursorCode.value = codeAtCursor(update.view);
				const line = update.state.doc.lineAt(update.state.selection.main.head);
				const beforeCursor = line.text.slice(0, update.state.selection.main.head - line.from);
				cursorInExpression.value = isInsideExpression(beforeCursor);
			}
		}),
	];
}

function destroyEditor(): void {
	editorInstance.value?.destroy();
	editorInstance.value = null;
	editorReady.value = false;
	loadedPath = null;
	lineIndex.value = null;
	executionIndex.value = null;
	simulatedOverrides.value = new Map();
	themeController = null;
	originalDoc = null;
	dirty.value = false;
	cursorCode.value = null;
	cursorInExpression.value = false;
	stepperStep.value = 0;
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
		// A no-op after the first real call this session (every GcodeEditor.vue instance calls this
		// on load - see editorColorSettings.ts's own doc comment for the shared-load pattern).
		await loadEditorColorScheme();
		if (props.path !== path || editorHostEl.value === null) return;

		themeController = createThemeController(settingsStore.darkTheme);
		originalDoc = doc;
		editorInstance.value = createEditorInstance({
			doc,
			parent: editorHostEl.value,
			extensions: editorExtensions(themeController),
		});
		// Applied right after creation, in the same synchronous block, so there's no visible flash of
		// the fixed theme before the loaded custom colors (if any) take over.
		themeController.setCustomColors(editorInstance.value.view, editorColorScheme.value);
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
			lineIndex.value = buildLineStateIndex(instance.view.state.doc);
			instance.view.dispatch({}); // force the gutter to pick up the now-ready index
		}, 0);
		rebuildExecutionIndex();
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

// Live, site-wide colour updates: a Save from ANY open tab's settings dialog (this instance's own, or
// a different tab's) updates the shared editorColorScheme ref, which every open instance is watching -
// not just the one that opened the dialog.
watch(editorColorScheme, (scheme) => {
	const instance = editorInstance.value;
	if (instance !== null && themeController !== null) themeController.setCustomColors(instance.view, scheme);
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

// Matches MonacoEditor.vue's own searchGcode(): the toolbar button always calls this one function,
// which picks G/M-code search vs. object-model-path search off where the cursor sits - the same
// switch the F4 keybinding (gcodeQuickSearchKeymap, in editorExtensions above) already makes.
function openCodeSearch(): void {
	const instance = editorInstance.value;
	if (instance === null) return;
	if (cursorInExpression.value) openExpressionQuickSearch(instance.view, machineStore.model);
	else openGcodeQuickSearch(instance.view);
}

function setStepperStep(step: number): void {
	const maxStep = Math.max(0, stepperTotalSteps.value - 1);
	stepperStep.value = Math.min(Math.max(0, step), maxStep);
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
