<style scoped>
.step-card {
	border-left: 3px solid rgb(var(--v-theme-primary));
}

.step-card--disabled {
	border-left-color: rgba(var(--v-theme-on-surface), 0.2);
	opacity: 0.65;
}

.step-card--invalid {
	border-left-color: rgb(var(--v-theme-error));
}
</style>

<template>
	<div>
		<v-toolbar density="compact" color="surface">
			<v-select :model-value="recipe?.id" :items="recipeItems" item-title="name" item-value="id"
					  density="compact" hide-details variant="solo-filled" flat class="me-2"
					  label="Recipe" style="max-width: 20rem"
					  @update:model-value="(id: string) => emit('select', id)" />

			<v-btn variant="text" icon title="New recipe" @click="emit('add')">
				<v-icon>mdi-plus</v-icon>
			</v-btn>

			<v-menu>
				<template #activator="{ props: activator }">
					<v-btn v-bind="activator" variant="text" icon title="More">
						<v-icon>mdi-dots-vertical</v-icon>
					</v-btn>
				</template>
				<v-list density="compact">
					<v-list-item prepend-icon="mdi-content-copy" title="Duplicate"
								 :disabled="recipe === null" @click="emit('duplicate')" />
					<v-list-item prepend-icon="mdi-download" title="Export as JSON"
								 :disabled="recipe === null" @click="exportRecipe" />
					<v-list-item prepend-icon="mdi-upload" title="Import from JSON" @click="importDialog = true" />
					<v-list-item prepend-icon="mdi-book-open-variant" title="Add a bundled preset"
								 @click="presetDialog = true" />
					<v-divider />
					<v-list-item prepend-icon="mdi-delete" title="Delete this recipe" base-color="error"
								 :disabled="recipe === null" @click="emit('remove')" />
				</v-list>
			</v-menu>
		</v-toolbar>

		<v-alert v-if="recipe === null" type="info" variant="tonal" density="compact" class="ma-3">
			No recipe selected. Create one, or add a bundled preset from the menu above.
		</v-alert>

		<div v-else class="pa-3">
			<v-row dense>
				<v-col cols="12" sm="6">
					<v-text-field :model-value="recipe.name" label="Name" density="compact" hide-details
								  @update:model-value="(v: string) => patch({ name: v })" />
				</v-col>
				<v-col cols="12" sm="6">
					<v-text-field :model-value="recipe.match ?? ''" label="Only files matching"
								  placeholder="*.gcode" density="compact" hide-details
								  messages="Used when picking a recipe automatically. Blank means any file."
								  @update:model-value="(v: string) => patch({ match: v })" />
				</v-col>
			</v-row>

			<v-alert v-if="problems.length > 0" type="warning" variant="tonal" density="compact" class="mt-3">
				<div v-for="(problem, index) in problems" :key="index">
					<strong>{{ problem.stepLabel }}:</strong> {{ problem.message }}
				</div>
			</v-alert>

			<v-alert v-if="hasScripts" type="warning" variant="tonal" density="compact" class="mt-3">
				<div class="d-flex align-center flex-wrap ga-2">
					<span>
						This recipe runs JavaScript. It executes with the same privileges as this page —
						read it before you trust it.
					</span>
					<v-spacer />
					<v-switch :model-value="scriptsTrusted" density="compact" hide-details color="warning"
							  label="Trust scripts in this recipe"
							  @update:model-value="(v: boolean | null) => emit('update:scriptsTrusted', v === true)" />
				</div>
			</v-alert>

			<div v-if="recipe.steps.length === 0" class="text-medium-emphasis text-center py-6">
				No steps yet. Add one below.
			</div>

			<v-card v-for="(step, index) in recipe.steps" :key="step.uid"
					class="mt-3 step-card" variant="tonal"
					:class="{
						'step-card--disabled': !step.enabled,
						'step-card--invalid': stepErrors(step.uid).length > 0,
					}">
				<v-toolbar density="compact" color="transparent">
					<v-icon class="ms-3 me-2">{{ definitionFor(step.type)?.icon ?? 'mdi-help' }}</v-icon>
					<v-toolbar-title class="text-body-1">
						{{ index + 1 }}. {{ definitionFor(step.type)?.label ?? step.type }}
						<span v-if="step.note" class="text-medium-emphasis text-caption">— {{ step.note }}</span>
					</v-toolbar-title>
					<v-spacer />
					<v-btn variant="text" icon size="small" title="Move up" :disabled="index === 0"
						   @click="move(index, -1)">
						<v-icon>mdi-arrow-up</v-icon>
					</v-btn>
					<v-btn variant="text" icon size="small" title="Move down"
						   :disabled="index === recipe.steps.length - 1" @click="move(index, 1)">
						<v-icon>mdi-arrow-down</v-icon>
					</v-btn>
					<v-btn variant="text" icon size="small" :title="step.enabled ? 'Disable' : 'Enable'"
						   @click="setStep(index, { enabled: !step.enabled })">
						<v-icon>{{ step.enabled ? 'mdi-eye' : 'mdi-eye-off' }}</v-icon>
					</v-btn>
					<v-btn variant="text" icon size="small" title="Remove" @click="removeStep(index)">
						<v-icon>mdi-close</v-icon>
					</v-btn>
				</v-toolbar>

				<v-card-text v-if="definitionFor(step.type) !== null">
					<v-text-field :model-value="step.note ?? ''" label="Note (optional)" density="compact"
								  hide-details class="mb-3"
								  @update:model-value="(v: string) => setStep(index, { note: v })" />
					<v-text-field :model-value="conditionText(step)"
								  label="Only run if... (JSON array, optional)" density="compact"
								  :error-messages="conditionError(step)" class="mb-3"
								  placeholder='[{"key":"filament_type","op":"eq","value":"PETG"}]'
								  hint='Matched against the file&#39;s own slicer metadata. See docs/usage.md.'
								  persistent-hint
								  @update:model-value="(v: string) => setCondition(index, v)" />
					<StepFields :definition="definitionFor(step.type)!" :config="step.config"
								:errors="stepErrors(step.uid)"
								@update:config="(config) => setStep(index, { config })" />
				</v-card-text>
				<v-card-text v-else class="text-error">
					Unknown step type "{{ step.type }}" — it may come from a newer version of the plugin.
				</v-card-text>
			</v-card>

			<v-menu>
				<template #activator="{ props: activator }">
					<v-btn v-bind="activator" class="mt-4" variant="tonal" prepend-icon="mdi-plus" block>
						Add a step
					</v-btn>
				</template>
				<v-list density="compact" max-width="30rem">
					<v-list-item v-for="definition in definitions" :key="definition.id"
								 :prepend-icon="definition.icon" :title="definition.label"
								 :subtitle="definition.description" @click="addStep(definition.id)" />
				</v-list>
			</v-menu>
		</div>

		<v-dialog v-model="importDialog" max-width="40rem">
			<v-card title="Import a recipe">
				<v-card-text>
					<v-textarea v-model="importText" label="Recipe JSON" rows="10" auto-grow spellcheck="false"
								:error-messages="importError ? [importError] : []" />
					<p class="text-caption text-medium-emphasis">
						Any script steps arrive untrusted: you will be asked to review them before they run.
					</p>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Cancel" @click="importDialog = false" />
					<v-btn text="Import" color="primary" @click="doImport" />
				</v-card-actions>
			</v-card>
		</v-dialog>

		<v-dialog v-model="presetDialog" max-width="40rem">
			<v-card title="Bundled recipes">
				<v-list density="compact">
					<v-list-item v-for="preset in presets" :key="preset.key" :title="preset.name"
								 :subtitle="preset.description" @click="addPreset(preset.key)" />
				</v-list>
				<v-card-actions>
					<v-spacer />
					<v-btn text="Close" @click="presetDialog = false" />
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { downloadBlob } from "dwc-plugin-runtime/download";

