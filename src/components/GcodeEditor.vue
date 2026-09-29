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
				<v-btn v-if="editorReady" variant="text" icon="mdi-keyboard-outline" title="Keyboard shortcuts (F1)" @click="openShortcuts" />
				<v-btn v-if="editorReady" variant="text" :color="stepperOpen ? 'primary' : undefined" icon="mdi-motion-play-outline"
					   title="Step through file" @click="stepperOpen = !stepperOpen" />
			</div>

			<v-alert v-if="error !== null" type="error" variant="tonal" density="compact" class="mb-2">{{ error }}</v-alert>
			<v-progress-linear v-if="busy" indeterminate class="mb-2" />

			<GcodeStepperPanel v-if="stepperOpen && editorReady" :current-step="stepperStep" :total-steps="stepperTotalSteps"
								:line="stepperDisplayLine" :view="stepperView" :status="stepperStatus" :pending-path="stepperPendingPath"
								:message-box-prompt="stepperMessageBoxPrompt" :error-message="stepperErrorMessage"
								:inputs="inputs" :referenced="referencedInputs" :message-box-answers="messageBoxAnswersList"
								:scenario-names="scenarioNames(scenarioSet)" :active-scenario="scenarioSet.active" :cursor-line="cursorLine" class="mb-2"
								@update:current-step="setStepperStep" @update:inputs="updateInputs" @select-scenario="selectScenarioByName" @add-scenario="addNamedScenario"
								@duplicate-scenario="duplicateActiveScenario" @rename-scenario="renameActiveScenario" @delete-scenario="deleteActiveScenario" @resolve-path="resolveSimulatedPath"
								@resolve-message-box="resolveMessageBoxPrompt" @remove-message-box-answer="removeMessageBoxAnswer"
								@reset-message-box-answers="resetMessageBoxAnswers" />

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
import type { MessageBoxAnswer, MessageBoxPrompt } from "dwc-gcode-core";
import {
	alignLineComments, buildDocFromChunks, canAutoCheck, checkDocument, codeAtCursor, createEditorInstance,
	createThemeController, gcodeCompletion, gcodeCurrentLine, gcodeLanguage, gcodeLintUi,
	gcodeLiveCheck, gcodeQuickSearchKeymap, gcodeSearch, gcodeShortcutsHelp, isInsideExpression, openExpressionQuickSearch,
	openGcodeQuickSearch, openSearchPanel, openShortcutsHelp, setCurrentLine, type EditorInstance, type ThemeController,
} from "dwc-gcode-editor";
import type { Text } from "@codemirror/state";

import { useMachineStore } from "@/stores/machine";
import { useSettingsStore } from "@/stores/settings";
import EditorColorSettingsDialog from "./EditorColorSettingsDialog.vue";
import GcodeStepperPanel from "./GcodeStepperPanel.vue";
import { createGateway } from "../dwc/gateway";
import { editorColorScheme, loadEditorColorScheme } from "../dwc/editorColorSettings";
import { mainboardFirmwareVersion, trackedObjectModelVersion } from "../dwc/machineSnapshot";
import { blobToTextChunks } from "../model/gcode/editorDoc";
import type { ExecutionIndex } from "dwc-gcode-core/stepper/executionIndex";
import { messageBoxKey } from "dwc-gcode-core/stepper/messageBoxAnswers";
import { parseSimulatedValueInput } from "dwc-gcode-core/stepper/simulatedValues";
import {
	describeStep, findReferencedInputs, formatEvalValue, runSimulation, sourceLines,
	withInputValue, type ReferencedInput, type SimulationInputs,
} from "dwc-gcode-core/stepper/simulation";
import {
	activeScenario, addScenario, deleteScenario, duplicateScenario, renameScenario, scenarioNames, selectScenario,
	singleScenarioSet, updateActiveScenario, type ScenarioSet,
} from "dwc-gcode-core/stepper/scenarioSet";
import { buildLineStateIndex, type LineStateIndex } from "../model/gcode/lineState";
import { lineStateGutter } from "../model/gcode/lineStateGutter";
import { loadScenarioSet, saveScenarioSet } from "../model/gcode/simulationScenario";

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
// The scenario the walk runs under - where the machine starts (X/Y/Z and any other axis), the
// object-model / param.* / global values this offline simulation (no live machine) has no way to know,
// and remembered M291 answers (see dwc-gcode-core's stepper/simulation.ts). A shallowRef holding a
// fresh object on every change (never mutated in place) so Vue's reactivity actually notices.
// The file's named scenarios (`dwc-gcode-core/stepper/scenarioSet`); `inputs` is the active one.
const scenarioSet = shallowRef<ScenarioSet>(singleScenarioSet());
const inputs = computed<SimulationInputs>(() => activeScenario(scenarioSet.value));
// The 1-based line the cursor is on, offered in the scenario panel as "start here".
const cursorLine = ref<number | null>(null);
// What the file reads (object-model paths, param.*, undeclared globals), offered as fields in the
// scenario editor - computed with each rebuild, and only while the stepper is open.
const referencedInputs = shallowRef<ReadonlyArray<ReferencedInput>>([]);
// The source lines the current executionIndex was built from - the SAME text the walker indexed, so a
// step's evaluated-expression offsets always line up with it even if the buffer has since been edited.
const builtSourceLines = shallowRef<ReadonlyArray<string>>([]);

