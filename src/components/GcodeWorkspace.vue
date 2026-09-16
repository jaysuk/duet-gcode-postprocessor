<style scoped>
.gcode-workspace {
	min-height: 0;
}
.gcode-workspace-body {
	position: relative;
	min-height: 0;
}
.gcode-workspace-slot {
	position: absolute;
	inset: 0;
}
</style>

<template>
	<div class="d-flex flex-column ga-0 gcode-workspace" style="height: 100%">
		<v-alert v-if="workspace === null" type="info" variant="tonal" density="compact" class="ma-3">
			Select a G-code file to edit it.
		</v-alert>

		<template v-else>
			<v-tabs v-if="tabs.length > 1" :model-value="activeTabId" density="compact" show-arrows
					@update:model-value="(id) => onActivate(id as number)">
				<v-tab v-for="t in tabs" :key="t.id" :value="t.id" class="text-none">
					<span class="text-truncate" style="max-width: 16rem">{{ fileName(t.data.path) }}</span>
					<v-btn variant="text" size="small" density="comfortable" icon class="ml-2"
						   :title="`Close ${fileName(t.data.path)}`" @click.stop="onClose(t.id)">
						<v-icon size="18">mdi-close</v-icon>
					</v-btn>
				</v-tab>
			</v-tabs>
			<v-divider v-if="tabs.length > 1" />

			<div class="flex-grow-1 gcode-workspace-body">
				<div v-for="t in tabs" :key="t.id" v-show="t.id === activeTabId" class="gcode-workspace-slot">
					<GcodeEditor :path="t.data.path" />
				</div>
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
/**
 * Multiple files open at once in the "Edit" tab — the tabs half of `dwc-gcode-editor`'s workspace
 * shell (`docs/gcode-editor-plan.md`'s architecture section). Split panes are deliberately not part
 * of this pass: `dwc-gcode-editor/workspace`'s data model already supports a second group, so
 * adding that later is new UI on the same model, not a rewrite — kept as its own, separately
 * verified step rather than shipped alongside this untested.
 *
 * Every opened tab's `GcodeEditor` instance stays mounted for the workspace's lifetime (`v-if` once,
 * then `v-show` to switch) rather than being torn down when inactive — the same "on-demand mount,
 * stay alive once opened" shape `Flexible-Layouts/ExplorerPanel.vue` already uses for Monaco. This
 * plugin's `GcodeEditor` has no save-back-to-SD-card path yet (view + diagnostics only), so there is
 * no in-progress-edit-loss risk from that choice today; revisit if/when it grows one.
 */
import { computed, ref, watch } from "vue";
import { createWorkspace, openTab, setActiveTab, closeTab, tabsInGroup, activeTab, PRIMARY_GROUP, type WorkspaceState } from "dwc-gcode-editor";

import GcodeEditor from "./GcodeEditor.vue";

interface EditorTabData {
	path: string;
}

const props = defineProps<{ selectedPath: string | null }>();

const workspace = ref<WorkspaceState<EditorTabData> | null>(null);

const tabs = computed(() => (workspace.value === null ? [] : tabsInGroup(workspace.value, PRIMARY_GROUP)));
const activeTabId = computed(() => (workspace.value === null ? null : activeTab(workspace.value, PRIMARY_GROUP)?.id ?? null));

function fileName(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/** Ensure a tab exists for `path` and make it active - reused for both a fresh file pick in
 *  GcodeBrowser and the right-click deep-link route (both just set `selectedPath`). Never opens a
 *  second tab for a file that is already open. */
function ensureTabFor(path: string): void {
	const w = workspace.value;
	if (w === null) {
		workspace.value = createWorkspace<EditorTabData>({ path });
		return;
	}
	const existing = w.tabs.find((t) => t.data.path === path);
	workspace.value = existing !== undefined ? setActiveTab(w, existing.id) : openTab(w, { path });
}

watch(() => props.selectedPath, (path) => {
	if (path !== null) ensureTabFor(path);
}, { immediate: true });

function onActivate(id: number): void {
	if (workspace.value !== null) workspace.value = setActiveTab(workspace.value, id);
}

function onClose(id: number): void {
	if (workspace.value === null) return;
	const next = closeTab(workspace.value, id);
	workspace.value = next.tabs.length === 0 ? null : next;
}
</script>