import StepFields from "./StepFields.vue";
import { PRESETS, findPreset } from "../model/presets";
import {
	exportRecipe as serialise, importRecipe, newUid, usesScripts, validateRecipe,
	type Recipe, type RecipeStep,
} from "../model/recipe";
import { defaultConfig, getStepDefinition, STEP_DEFINITIONS } from "../model/steps/registry";
import type { StepCondition } from "../model/stepCondition";

const props = defineProps<{
	recipe: Recipe | null;
	recipes: Array<Recipe>;
	scriptsTrusted: boolean;
}>();

const emit = defineEmits<{
	"update:recipe": [recipe: Recipe];
	"update:scriptsTrusted": [value: boolean];
	select: [id: string];
	add: [];
	remove: [];
	duplicate: [];
	import: [recipe: Recipe];
}>();

const importDialog = ref(false);
const presetDialog = ref(false);
const importText = ref("");
const importError = ref<string | null>(null);

const definitions = STEP_DEFINITIONS;
const presets = PRESETS;
const recipeItems = computed(() => props.recipes.map((r) => ({ id: r.id, name: r.name })));
const problems = computed(() => (props.recipe === null ? [] : validateRecipe(props.recipe)));
const hasScripts = computed(() => props.recipe !== null && usesScripts(props.recipe));

