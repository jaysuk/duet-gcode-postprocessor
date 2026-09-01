import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dwc, mountInDwc, resetDwc, setConnected } from "dwc-plugin-test-kit";

import BackupManager from "../src/components/BackupManager.vue";
import CompareFiles from "../src/components/CompareFiles.vue";
import DiffPreview from "../src/components/DiffPreview.vue";
import FileInspector from "../src/components/FileInspector.vue";
import GcodeBrowser from "../src/components/GcodeBrowser.vue";
import PostProcessorPage from "../src/components/PostProcessorPage.vue";
import PostProcessorWidget from "../src/components/PostProcessorWidget.vue";
import RecipeEditor from "../src/components/RecipeEditor.vue";
import StepFields from "../src/components/StepFields.vue";
import { LARGE_FILE_WARN_BYTES } from "../src/model/constants";
import { createRecipe, newUid } from "../src/model/recipe";
import { defaultConfig, STEP_DEFINITIONS } from "../src/model/steps/registry";

// The shared test kit's file-listing stub (DwcFile) carries no `size` field, so a real
// createGateway().sizeOf() can never resolve to a non-null value under it — this mock is the only
// way to drive the large-file and target-exists warnings end to end. `download` defaults to
// rejecting, matching the real gateway's behaviour for a file that does not exist (e.g. no backup
// index has been written yet) — BackupManager's empty-state path depends on that rejection.
const sizeOfMock = vi.fn<(path: string) => Promise<number | null>>();
vi.mock("../src/dwc/gateway", () => ({
	createGateway: () => ({
		sizeOf: sizeOfMock,
		download: vi.fn().mockRejectedValue(new Error("No such file")),
		upload: vi.fn(),
		move: vi.fn(),
		remove: vi.fn(),
		makeDirectory: vi.fn(),
	}),
}));

