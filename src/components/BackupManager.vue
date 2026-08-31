<style scoped>
.original-path {
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
	font-size: 0.8125rem;
}
</style>

<template>
	<div class="pa-3">
		<v-toolbar density="compact" color="surface">
			<v-toolbar-title class="text-body-2">Backups</v-toolbar-title>
			<v-spacer />
			<v-btn variant="text" icon size="small" :loading="loading" title="Refresh"
				   :disabled="!machineStore.isConnected" @click="load">
				<v-icon>mdi-refresh</v-icon>
			</v-btn>
		</v-toolbar>

		<v-alert v-if="!machineStore.isConnected" type="info" variant="tonal" density="compact" class="ma-3">
			Not connected.
		</v-alert>

		<v-alert v-else-if="error !== null" type="error" variant="tonal" density="compact" class="ma-3">
			{{ error }}
		</v-alert>

		<v-alert v-else-if="!loading && entries.length === 0" type="info" variant="tonal" density="compact" class="ma-3">
			No backups yet — one is taken automatically whenever you overwrite a file in place.
		</v-alert>

		<v-list v-else density="compact">
			<v-list-item v-for="entry in entries" :key="entry.file">
				<template #title>
					<span class="original-path">{{ entry.originalPath }}</span>
				</template>
				<template #subtitle>
					{{ formatDate(entry.at) }} · {{ formatBytes(entry.bytes) }} · {{ entry.recipe }}
				</template>
				<template #append>
					<v-btn size="small" variant="text" :disabled="busyFile !== null" @click="openRestore(entry)">
						Restore
					</v-btn>
					<v-btn size="small" variant="text" :disabled="busyFile !== null" @click="downloadEntry(entry)">
						Download
					</v-btn>
					<v-btn size="small" variant="text" color="error" :disabled="busyFile !== null"
						   @click="openDelete(entry)">
						Delete
					</v-btn>
				</template>
			</v-list-item>
		</v-list>

		<v-dialog v-model="restoreDialog" max-width="34rem">
			<v-card title="Restore this backup?">
				<v-card-text>
					<p class="mb-3">
						This will overwrite <code class="original-path">{{ pending?.originalPath }}</code>
						with the backup taken {{ pending ? formatDate(pending.at) : "" }}.
					</p>
					<v-alert v-if="restoreBlockedReason !== null" type="error" variant="tonal" density="compact">
						{{ restoreBlockedReason }}
					</v-alert>
					<v-alert v-if="restoreError !== null" type="error" variant="tonal" density="compact">
						{{ restoreError }}
					</v-alert>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Cancel" :disabled="busyFile !== null" @click="restoreDialog = false" />
					<v-btn text="Restore" color="primary" :loading="busyFile === pending?.file"
						   :disabled="restoreBlockedReason !== null || busyFile !== null" @click="doRestore" />
				</v-card-actions>
			</v-card>
		</v-dialog>

		<v-dialog v-model="deleteDialog" max-width="30rem">
			<v-card title="Delete this backup?">
				<v-card-text>
					Removes the backup of <code class="original-path">{{ pending?.originalPath }}</code>
					taken {{ pending ? formatDate(pending.at) : "" }}. This cannot be undone.
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Cancel" :disabled="busyFile !== null" @click="deleteDialog = false" />
					<v-btn text="Delete" color="error" :loading="busyFile === pending?.file"
						   :disabled="busyFile !== null" @click="doDelete" />
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { downloadBlob } from "dwc-plugin-runtime/download";
import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";

import { createGateway } from "../dwc/gateway";
import { jobFileName } from "../dwc/machineSnapshot";
import { BACKUP_DIR, BACKUP_INDEX } from "../model/constants";
import { dirName, formatBytes, samePath } from "../model/io/plan";
import { parseIndex, serialiseIndex, type BackupEntry } from "../model/io/backups";