const docsUrl = computed(() => {
	const base = "https://docs.duet3d.com/en/User_manual/Reference/Gcodes";
	return cursorCode.value !== null ? `${base}/${cursorCode.value}` : base;
});

// Matches MonacoEditor.vue's own toolbar wording exactly ("Find Code (F4)" / "Find Expression (F4)").
const quickSearchTitle = computed(() => cursorInExpression.value ? "Find Expression (F4)" : "Find Code (F4)");

const stepperTotalSteps = computed(() => executionIndex.value?.steps.length ?? 0);
// Everything the panel and the editor show about the current step - the line as evaluated, both
// machine states with per-axis deltas, the variables (dwc-gcode-core's `describeStep`). Recomputed when
// the step, the run, or the scenario changes.
const stepperView = computed(() => {
	const index = executionIndex.value;
	return index === null ? null : describeStep(index, stepperStep.value, builtSourceLines.value, inputs.value);
});
// 1-based, matching setCurrentLine's own convention - executionIndex.ts's steps are 0-based physical
// line indices (dwc-gcode-core's own convention, shared with `walkExecution`); describeStep converts.
const stepperDisplayLine = computed(() => stepperView.value?.line ?? null);
const stepperStatus = computed(() => executionIndex.value?.status ?? "complete");
const stepperPendingPath = computed(() => {
	const index = executionIndex.value;
	return index?.status === "paused" ? index.path : null;
});
const stepperMessageBoxPrompt = computed(() => {
	const index = executionIndex.value;
	return index?.status === "message-box" ? index.prompt : null;
});
const stepperErrorMessage = computed(() => {
	const index = executionIndex.value;
	return index?.status === "error" ? index.message : null;
});

// Highlights the current line and draws the line as evaluated beneath it. Scrolls only when the step
// or line actually moved: a rebuild (the scenario changed, or the buffer was edited) produces a new
// view too, and re-centring on every one of those would yank the page around while someone types.
watch([stepperOpen, stepperView], ([open, view], [wasOpen, oldView]) => {
	const instance = editorInstance.value;
	if (instance === null) return;
	const moved = !wasOpen || oldView?.step !== view?.step || oldView?.line !== view?.line;
	const annotation = open && view !== null && view.evaluated.changed ? { segments: view.evaluated.segments } : null;
	setCurrentLine(instance.view, open ? (view?.line ?? null) : null, { scroll: open && moved, annotation });
});

/** Rebuilds executionIndex from the live doc and the current scenario - the same deferred (setTimeout)
 *  pattern load() already uses for lineIndex, so a rebuild (e.g. right after a value is entered)
 *  doesn't block the next paint. Clamps stepperStep back into range, since a new value can shrink OR
 *  grow the step count (a newly-false branch skips a body that used to run; a newly-resolved pause can
 *  run much further than before). */
function rebuildExecutionIndex(): void {
	const instance = editorInstance.value;
	if (instance === null) return;
	setTimeout(() => {
		if (editorInstance.value !== instance) return; // superseded by a newer load() already
		rebuildNow(instance);
	}, 0);
}

