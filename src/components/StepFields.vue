<style scoped>
.field-help {
	opacity: 0.7;
}

.mono :deep(textarea),
.mono :deep(input) {
	font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
	font-size: 0.875rem;
}
</style>

<template>
	<div>
		<template v-for="field in visibleFields" :key="field.key">
			<v-switch v-if="field.type === 'boolean'" density="compact" hide-details="auto" color="primary"
					  class="mb-1"
					  :model-value="config[field.key] === true"
					  :label="field.label"
					  :messages="field.help ? [field.help] : []"
					  :disabled="disabled"
					  @update:model-value="(value: boolean | null) => update(field.key, value === true)" />

			<v-select v-else-if="field.type === 'select'" density="compact" hide-details="auto"
					  class="mb-3"
					  :model-value="config[field.key]"
					  :items="field.options ?? []"
					  item-title="label"
					  item-value="value"
					  :label="field.label"
					  :messages="field.help ? [field.help] : []"
					  :disabled="disabled"
					  @update:model-value="(value: unknown) => update(field.key, value)" />

			<v-text-field v-else-if="field.type === 'number'" density="compact" hide-details="auto"
						  type="number"
						  class="mb-3"
						  :model-value="config[field.key]"
						  :label="field.label"
						  :messages="field.help ? [field.help] : []"
						  :min="field.min"
						  :max="field.max"
						  :step="field.step ?? 1"
						  :disabled="disabled"
						  :error-messages="errorsFor(field.key)"
						  @update:model-value="(value: string) => updateNumber(field.key, value)" />

			<v-textarea v-else-if="field.type === 'textarea' || field.type === 'gcode'"
						density="compact" hide-details="auto" auto-grow rows="4"
						class="mb-3 mono"
						spellcheck="false"
						:model-value="String(config[field.key] ?? '')"
						:label="field.label"
						:messages="field.help ? [field.help] : []"
						:placeholder="field.placeholder"
						:disabled="disabled"
						:error-messages="errorsFor(field.key)"
						@update:model-value="(value: string) => update(field.key, value)" />

			<v-text-field v-else density="compact" hide-details="auto"
						  class="mb-3"
						  :class="{ mono: field.type === 'regex' }"
						  spellcheck="false"
						  :model-value="String(config[field.key] ?? '')"
						  :label="field.label"
						  :messages="field.help ? [field.help] : []"
						  :placeholder="field.placeholder"
						  :disabled="disabled"
						  :error-messages="errorsFor(field.key)"
						  @update:model-value="(value: string) => update(field.key, value)" />
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { isFieldVisible, type StepDefinition } from "../model/steps/types";

const props = defineProps<{
	definition: StepDefinition;
	config: Record<string, unknown>;
	/** Validation messages for the whole step; matched to fields by their label. */
	errors?: Array<string>;
	disabled?: boolean;
}>();

const emit = defineEmits<{
	"update:config": [config: Record<string, unknown>];
}>();

const visibleFields = computed(() => props.definition.fields.filter((f) => isFieldVisible(f, props.config)));

function update(key: string, value: unknown): void {
	emit("update:config", { ...props.config, [key]: value });
}

/**
 * Numeric fields come back from Vuetify as strings, and an emptied field is "" rather than 0 or
 * NaN. Storing the empty string on purpose (rather than coercing it to 0) is what lets validation
 * tell the user their field is blank instead of silently running with a zero.
 */
function updateNumber(key: string, raw: string): void {
	if (raw === "" || raw === null || raw === undefined) {
		update(key, "");
		return;
	}
	const value = Number(raw);
	update(key, Number.isFinite(value) ? value : "");
}

/** Errors are reported against a field's label, so match them back to the field they belong to. */
function errorsFor(key: string): Array<string> {
	const field = props.definition.fields.find((f) => f.key === key);
	if (field === undefined || props.errors === undefined) return [];
	return props.errors.filter((e) => e.startsWith(field.label) || e.includes(`'${field.label}'`));
}
</script>