const machineStore = useMachineStore();
const uiStore = useUiStore();

const entries = ref<Array<BackupEntry>>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const restoreDialog = ref(false);
const deleteDialog = ref(false);
const pending = ref<BackupEntry | null>(null);
const restoreError = ref<string | null>(null);
/** The file name currently being restored or deleted, so its own row shows a spinner. */
const busyFile = ref<string | null>(null);

const restoreBlockedReason = ref<string | null>(null);

function formatDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

async function load(): Promise<void> {
	if (!machineStore.isConnected) return;
	loading.value = true;
	error.value = null;
	try {
		const blob = await createGateway().download(BACKUP_INDEX);
		entries.value = parseIndex(await blob.text());
	} catch {
		// No index yet is the overwhelmingly common case (nothing has been overwritten in place
		// yet) — treat it as an empty list, not an error
		entries.value = [];
	} finally {
		loading.value = false;
	}
}

watch(() => machineStore.isConnected, (connected) => { if (connected) void load(); });
onMounted(() => { void load(); });

function openRestore(entry: BackupEntry): void {
	pending.value = entry;
	restoreError.value = null;
	const printing = jobFileName(machineStore.model);
	restoreBlockedReason.value = (printing !== null && samePath(printing, entry.originalPath))
		? "This is the file the printer is currently reading. Restoring it now would rewrite the file mid-print."
		: null;
	restoreDialog.value = true;
}

function openDelete(entry: BackupEntry): void {
	pending.value = entry;
	deleteDialog.value = true;
}

async function downloadEntry(entry: BackupEntry): Promise<void> {
	try {
		const blob = await createGateway().download(`${BACKUP_DIR}/${entry.file}`);
		downloadBlob(entry.file, await blob.text(), "text/plain");
	} catch (e) {
		uiStore.makeNotification(LogLevel.error, "Backups", `Could not download ${entry.file}: ${(e as Error).message}`);
	}
}

/**
 * Restore uses the same temp-then-move discipline as a normal write: upload to a temp name next to
 * the target, then move it into place, so an interrupted restore never leaves the original half
 * overwritten. Everything is wrapped in one try/catch — on any failure the backup file itself is
 * untouched and still downloadable, so that is offered as the fallback rather than trying to
 * diagnose exactly which step failed.
 */
async function doRestore(): Promise<void> {
	if (pending.value === null || restoreBlockedReason.value !== null) return;
	const entry = pending.value;
	busyFile.value = entry.file;
	restoreError.value = null;
	const gateway = createGateway();
	const tempPath = `${entry.originalPath}.pp.tmp`;
	try {
		const blob = await gateway.download(`${BACKUP_DIR}/${entry.file}`);
		await gateway.makeDirectory(dirName(entry.originalPath));
		await gateway.upload(tempPath, blob);
		await gateway.move(tempPath, entry.originalPath, true);
		restoreDialog.value = false;
		uiStore.makeNotification(LogLevel.success, "Backups", `Restored ${entry.originalPath}`);
	} catch (e) {
		restoreError.value = `Restore failed: ${(e as Error).message}. The backup itself is untouched — use Download to save it locally instead.`;
	} finally {
		busyFile.value = null;
	}
}

async function doDelete(): Promise<void> {
	if (pending.value === null) return;
	const entry = pending.value;
	busyFile.value = entry.file;
	const gateway = createGateway();
	try {
		await gateway.remove(`${BACKUP_DIR}/${entry.file}`);
		const next = entries.value.filter((e) => e.file !== entry.file);
		await gateway.upload(BACKUP_INDEX, new Blob([serialiseIndex(next)], { type: "application/json" }));
		entries.value = next;
		deleteDialog.value = false;
	} catch (e) {
		uiStore.makeNotification(LogLevel.error, "Backups", `Could not delete ${entry.file}: ${(e as Error).message}`);
	} finally {
		busyFile.value = null;
	}
}
</script>
