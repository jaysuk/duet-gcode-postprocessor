<style scoped>
.browser-wrap {
	display: flex;
	flex-direction: column;
	min-height: 0;
	width: 100%;
}

.selected-strip {
	flex: 0 0 auto;
}

.browser {
	display: flex;
	flex-direction: column;
	min-height: 0;
	flex: 1 1 auto;
}

/* Vuetify's toolbar pins its own height via a CSS custom property, but a plain v-text-field has no
 * such guarantee — left to default flex sizing (flex: 0 1 auto) it can be stretched along the main
 * axis by whatever the flex column's own height resolves to, which is how this ended up scaling with
 * the window: nothing else in `.browser` was claiming the leftover space, so this was. Pinning both
 * to flex: 0 0 auto makes them exactly their content height, unconditionally, leaving `.browser-list`
 * (flex: 1 1 auto, the only element meant to grow) as the sole consumer of whatever space remains. */
.browser > :deep(.v-toolbar),
.filter-field {
	flex: 0 0 auto;
}

.browser-list {
	overflow-y: auto;
	overflow-x: hidden;
	flex: 1 1 auto;
	min-height: 12rem;
}

.file-row {
	border-inline-start: 3px solid transparent;
}

.file-row.selected {
	background: rgba(var(--v-theme-primary), 0.14);
	border-inline-start-color: rgb(var(--v-theme-primary));
}

.file-row.selected :deep(.v-list-item-title) {
	font-weight: 700;
	color: rgb(var(--v-theme-primary));
}
</style>

<template>
	<div class="browser-wrap">
		<v-sheet class="selected-strip px-3 py-2 d-flex align-center ga-2" color="primary" variant="tonal">
			<v-icon size="small">mdi-file-check-outline</v-icon>
			<span v-if="modelValue !== null" class="text-body-2 text-truncate">
				Selected: <strong>{{ selectedName }}</strong>
			</span>
			<span v-else class="text-body-2 text-medium-emphasis">No file selected</span>
		</v-sheet>

		<!--
			DWC's own FileList component is built for managing files (bulk select, delete, upload),
			not for picking a single one to hand to another tool — it has no way to show "this is the
			file in use elsewhere on the page", and its table needs more width than this pane has to
			give. A plain, purpose-built list against getFileList keeps the browser this page actually
			needs: obviously one-file-at-a-time, and no wider than the pane around it.
		-->
		<div class="browser">
			<v-toolbar density="compact" color="surface">
				<v-btn variant="text" icon size="small" :disabled="atRoot" title="Up one folder" @click="goUp">
					<v-icon>mdi-arrow-up</v-icon>
				</v-btn>
				<v-toolbar-title class="text-body-2 text-truncate">{{ directory }}</v-toolbar-title>
				<v-spacer />
				<v-btn variant="text" icon size="small" :loading="loading" title="Refresh" @click="refresh">
					<v-icon>mdi-refresh</v-icon>
				</v-btn>
			</v-toolbar>

			<v-text-field v-model="filter" density="compact" hide-details variant="outlined"
						  class="filter-field mx-2 my-1" placeholder="Filter by name" prepend-inner-icon="mdi-magnify"
						  clearable />

			<v-alert v-if="error !== null" type="warning" variant="tonal" density="compact" class="ma-2">
				{{ error }}
			</v-alert>

			<v-list v-else class="browser-list" density="compact" nav>
				<v-list-item v-for="item in filtered" :key="item.name"
							 class="file-row"
							 :class="{ selected: !item.isDirectory && fullPath(item.name) === modelValue }"
							 :title="item.name"
							 :subtitle="item.isDirectory ? undefined : describe(item)"
							 @click="onClick(item)">
					<template #prepend>
						<v-icon v-if="item.isDirectory">mdi-folder</v-icon>
						<v-icon v-else-if="fullPath(item.name) === modelValue" color="primary">mdi-check-circle</v-icon>
						<v-icon v-else>mdi-file-document-outline</v-icon>
					</template>
				</v-list-item>
				<v-list-item v-if="filtered.length === 0 && !loading"
							 title="Nothing here" subtitle="No G-code files in this folder" disabled />
			</v-list>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useMachineStore } from "@/stores/machine";

import { LS_DIRECTORY } from "../model/constants";
import { formatBytes } from "../model/io/plan";

interface BrowserItem {
	name: string;
	isDirectory: boolean;
	size?: number;
	lastModified?: Date | null;
}

const modelValue = defineModel<string | null>({ default: null });

const machineStore = useMachineStore();

const directory = ref(readStoredDirectory());
const items = ref<Array<BrowserItem>>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const filter = ref("");

const atRoot = computed(() => directory.value.replace(/\/+$/, "") === "0:/gcodes");

const selectedName = computed(() => {
	if (modelValue.value === null) return "";
	const parts = modelValue.value.split("/");
	return parts[parts.length - 1] ?? modelValue.value;
});

const filtered = computed(() => {
	const needle = (filter.value ?? "").toLowerCase();
	return items.value
		.filter((item) => item.isDirectory || isGcode(item.name))
		.filter((item) => needle === "" || item.name.toLowerCase().includes(needle))
		.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
});

function isGcode(name: string): boolean {
	return /\.(g|gco|gcode|nc|ngc)$/i.test(name);
}

function fullPath(name: string): string {
	return `${directory.value.replace(/\/+$/, "")}/${name}`;
}

function describe(item: BrowserItem): string {
	const parts: Array<string> = [];
	if (typeof item.size === "number") parts.push(formatBytes(item.size));
	if (item.lastModified instanceof Date) parts.push(item.lastModified.toLocaleString());
	return parts.join(" · ");
}

function onClick(item: BrowserItem): void {
	if (item.isDirectory) {
		directory.value = fullPath(item.name);
		return;
	}
	modelValue.value = fullPath(item.name);
}

function goUp(): void {
	const parent = directory.value.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
	directory.value = parent === "0:" || parent === "" ? "0:/gcodes" : parent;
}

async function refresh(): Promise<void> {
	loading.value = true;
	error.value = null;
	try {
		items.value = (await machineStore.getFileList(directory.value)) as Array<BrowserItem>;
	} catch (e) {
		items.value = [];
		error.value = `Could not list ${directory.value}: ${(e as Error).message}`;
	} finally {
		loading.value = false;
	}
}

function readStoredDirectory(): string {
	try {
		return localStorage.getItem(LS_DIRECTORY) ?? "0:/gcodes";
	} catch {
		return "0:/gcodes";
	}
}

watch(directory, (value) => {
	try {
		localStorage.setItem(LS_DIRECTORY, value);
	} catch {
		// storage disabled — the browser simply starts at the root next time
	}
	void refresh();
});

// Re-list once the connection comes up: mounting while disconnected otherwise leaves an empty list
// with no way back other than the refresh button
watch(() => machineStore.isConnected, (connected) => {
	if (connected) void refresh();
});

onMounted(() => { void refresh(); });
</script>