function rebuildNow(instance: EditorInstance): void {
	const text = instance.view.state.doc.toString();
	const objectModelVersion = trackedObjectModelVersion(machineStore.model);
	const index = runSimulation(text, inputs.value, { objectModelVersion });
	executionIndex.value = index;
	// The source lines (for the evaluated-line display) and the values the file reads (offered as fields
	// in the scenario editor) each cost another parse of the text, and this also runs at load with the
	// stepper closed - so only pay for them while it's showing. Opening the stepper rebuilds (below).
	if (stepperOpen.value) {
		builtSourceLines.value = sourceLines(text);
		referencedInputs.value = findReferencedInputs(text, { objectModelVersion, startLine: inputs.value.startLine });
	}
	const total = index.steps.length;
	stepperStep.value = total === 0 ? 0 : Math.min(stepperStep.value, total - 1);
}

// Editing the file while stepping through it re-runs the walk (debounced), so the steps never describe a
// buffer that has since changed. Nothing runs while the stepper is closed.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRebuild(): void {
	if (rebuildTimer !== null) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(() => {
		rebuildTimer = null;
		rebuildExecutionIndex();
	}, 400);
}

// Opening the stepper builds what only it needs (source lines, what the file reads). Synchronous, not
// deferred: someone just asked to see the steps, and a deferred build would leave the panel briefly
// showing steps with no source line to go with them.
watch(stepperOpen, (open) => {
	const instance = editorInstance.value;
	if (open && instance !== null) rebuildNow(instance);
});

/** Applies an edited scenario: keeps it, saves it for this file, and re-runs the walk under it. */
function updateInputs(next: SimulationInputs): void {
	setScenarioSet(updateActiveScenario(scenarioSet.value, next));
}

/** Keeps `set`, saves it for this file, and re-runs the walk under whichever scenario is now active. */
function setScenarioSet(set: ScenarioSet): void {
	scenarioSet.value = set;
	if (loadedPath !== null) saveScenarioSet(loadedPath, set);
	rebuildExecutionIndex();
}

// A different scenario is a different run: start it from its first step, not wherever the last one was.
function changeScenarioSet(set: ScenarioSet): void {
	stepperStep.value = 0;
	setScenarioSet(set);
}
const selectScenarioByName = (name: string): void => changeScenarioSet(selectScenario(scenarioSet.value, name));
const addNamedScenario = (name: string): void => changeScenarioSet(addScenario(scenarioSet.value, name));
const duplicateActiveScenario = (): void => changeScenarioSet(duplicateScenario(scenarioSet.value));
const renameActiveScenario = (name: string): void => setScenarioSet(renameScenario(scenarioSet.value, scenarioSet.value.active, name));
const deleteActiveScenario = (): void => changeScenarioSet(deleteScenario(scenarioSet.value, scenarioSet.value.active));

/** The pause prompt's answer for one unresolved path. */
function resolveSimulatedPath(path: string, rawValue: string): void {
	updateInputs(withInputValue(inputs.value, path.startsWith("param.") ? "param" : "objectModel", path, parseSimulatedValueInput(rawValue)));
}

function resolveMessageBoxPrompt(answer: MessageBoxAnswer): void {
	const prompt = stepperMessageBoxPrompt.value;
	if (prompt === null) return;
	const answers = new Map(inputs.value.messageBoxAnswers);
	answers.set(messageBoxKey(prompt), answer);
	updateInputs({ ...inputs.value, messageBoxAnswers: answers });
}

function removeMessageBoxAnswer(key: string): void {
	const answers = new Map(inputs.value.messageBoxAnswers);
	answers.delete(key);
	updateInputs({ ...inputs.value, messageBoxAnswers: answers });
}

function resetMessageBoxAnswers(): void {
	updateInputs({ ...inputs.value, messageBoxAnswers: new Map() });
}

/** `prompt` is the SAME prompt the answer was originally given for (recovered from the content key -
 *  see `messageBoxAnswersList` below), which lets a choice answer show the chosen option's own TEXT
 *  rather than just its opaque index. */
function formatMessageBoxAnswer(answer: MessageBoxAnswer, prompt: MessageBoxPrompt | null): string {
	if (answer.cancelled) return "Cancel";
	if (answer.input === null) return "OK";
	if (prompt?.mode === "choice" && typeof answer.input === "number") {
		return prompt.choices[answer.input] ?? `#${answer.input}`;
	}
	return typeof answer.input === "string" ? JSON.stringify(answer.input) : formatEvalValue(answer.input);
}

