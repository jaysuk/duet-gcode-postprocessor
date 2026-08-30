import { beforeEach, describe, expect, it } from "vitest";
import { mountInDwc, resetDwc } from "dwc-plugin-test-kit";

import DiffPreview from "../src/components/DiffPreview.vue";
import FileInspector from "../src/components/FileInspector.vue";
import GcodeBrowser from "../src/components/GcodeBrowser.vue";
import PostProcessorPage from "../src/components/PostProcessorPage.vue";
import PostProcessorWidget from "../src/components/PostProcessorWidget.vue";
import RecipeEditor from "../src/components/RecipeEditor.vue";
import StepFields from "../src/components/StepFields.vue";
import { createRecipe, newUid } from "../src/model/recipe";
import { defaultConfig, STEP_DEFINITIONS } from "../src/model/steps/registry";

describe("components mount", () => {
	beforeEach(() => resetDwc());

	it("mounts the page", () => {
		expect(mountInDwc(PostProcessorPage).exists()).toBe(true);
	});

	it("mounts the Flexible Layouts widget", () => {
		expect(mountInDwc(PostProcessorWidget).exists()).toBe(true);
	});

	it("mounts the browser", () => {
		expect(mountInDwc(GcodeBrowser).exists()).toBe(true);
	});

	it("mounts the inspector with nothing selected", () => {
		const wrapper = mountInDwc(FileInspector, { props: { path: null } });
		expect(wrapper.text()).toContain("Select a G-code file");
	});

	it("mounts the diff preview with no run yet", () => {
		const wrapper = mountInDwc(DiffPreview, {
			props: { stats: null, diff: [], recipe: null, sourceName: "" },
		});
		expect(wrapper.text()).toContain("Run a preview");
	});

	it("mounts the recipe editor with no recipe", () => {
		const wrapper = mountInDwc(RecipeEditor, {
			props: { recipe: null, recipes: [], scriptsTrusted: false },
		});
		expect(wrapper.text()).toContain("No recipe selected");
	});

	it("mounts the recipe editor with a recipe and renders its steps", () => {
		const recipe = {
			...createRecipe("Test"),
			steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: defaultConfig("findReplace") }],
		};
		const wrapper = mountInDwc(RecipeEditor, {
			props: { recipe, recipes: [recipe], scriptsTrusted: false },
		});
		expect(wrapper.text()).toContain("Find and replace");
	});

	it("warns before running a recipe that contains a script", () => {
		const recipe = {
			...createRecipe("Scripted"),
			steps: [{ uid: newUid(), type: "script", enabled: true, config: defaultConfig("script") }],
		};
		const wrapper = mountInDwc(RecipeEditor, {
			props: { recipe, recipes: [recipe], scriptsTrusted: false },
		});
		expect(wrapper.text()).toContain("Trust scripts in this recipe");
	});
});

describe("the step form", () => {
	beforeEach(() => resetDwc());

	// Self-maintaining: a step added later gets a mount test without touching this file
	it.each(STEP_DEFINITIONS.map((d) => [d.id, d] as const))("renders the %s form", (id, definition) => {
		const wrapper = mountInDwc(StepFields, {
			props: { definition, config: defaultConfig(id) },
		});
		expect(wrapper.exists()).toBe(true);
		// Every visible field should render some kind of input
		expect(wrapper.findAll("input, textarea, select").length).toBeGreaterThan(0);
	});

	it("emits the whole config when a field changes", async () => {
		const definition = STEP_DEFINITIONS.find((d) => d.id === "findReplace")!;
		const wrapper = mountInDwc(StepFields, {
			props: { definition, config: defaultConfig("findReplace") },
		});
		const input = wrapper.find("input");
		await input.setValue("M104");
		const emitted = wrapper.emitted("update:config");
		expect(emitted).toBeTruthy();
		expect((emitted![0][0] as Record<string, unknown>).find).toBe("M104");
	});

	it("keeps a cleared numeric field empty rather than coercing it to zero", async () => {
		// Storing 0 here would silently run the recipe with a value the user never chose
		const definition = STEP_DEFINITIONS.find((d) => d.id === "paramRewrite")!;
		const wrapper = mountInDwc(StepFields, {
			props: { definition, config: defaultConfig("paramRewrite") },
		});
		const numeric = wrapper.findAll("input").find((i) => i.attributes("type") === "number");
		expect(numeric).toBeDefined();
		await numeric!.setValue("");
		const emitted = wrapper.emitted("update:config");
		expect(emitted).toBeTruthy();
		const last = emitted![emitted!.length - 1][0] as Record<string, unknown>;
		expect(Object.values(last)).toContain("");
	});
});
