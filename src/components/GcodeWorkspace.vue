<style scoped>
.gcode-workspace {
	min-height: 0;
}
.gcode-workspace-panes {
	display: flex;
	flex-direction: row;
	flex: 1 1 auto;
	min-height: 0;
}
.gcode-workspace-pane {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-width: 0;
	min-height: 0;
}
.gcode-workspace-divider {
	flex: 0 0 7px;
	margin: 0 -3px;
	cursor: ew-resize;
	touch-action: none;
	z-index: 1;
}
.gcode-workspace-divider:hover, .gcode-workspace-divider--dragging {
	background: rgba(var(--v-theme-on-surface), 0.12);
}
.gcode-workspace-body {
	position: relative;
	flex: 1 1 auto;
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

		<div v-else ref="panesEl" class="gcode-workspace-panes">
			<template v-for="(group, gi) in workspace.groups" :key="group.id">
				<div class="gcode-workspace-pane" :style="paneStyle(gi)">
					<v-tabs v-if="tabsInGroup(group.id).length > 1 || workspace.groups.length > 1"
							:model-value="group.activeTabId" density="compact" show-arrows
							@update:model-value="(id) => onActivate(id as number)">
						<v-tab v-for="t in tabsInGroup(group.id)" :key="t.id" :value="t.id" class="text-none"
							   draggable="true" @dragstart="onTabDragStart($event, t.id)">
							<span class="text-truncate" style="max-width: 16rem">{{ fileName(t.data.path) }}</span>
							<v-btn variant="text" size="small" density="comfortable" icon class="ml-2"
								   :title="`Close ${fileName(t.data.path)}`" @click.stop="onClose(t.id)">
								<v-icon size="18">mdi-close</v-icon>
							</v-btn>
						</v-tab>
						<v-spacer />
						<v-btn v-if="workspace.groups.length === 1" variant="text" icon :disabled="!canSplit(workspace)"
							   title="Split right" @click="onSplitRight">
							<v-icon>mdi-dock-right</v-icon>
						</v-btn>
						<v-btn v-if="group.id === SECONDARY_GROUP" variant="text" icon title="Close split"
							   @click="onCloseSplit">
							<v-icon>mdi-dock-left</v-icon>
						</v-btn>
					</v-tabs>
					<v-divider v-if="tabsInGroup(group.id).length > 1 || workspace.groups.length > 1" />

					<div class="flex-grow-1 gcode-workspace-body" @dragover.prevent @drop="onTabDrop($event, group.id)">
						<div v-for="t in tabsInGroup(group.id)" :key="t.id" v-show="t.id === group.activeTabId"
							 class="gcode-workspace-slot">
							<GcodeEditor :path="t.data.path" />
						</div>
					</div>
				</div>

				<div v-if="gi === 0 && workspace.groups.length > 1" class="gcode-workspace-divider"
					 :class="{ 'gcode-workspace-divider--dragging': dragging }"
					 @pointerdown="onDividerPointerDown" @pointermove="onDividerPointerMove"
					 @pointerup="onDividerPointerUp" @pointercancel="onDividerPointerUp" />
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
/**
 * Multiple files open at once in the "Edit" tab, plus a split view — both halves of
 * `dwc-gcode-editor`'s workspace shell (`docs/gcode-editor-plan.md`'s architecture section),
 * following `Duet3D/DuetWebControl` PR #517's own design for the same feature in its Explorer page:
 * a draggable divider resizing two panes, tabs dragged from one pane's strip to the other, a
 * persisted ratio.
 *
 * Every opened tab's `GcodeEditor` instance stays mounted for the workspace's lifetime (`v-if` once,
 * then `v-show` to switch) rather than being torn down when inactive — the same "on-demand mount,
 * stay alive once opened" shape `Flexible-Layouts/ExplorerPanel.vue` already uses for Monaco. This
 * plugin's `GcodeEditor` has no save-back-to-SD-card path yet (view + diagnostics only), so there is
 * no in-progress-edit-loss risk from that choice today; revisit if/when it grows one.
 */
import { ref, watch } from "vue";
import {
	canSplit, closeSplit, closeTab, createWorkspace, moveTab, openTab,
	SECONDARY_GROUP, setActiveTab, setSplitRatio, splitRight, tabsInGroup as tabsInGroupOf,
	type GroupId, type WorkspaceState,
} from "dwc-gcode-editor";

import { LS_EDIT_SPLIT_RATIO } from "../model/constants";
import GcodeEditor from "./GcodeEditor.vue";

interface EditorTabData {
	path: string;
}

const props = defineProps<{ selectedPath: string | null }>();

const workspace = ref<WorkspaceState<EditorTabData> | null>(null);
const panesEl = ref<HTMLElement | null>(null);
const dragging = ref(false);

function tabsInGroup(groupId: GroupId) {
	return workspace.value === null ? [] : tabsInGroupOf(workspace.value, groupId);
}

function paneStyle(groupIndex: number): Record<string, string> | undefined {
	if (workspace.value === null || workspace.value.groups.length < 2 || groupIndex !== 0) return undefined;
	return { flex: `0 0 ${workspace.value.splitRatio * 100}%` };
}

function fileName(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/** Ensure a tab exists for `path` and make it active - reused for both a fresh file pick in
 *  GcodeBrowser and the right-click deep-link route (both just set `selectedPath`). Never opens a
 *  second tab for a file that is already open, in either pane. */
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

function onSplitRight(): void {
	if (workspace.value !== null) workspace.value = splitRight(workspace.value);
}

function onCloseSplit(): void {
	if (workspace.value !== null) workspace.value = closeSplit(workspace.value);
}

let draggedTabId: number | null = null;

function onTabDragStart(event: DragEvent, tabId: number): void {
	draggedTabId = tabId;
	event.dataTransfer?.setData("text/plain", String(tabId));
}

function onTabDrop(event: DragEvent, groupId: GroupId): void {
	event.preventDefault();
	const idFromTransfer = Number(event.dataTransfer?.getData("text/plain"));
	const id = Number.isFinite(idFromTransfer) && idFromTransfer > 0 ? idFromTransfer : draggedTabId;
	draggedTabId = null;
	if (workspace.value !== null && id !== null) workspace.value = moveTab(workspace.value, id, groupId);
}

function readStoredSplitRatio(): number {
	try {
		const raw = localStorage.getItem(LS_EDIT_SPLIT_RATIO);
		const parsed = raw === null ? NaN : Number(raw);
		return Number.isFinite(parsed) ? parsed : 0.5;
	} catch {
		return 0.5;
	}
}

function onDividerPointerDown(event: PointerEvent): void {
	dragging.value = true;
	(event.target as HTMLElement).setPointerCapture(event.pointerId);
}

function onDividerPointerMove(event: PointerEvent): void {
	if (!dragging.value || workspace.value === null || panesEl.value === null) return;
	const rect = panesEl.value.getBoundingClientRect();
	if (rect.width <= 0) return;
	const ratio = (event.clientX - rect.left) / rect.width;
	workspace.value = setSplitRatio(workspace.value, ratio);
}

function onDividerPointerUp(): void {
	if (!dragging.value) return;
	dragging.value = false;
	if (workspace.value === null) return;
	try {
		localStorage.setItem(LS_EDIT_SPLIT_RATIO, String(workspace.value.splitRatio));
	} catch {
		// storage disabled
	}
}

// Applies the persisted ratio the first time a split actually happens, rather than on every
// render - createWorkspace()/splitRight() both start from the module's own DEFAULT_SPLIT_RATIO,
// so this only needs to run once, right after a split, not track the ratio continuously.
watch(() => workspace.value?.groups.length, (length, previous) => {
	if (length === 2 && previous !== 2 && workspace.value !== null) {
		workspace.value = setSplitRatio(workspace.value, readStoredSplitRatio());
	}
});
</script>