describe("components mount", () => {
	beforeEach(() => {
		resetDwc();
		sizeOfMock.mockReset();
		sizeOfMock.mockResolvedValue(null);
	});

	it("mounts the page", () => {
		expect(mountInDwc(PostProcessorPage).exists()).toBe(true);
	});

	it("mounts the Flexible Layouts widget", () => {
		expect(mountInDwc(PostProcessorWidget).exists()).toBe(true);
	});

	it("mounts the browser", () => {
		expect(mountInDwc(GcodeBrowser).exists()).toBe(true);
	});

	it("mounts the compare view with nothing chosen yet", () => {
		const wrapper = mountInDwc(CompareFiles);
		expect(wrapper.text()).toContain("No file chosen");
		expect(wrapper.text()).toContain("Pick and analyse both files to see the comparison");
	});

	it("primes slot A from the page's own selection, and shows an error if analysis fails", async () => {
		setConnected(true);
		const wrapper = mountInDwc(CompareFiles, { props: { initialPath: "0:/gcodes/one.gcode" } });
		expect(wrapper.text()).toContain("0:/gcodes/one.gcode");
		const analyseButtons = wrapper.findAll("button").filter((b) => b.text().includes("Analyse"));
		expect(analyseButtons.length).toBeGreaterThan(0);
		await analyseButtons[0]!.trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("No such file");
	});

	it("mounts the backup manager and shows the empty state when there is no index yet", async () => {
		setConnected(true);
		const wrapper = mountInDwc(BackupManager);
		await flushPromises();
		expect(wrapper.text()).toContain("No backups yet");
	});

	it("shows a not-connected message rather than the empty state when disconnected", () => {
		setConnected(false);
		const wrapper = mountInDwc(BackupManager);
		expect(wrapper.text()).toContain("Not connected");
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

	// Every step's HelpTip (the runtime's shared hover-tip component) has to actually render for
	// every step type, not just the one exercised above — a self-maintaining loop, like the
	// StepFields "renders every step's form" test, so a step added later is covered automatically.
	it.each(STEP_DEFINITIONS.map((d) => [d.id, d] as const))("renders %s's HelpTip with its own text", (id, definition) => {
		const recipe = {
			...createRecipe("Test"),
			steps: [{ uid: newUid(), type: id, enabled: true, config: defaultConfig(id) }],
		};
		const wrapper = mountInDwc(RecipeEditor, {
			props: { recipe, recipes: [recipe], scriptsTrusted: false },
		});
		const labels = wrapper.findAll("[aria-label]").map((el) => el.attributes("aria-label"));
		expect(labels).toContain(definition.tip);
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

describe("PostProcessorPage safety warnings", () => {
	// This Node/happy-dom combination's global `localStorage` is a non-functional stub (confirmed:
	// `localStorage.setItem` is `undefined`), which is exactly why every real localStorage access in
	// this codebase is wrapped in try/catch. So file selection here is driven through GcodeBrowser's
	// v-model — the same path a real file pick takes — rather than by seeding LS_SELECTED_FILE.
	beforeEach(() => {
		resetDwc();
		sizeOfMock.mockReset();
		sizeOfMock.mockResolvedValue(null);

		// The test kit's settings stub doesn't implement registerPluginData/setPluginData, so
		// recipeStore falls back to real `localStorage` — a non-functional stub in this
		// Node/happy-dom combination (confirmed: `localStorage.setItem` is `undefined`), which
		// silently no-ops every save. Fill in the per-board path with the same reactive
		// `dwc.settings.plugins` bag a real DWC would expose, so recipes created in a test are
		// actually visible to the page's own `useRecipes()` call.
		const settings = dwc.settings as Record<string, unknown> & { plugins: Record<string, unknown> };
		settings.plugins = {};
		(settings as Record<string, unknown>).registerPluginData = (plugin: string, key: string, value: unknown) => {
			const bag = (settings.plugins[plugin] ?? {}) as Record<string, unknown>;
			if (!(key in bag)) settings.plugins[plugin] = { ...bag, [key]: value };
		};
		(settings as Record<string, unknown>).setPluginData = (plugin: string, key: string, value: unknown) => {
			settings.plugins[plugin] = { ...(settings.plugins[plugin] as Record<string, unknown> ?? {}), [key]: value };
		};
	});

	async function selectFile(wrapper: ReturnType<typeof mountInDwc>, path: string): Promise<void> {
		await wrapper.findComponent(GcodeBrowser).vm.$emit("update:modelValue", path);
		await flushPromises();
	}

	// The safety-warning computeds only run once a recipe is active — recipes now start empty
	// (no recipe is pre-seeded on first load), so these tests create one themselves rather than
	// relying on a default that used to be seeded for them.
	async function addRecipe(wrapper: ReturnType<typeof mountInDwc>): Promise<void> {
		await wrapper.findComponent(RecipeEditor).vm.$emit("add");
		await flushPromises();
	}

	// A defect this guards against: the large-file warning previously only appeared after a full
	// run had already paid the cost it was meant to warn about — see docs/tasks/01-defects.md
	it("shows the large-file warning as soon as a big file is selected, before either button is pressed", async () => {
		sizeOfMock.mockResolvedValue(LARGE_FILE_WARN_BYTES + 1);
		setConnected(true);

		const wrapper = mountInDwc(PostProcessorPage);
		await addRecipe(wrapper);
		await selectFile(wrapper, "0:/gcodes/big.gcode");

		expect(sizeOfMock).toHaveBeenCalledWith("0:/gcodes/big.gcode");
		expect(wrapper.text()).toMatch(/will take a while|leave the tab open|MiB|GiB/i);
	});

	it("shows no size warning for a small file", async () => {
		sizeOfMock.mockResolvedValue(1024);
		setConnected(true);

		const wrapper = mountInDwc(PostProcessorPage);
		await addRecipe(wrapper);
		await selectFile(wrapper, "0:/gcodes/small.gcode");

		expect(wrapper.text()).not.toMatch(/leave the tab open/i);
	});

	it("does not carry one file's warning over to a different selection", async () => {
		sizeOfMock.mockImplementation(async (path: string) => (
			path === "0:/gcodes/big.gcode" ? LARGE_FILE_WARN_BYTES + 1 : 1024
		));
		setConnected(true);

		const wrapper = mountInDwc(PostProcessorPage);
		await addRecipe(wrapper);
		await selectFile(wrapper, "0:/gcodes/big.gcode");
		expect(wrapper.text()).toMatch(/leave the tab open/i);

		// Switching to the small file must clear the warning, not just add a second one
		await selectFile(wrapper, "0:/gcodes/small.gcode");
		expect(wrapper.text()).not.toMatch(/leave the tab open/i);
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
		// Every visible field should render some kind of input — a step with no configurable
		// fields at all (e.g. rewriteTime, which just reads the machine's own limits) has none
		if (definition.fields.length > 0) {
			expect(wrapper.findAll("input, textarea, select").length).toBeGreaterThan(0);
		}
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

	// Regression test for a real defect: the number field was bound straight to `config[field.key]`,
	// which round-trips every keystroke through `Number(...)` and back. `Number("0.")` is `0`, which
	// redisplays as `"0"` — so a real user typing "0.05" into the arc-welder's "Resolution" field one
	// key at a time (default 0.05) never got past "0": each new character landed after whatever the
	// field had just been silently reverted to, not after what they actually typed, and the field
	// ended up holding "5" instead of "0.05" by the time they were done. This mirrors what actually
	// happens in the app: StepFields is a controlled component, and its parent (RecipeEditor) always
	// echoes the emitted config straight back down as the next `config` prop — so the test does too,
	// typing each new character onto whatever the DOM is currently showing rather than onto the
	// string the test itself intended, which is what makes this fail on the old binding and pass on
	// the fixed one.
	it("keeps what was typed on screen while building up a decimal that starts with 0", async () => {
		const definition = STEP_DEFINITIONS.find((d) => d.id === "arcWeld")!;
		let config = defaultConfig("arcWeld");
		const wrapper = mountInDwc(StepFields, { props: { definition, config } });
		const numeric = wrapper.findAll("input").find((i) => i.attributes("type") === "number")!;
		expect(numeric).toBeDefined();

		async function pressKey(key: string): Promise<void> {
			const current = (numeric!.element as HTMLInputElement).value;
			await numeric!.setValue(current + key);
			const emitted = wrapper.emitted("update:config")!;
			config = emitted[emitted.length - 1][0] as Record<string, unknown>;
			await wrapper.setProps({ config });
		}

		await numeric!.setValue("");
		for (const key of ["0", ".", "0", "5"]) await pressKey(key);

		expect((numeric.element as HTMLInputElement).value).toBe("0.05");
		expect(config.resolutionMm).toBe(0.05);
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