function definitionFor(type: string) {
	return getStepDefinition(type);
}

function stepErrors(uid: string): Array<string> {
	return problems.value.filter((p) => p.stepUid === uid).map((p) => p.message);
}

// Edited as raw JSON text (the same convention the "rules" step's own condition list already uses)
// rather than a bespoke condition-builder UI — keyed by step uid so one step's malformed edit does
// not affect another's while it is mid-typo.
const conditionErrors = ref<Record<string, string>>({});

function conditionText(step: RecipeStep): string {
	return step.condition === undefined || step.condition.length === 0 ? "" : JSON.stringify(step.condition);
}

function conditionError(step: RecipeStep): Array<string> {
	const message = conditionErrors.value[step.uid];
	return message ? [message] : [];
}

function setCondition(index: number, text: string): void {
	if (props.recipe === null) return;
	const uid = props.recipe.steps[index].uid;
	if (text.trim() === "") {
		conditionErrors.value = { ...conditionErrors.value, [uid]: "" };
		setStep(index, { condition: undefined });
		return;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!Array.isArray(parsed)) throw new Error("Must be a JSON array of conditions");
		for (const c of parsed as Array<Partial<StepCondition>>) {
			if (typeof c.key !== "string" || c.key === "") throw new Error('Each condition needs a "key"');
			if (typeof c.op !== "string") throw new Error('Each condition needs an "op"');
		}
		conditionErrors.value = { ...conditionErrors.value, [uid]: "" };
		setStep(index, { condition: parsed as Array<StepCondition> });
	} catch (e) {
		conditionErrors.value = { ...conditionErrors.value, [uid]: (e as Error).message };
	}
}

function patch(changes: Partial<Recipe>): void {
	if (props.recipe === null) return;
	emit("update:recipe", { ...props.recipe, ...changes });
}

function setStep(index: number, changes: Partial<RecipeStep>): void {
	if (props.recipe === null) return;
	const steps = props.recipe.steps.slice();
	steps[index] = { ...steps[index], ...changes };
	patch({ steps });
}

function removeStep(index: number): void {
	if (props.recipe === null) return;
	patch({ steps: props.recipe.steps.filter((_, i) => i !== index) });
}

function move(index: number, delta: number): void {
	if (props.recipe === null) return;
	const steps = props.recipe.steps.slice();
	const target = index + delta;
	if (target < 0 || target >= steps.length) return;
	[steps[index], steps[target]] = [steps[target], steps[index]];
	patch({ steps });
}

function addStep(type: string): void {
	if (props.recipe === null) return;
	const step: RecipeStep = { uid: newUid(), type, enabled: true, config: defaultConfig(type) };
	patch({ steps: [...props.recipe.steps, step] });
}

function addPreset(key: string): void {
	const preset = findPreset(key);
	if (preset === null) return;
	presetDialog.value = false;
	emit("import", preset.build());
}

function exportRecipe(): void {
	if (props.recipe === null) return;
	const name = props.recipe.name.replace(/[^\w.-]+/g, "_");
	downloadBlob(`${name}.recipe.json`, serialise(props.recipe), "application/json");
}

function doImport(): void {
	try {
		const recipe = importRecipe(importText.value);
		importError.value = null;
		importDialog.value = false;
		importText.value = "";
		emit("import", recipe);
	} catch (e) {
		importError.value = (e as Error).message;
	}
}
</script>
