<style scoped>
.widget {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}

.widget-body {
	flex: 1 1 auto;
	overflow-y: auto;
	min-height: 0;
}
</style>

<template>
	<div class="widget pa-2">
		<div class="d-flex align-center mb-2">
			<v-icon class="me-2" size="small">mdi-file-replace-outline</v-icon>
			<span class="text-body-2 font-weight-medium">Post-Processor</span>
			<v-spacer />
			<v-btn variant="text" size="x-small" icon title="Open the full page" @click="openPage">
				<v-icon>mdi-open-in-new</v-icon>
			</v-btn>
		</div>

		<div class="widget-body">
			<v-select :model-value="recipeId" :items="recipeItems" item-title="name" item-value="id"
					  density="compact" hide-details variant="outlined" label="Recipe" class="mb-2"
					  :disabled="busy" @update:model-value="(id: string) => select(id)" />

			<v-text-field :model-value="path ?? ''" density="compact" hide-details variant="outlined"
						  label="File" readonly class="mb-2"
						  :messages="path === null ? 'Pick a file on the Post-Processor page first' : ''" />

			<v-progress-linear v-if="busy" :model-value="(progress ?? 0) * 100"
							   :indeterminate="progress === null" height="6" rounded class="mb-2" />

			<v-alert v-if="message !== null" :type="messageType" variant="tonal" density="compact"
					 class="mb-2 text-caption">
				{{ message }}
			</v-alert>

			<v-btn block color="primary" size="small" prepend-icon="mdi-eye-outline"
				   :disabled="!canRun || busy" @click="preview">
				Preview
			</v-btn>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useMachineStore } from "@/stores/machine";

import { createGateway } from "../dwc/gateway";
import { installedPluginVersion } from "../dwc/machineSnapshot";
import { scriptsTrusted, useRecipes } from "../dwc/recipeStore";
import { LS_SELECTED_FILE, PLUGIN_MANIFEST_ID, ROUTE_PATH } from "../model/constants";
import { planOutput } from "../model/io/plan";
import { CancelledError, processFile } from "../model/io/transfer";
import { usesScripts, validateRecipe } from "../model/recipe";

/**
 * Flexible Layouts renders an embeddable with a config/setConfig/host contract. Nothing here is
 * configurable yet, so the props are accepted and ignored rather than omitted — declaring them
 * keeps Vue from warning about extraneous attributes when FL passes them.
 */
defineProps<{
	config?: Record<string, unknown>;
	setConfig?: (patch: Record<string, unknown>) => void;
	host?: { isEditing: boolean; instanceId?: string };
}>();

const router = useRouter();
const machineStore = useMachineStore();
const { recipes, active: recipe, select } = useRecipes();

const busy = ref(false);
const progress = ref<number | null>(null);
const message = ref<string | null>(null);
const messageType = ref<"success" | "error" | "info">("info");

const recipeItems = computed(() => recipes.value.map((r) => ({ id: r.id, name: r.name })));
const recipeId = computed(() => recipe.value?.id ?? null);

const path = computed(() => {
	try {
		return localStorage.getItem(LS_SELECTED_FILE);
	} catch {
		return null;
	}
});

const canRun = computed(() => (
	machineStore.isConnected
	&& path.value !== null
	&& recipe.value !== null
	&& validateRecipe(recipe.value).length === 0
	&& (!usesScripts(recipe.value) || scriptsTrusted(recipe.value.id))
));

function openPage(): void {
	void router.push(ROUTE_PATH);
}

/**
 * Preview only. Applying from a dashboard tile would mean overwriting a file from a control with no
 * room for the diff or the confirmation, so the widget deliberately stops short and hands over.
 */
async function preview(): Promise<void> {
	if (path.value === null || recipe.value === null || busy.value) return;
	busy.value = true;
	message.value = null;
	progress.value = 0;
	try {
		const result = await processFile({
			gateway: createGateway(),
			sourcePath: path.value,
			recipe: recipe.value,
			plan: planOutput({ sourcePath: path.value, mode: "alongside" }),
			pluginVersion: installedPluginVersion(machineStore.model, PLUGIN_MANIFEST_ID),
			scriptsTrusted: scriptsTrusted(recipe.value.id),
			dryRun: true,
			onProgress: (update) => { progress.value = update.fraction; },
		});
		messageType.value = result.stats.linesChanged + result.stats.linesAdded + result.stats.linesRemoved > 0
			? "success"
			: "info";
		message.value = `${result.stats.linesChanged} changed, ${result.stats.linesAdded} added, `
			+ `${result.stats.linesRemoved} removed. Open the page to apply.`;
	} catch (e) {
		if (!(e instanceof CancelledError)) {
			messageType.value = "error";
			message.value = (e as Error).message;
		}
	} finally {
		busy.value = false;
		progress.value = null;
	}
}
</script>
