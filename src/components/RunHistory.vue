<style scoped>
.path {
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
	font-size: 0.8125rem;
}
</style>

<template>
	<div class="pa-3">
		<v-toolbar density="compact" color="surface">
			<v-toolbar-title class="text-body-2">Run history</v-toolbar-title>
			<v-spacer />
			<v-btn variant="text" icon size="small" :loading="loading" title="Refresh"
				   :disabled="!machineStore.isConnected" @click="load">
				<v-icon>mdi-refresh</v-icon>
			</v-btn>
			<v-btn variant="text" icon size="small" title="Clear history"
				   :disabled="!machineStore.isConnected || entries.length === 0" @click="clearDialog = true">
				<v-icon>mdi-delete-sweep-outline</v-icon>
			</v-btn>
		</v-toolbar>

		<v-alert v-if="!machineStore.isConnected" type="info" variant="tonal" density="compact" class="ma-3">
			Not connected.
		</v-alert>

		<v-alert v-else-if="error !== null" type="error" variant="tonal" density="compact" class="ma-3">
			{{ error }}
		</v-alert>

		<v-alert v-else-if="!loading && entries.length === 0" type="info" variant="tonal" density="compact" class="ma-3">
			No runs recorded yet — an entry is added here every time a recipe is applied (not previewed).
		</v-alert>

		<v-expansion-panels v-else variant="accordion">
			<v-expansion-panel v-for="(entry, index) in entries" :key="index">
				<v-expansion-panel-title>
					<v-icon :color="entry.ok ? 'success' : 'error'" size="small" class="me-2">
						{{ entry.ok ? "mdi-check-circle-outline" : "mdi-alert-circle-outline" }}
					</v-icon>
					<span class="path">{{ entry.sourcePath }}</span>
					<v-spacer />
					<span class="text-caption text-medium-emphasis me-2">
						{{ formatDate(entry.at) }} · {{ entry.recipeName }} · {{ originLabel(entry.origin) }}
					</span>
				</v-expansion-panel-title>
				<v-expansion-panel-text>
					<div v-if="!entry.ok" class="text-error mb-2">{{ entry.error }}</div>
					<template v-else>
						<div class="mb-1">
							Wrote <span class="path">{{ entry.targetPath }}</span> —
							{{ entry.linesChanged.toLocaleString() }} changed,
							{{ entry.linesAdded.toLocaleString() }} added,
							{{ entry.linesRemoved.toLocaleString() }} removed in
							{{ (entry.durationMs / 1000).toFixed(1) }} s.
						</div>
						<div v-if="entry.backupPath !== null" class="mb-1">
							Backup: <span class="path">{{ entry.backupPath }}</span>
						</div>
					</template>
					<v-alert v-for="(warning, i) in entry.warnings" :key="i" type="warning" variant="tonal"
							 density="compact" class="mt-2">
						{{ warning }}
					</v-alert>
				</v-expansion-panel-text>
			</v-expansion-panel>
		</v-expansion-panels>

		<v-dialog v-model="clearDialog" max-width="30rem">
			<v-card title="Clear run history?">
				<v-card-text>
					Removes every recorded run from this machine. This cannot be undone.
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Cancel" @click="clearDialog = false" />
					<v-btn text="Clear" color="error" :loading="clearing" @click="doClear" />
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useMachineStore } from "@/stores/machine";

import { createGateway } from "../dwc/gateway";
import { HISTORY_INDEX } from "../model/constants";
import { parseHistory, serialiseHistory, type HistoryEntry, type RunOrigin } from "../model/io/history";

const machineStore = useMachineStore();

const entries = ref<Array<HistoryEntry>>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const clearDialog = ref(false);
const clearing = ref(false);

const ORIGIN_LABELS: Record<RunOrigin, string> = {
	page: "page", widget: "widget", auto: "auto-run", batch: "batch",
};

function originLabel(origin: RunOrigin): string {
	return ORIGIN_LABELS[origin];
}

function formatDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

async function load(): Promise<void> {
	if (!machineStore.isConnected) return;
	loading.value = true;
	error.value = null;
	try {
		const blob = await createGateway().download(HISTORY_INDEX);
		entries.value = parseHistory(await blob.text());
	} catch {
		// No index yet is the common case (nothing has been applied yet) — treat it as empty
		entries.value = [];
	} finally {
		loading.value = false;
	}
}

watch(() => machineStore.isConnected, (connected) => { if (connected) void load(); });
onMounted(() => { void load(); });

async function doClear(): Promise<void> {
	clearing.value = true;
	try {
		await createGateway().upload(HISTORY_INDEX, new Blob([serialiseHistory([])], { type: "application/json" }));
		entries.value = [];
		clearDialog.value = false;
	} finally {
		clearing.value = false;
	}
}
</script>
