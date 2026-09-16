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
				<span class="text-caption text-medium-emphasis text-truncate">{{ path }}</span>
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
import { onUnmounted, ref, shallowRef, watch } from "vue";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { lineNumbers } from "@codemirror/view";
import { diagnoseDocument, parseDocument } from "dwc-gcode-core";
import {
	applyDiagnostics, buildDocFromChunks, createEditorInstance, gcodeLanguage, gcodeLintUi,
	type EditorInstance,
} from "dwc-gcode-editor";

import { useMachineStore } from "@/stores/machine";
import { createGateway } from "../dwc/gateway";
import { mainboardFirmwareVersion } from "../dwc/machineSnapshot";
import { blobToTextChunks } from "../model/gcode/editorDoc";

const props = defineProps<{ path: string | null }>();

const machineStore = useMachineStore();
const editorHostEl = ref<HTMLElement | null>(null);
const busy = ref(false);
const checking = ref(false);
const error = ref<string | null>(null);
const diagnosticCount = ref<number | null>(null);
// shallowRef, not ref: EditorInstance wraps a live CM6 EditorView - Vue must never try to deep-
// reactive-proxy it (it would silently break CM6's own internal identity checks)
const editorInstance = shallowRef<EditorInstance | null>(null);
const editorReady = ref(false);

let loadedPath: string | null = null;

function editorExtensions() {
	return [
		lineNumbers(),
		gcodeLanguage,
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		gcodeLintUi(),
		lintGutter(),
	];
}

function destroyEditor(): void {
	editorInstance.value?.destroy();
	editorInstance.value = null;
	editorReady.value = false;
	loadedPath = null;
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

		editorInstance.value = createEditorInstance({
			doc,
			parent: editorHostEl.value,
			extensions: editorExtensions(),
		});
		loadedPath = path;
		editorReady.value = true;
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
</script>