const messageBoxAnswersList = computed(() => [...inputs.value.messageBoxAnswers.entries()]
	.map(([key, answer]) => {
		// The key IS the prompt's own JSON serialisation (messageBoxKey) - reusing it here avoids
		// storing the prompt a second time just for display purposes.
		let prompt: MessageBoxPrompt | null = null;
		try {
			prompt = JSON.parse(key) as MessageBoxPrompt;
		} catch {
			// Malformed/foreign key (shouldn't happen - messageBoxKey always produces valid JSON) -
			// fall back to showing the raw key rather than breaking the whole list over one entry.
		}
		const message = prompt?.message ?? key;
		return { key, display: `${message} → ${formatMessageBoxAnswer(answer, prompt)}` };
	}));

let loadedPath: string | null = null;
// Snapshot of the document as loaded, for revert() - a real CM6 Text (not a string) so reverting is a
// single `insert: originalDoc` change, no string round-trip needed (ChangeSpec's own `insert` field
// accepts a Text directly).
let originalDoc: Text | null = null;
// One ThemeController per live editor instance (a Compartment belongs to exactly one EditorView) -
// recreated on every load(), read by the darkTheme watcher below to push a live swap.
let themeController: ThemeController | null = null;

// This editor never saves (view + diagnose + edit only), so the help leaves Ctrl+S out.
const SHORTCUTS_HIDDEN = ["save"];

function editorExtensions(theme: ThemeController) {
	return [
		lineNumbers(),
		lineStateGutter(() => lineIndex.value),
		gcodeLanguage,
		theme.extension,
		gcodeCompletion(),
		gcodeLintUi(),
		lintGutter(),
		// Re-checks the lines being typed on (and, after a pause, the whole file when it is small enough),
		// keeping the toolbar count current.
		gcodeLiveCheck({ getOptions: () => checkOptions(loadedPath ?? props.path ?? ""), onChange: (count) => { diagnosticCount.value = count; } }),
		gcodeSearch(),
		gcodeQuickSearchKeymap(() => machineStore.model),
		gcodeShortcutsHelp({ hide: SHORTCUTS_HIDDEN }),
		gcodeCurrentLine(),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				dirty.value = true;
				if (stepperOpen.value) scheduleRebuild();
			}
			if (update.docChanged || update.selectionSet) {
				cursorCode.value = codeAtCursor(update.view);
				const line = update.state.doc.lineAt(update.state.selection.main.head);
				cursorLine.value = line.number;
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
	scenarioSet.value = singleScenarioSet();
	cursorLine.value = null;
	referencedInputs.value = [];
	builtSourceLines.value = [];
	if (rebuildTimer !== null) {
		clearTimeout(rebuildTimer);
		rebuildTimer = null;
	}
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
		scenarioSet.value = loadScenarioSet(path);
		checkOnLoad(editorInstance.value);

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

// A whole-document string round-trip - the documented, accepted cost of a check (dwc-gcode-editor's own
// diagnostics.ts explains why it is never done on every keystroke).
function checkOptions(path: string): { path: string; firmwareVersion: string } {
	return { path, firmwareVersion: mainboardFirmwareVersion(machineStore.model) ?? "0.0.0" };
}

function runCheck(instance: EditorInstance, path: string): void {
	diagnosticCount.value = checkDocument(instance.view, checkOptions(path)).length;
}

async function checkForErrors(): Promise<void> {
	const instance = editorInstance.value;
	if (instance === null || loadedPath === null) return;
	checking.value = true;
	try {
		runCheck(instance, loadedPath);
	} finally {
		checking.value = false;
	}
}

/** The same check as the button, run once right after a file has loaded so its problems are marked
 *  without anyone asking. Skipped for a file too large to check without freezing the page (the button is
 *  still there), and deferred so the editor paints first. */
function checkOnLoad(instance: EditorInstance | null): void {
	if (instance === null || loadedPath === null || !canAutoCheck(instance.view)) return;
	const path = loadedPath;
	setTimeout(() => {
		if (editorInstance.value === instance) runCheck(instance, path); // not superseded by a newer load()
	}, 0);
}

function openShortcuts(): void {
	const instance = editorInstance.value;
	if (instance !== null) openShortcutsHelp(instance.view, { hide: SHORTCUTS_HIDDEN });
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
