<style scoped>
.browser {
	display: flex;
	flex-direction: column;
	min-height: 0;
}

.browser-list {
	overflow-y: auto;
	flex: 1 1 auto;
	min-height: 12rem;
}

.selected {
	background: rgba(var(--v-theme-primary), 0.12);
}
</style>

<template>
	<!--
		DWC 3.7 publishes every one of its own components to plugins (window.DWC.Components), so the
		real file browser - breadcrumbs, tiles, thumbnails, sorting - is reused when it is there. The
		fallback below is a plain list against getFileList, so the plugin still works on a DWC that
		predates that exposure. One seam, no feature loss for the job at hand.
	-->
	<component :is="dwcFileList" v-if="dwcFileList !== null"
			   :options="{ initialDirectory: directory }"
			   :directory="directory"
			   root-directory="0:/gcodes"
			   root-label="Jobs"
			   no-items-text="list.baseFileList.noFiles"
			   no-new-file no-new-directory no-delete no-rename no-download
			   @update:directory="(value: string) => (directory = value)"
			   @file-click="onDwcFileClick" />

	<div v-else class="browser">
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

		<v-text-field v-model="filter" density="compact" hide-details variant="solo-filled" flat
					  class="mx-2 my-1" placeholder="Filter by name" prepend-inner-icon="mdi-magnify"
					  clearable />

		<v-alert v-if="error !== null" type="warning" variant="tonal" density="compact" class="ma-2">
			{{ error }}
		</v-alert>

		<v-list v-else class="browser-list" density="compact" nav>
			<v-list-item v-for="item in filtered" :key="item.name"
						 :prepend-icon="item.isDirectory ? 'mdi-folder' : 'mdi-file-document-outline'"
						 :title="item.name"
						 :subtitle="item.isDirectory ? undefined : describe(item)"
						 :class="{ selected: !item.isDirectory && fullPath(item.name) === modelValue }"
						 @click="onClick(item)" />
			<v-list-item v-if="filtered.length === 0 && !loading"
						 title="Nothing here" subtitle="No G-code files in this folder" disabled />
		</v-list>
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

/**
 * DWC's own FileList, when this DWC exposes it. Resolved once rather than per render: the global is
 * populated before plugins load, and re-reading it in a computed would only add work.
 */
const dwcFileList = computed(() => {
	const components = (window as unknown as { DWC?: { Components?: Record<string, unknown> } }).DWC?.Components;
	return (components?.FileList as object | undefined) ?? null;
});

const atRoot = computed(() => directory.value.replace(/\/+$/, "") === "0:/gcodes");

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

function onDwcFileClick(item: { name: string; isDirectory?: boolean }, dir: string): void {
	if (item.isDirectory === true) return;
	if (!isGcode(item.name)) return;
	modelValue.value = `${dir.replace(/\/+$/, "")}/${item.name}`;
}

function goUp(): void {
	const parent = directory.value.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
	directory.value = parent === "0:" || parent === "" ? "0:/gcodes" : parent;
}

async function refresh(): Promise<void> {
	if (dwcFileList.value !== null) return;
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
