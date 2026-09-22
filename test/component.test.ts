import { defineComponent, h, nextTick } from "vue";
import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { dwc, mountInDwc, resetDwc, setConnected } from "dwc-plugin-test-kit";

import BackupManager from "../src/components/BackupManager.vue";
import BatchDialog from "../src/components/BatchDialog.vue";
import CompareFiles from "../src/components/CompareFiles.vue";
import DiffPreview from "../src/components/DiffPreview.vue";
import FileInspector from "../src/components/FileInspector.vue";
import GcodeBrowser from "../src/components/GcodeBrowser.vue";
import GcodeEditor from "../src/components/GcodeEditor.vue";
import GcodeWorkspace from "../src/components/GcodeWorkspace.vue";
import PostProcessorPage from "../src/components/PostProcessorPage.vue";
import PostProcessorWidget from "../src/components/PostProcessorWidget.vue";
import RecipeEditor from "../src/components/RecipeEditor.vue";
import RunHistory from "../src/components/RunHistory.vue";
import StepFields from "../src/components/StepFields.vue";
import { resetEditorColorSettingsForTests } from "../src/dwc/editorColorSettings";
import { LARGE_FILE_WARN_BYTES } from "../src/model/constants";
import { createRecipe, newUid } from "../src/model/recipe";
import { defaultConfig, STEP_DEFINITIONS } from "../src/model/steps/registry";

// The shared test kit's file-listing stub (DwcFile) carries no `size` field, so a real
// createGateway().sizeOf() can never resolve to a non-null value under it — this mock is the only
// way to drive the large-file and target-exists warnings end to end. `download` defaults to
// rejecting, matching the real gateway's behaviour for a file that does not exist (e.g. no backup
// index has been written yet) — BackupManager's empty-state path depends on that rejection.
const sizeOfMock = vi.fn<(path: string) => Promise<number | null>>();
const downloadMock = vi.fn<(path: string, onProgress?: (loaded: number, total: number) => void) => Promise<Blob>>();
vi.mock("../src/dwc/gateway", () => ({
	createGateway: () => ({
		sizeOf: sizeOfMock,
		download: downloadMock,
		upload: vi.fn(),
		move: vi.fn(),
		remove: vi.fn(),
		makeDirectory: vi.fn(),
	}),
}));

// The color-settings feature talks to useMachineStore().download/upload directly (not through
// ../src/dwc/gateway, which is scoped to the plugin's own file-processing pipeline) - the test kit's
// own stub does not implement either (a documented gotcha across this plugin family), so this wraps
// the real stub with a tiny in-memory file store, keyed by filename, shared across the whole test file.
const colorFiles = new Map<string, string>();
vi.mock("@/stores/machine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/stores/machine")>();
	return {
		...actual,
		useMachineStore: () => {
			const real = actual.useMachineStore();
			return {
				...real,
				async download(options: { filename: string }) {
					const content = colorFiles.get(options.filename);
					if (content === undefined) throw new Error("not found");
					return content;
				},
				async upload(options: { filename: string; content: Blob }) {
					colorFiles.set(options.filename, await options.content.text());
				},
			};
		},
	};
});

const buildReportMock = vi.fn((opts: unknown) => opts);
const downloadReportMock = vi.fn();
const copyReportMock = vi.fn().mockResolvedValue(true);
vi.mock("dwc-plugin-runtime/diagnostics", () => ({
	buildReport: (opts: unknown) => buildReportMock(opts),
	downloadReport: (report: unknown) => downloadReportMock(report),
	copyReport: (report: unknown) => copyReportMock(report),
	recordError: vi.fn(),
}));

describe("components mount", () => {
	beforeEach(() => {
		resetDwc();
		sizeOfMock.mockReset();
		sizeOfMock.mockResolvedValue(null);
		downloadMock.mockReset();
		downloadMock.mockRejectedValue(new Error("No such file"));
		colorFiles.clear();
		resetEditorColorSettingsForTests();
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

	it("mounts the run history and shows the empty state when there is no index yet", async () => {
		setConnected(true);
		const wrapper = mountInDwc(RunHistory);
		await flushPromises();
		expect(wrapper.text()).toContain("No runs recorded yet");
	});

	it("run history shows a not-connected message rather than the empty state when disconnected", () => {
		setConnected(false);
		const wrapper = mountInDwc(RunHistory);
		expect(wrapper.text()).toContain("Not connected");
	});

	it("mounts the batch dialog and lists the given paths", () => {
		// v-dialog teleports its content to document.body (Vuetify's own <VOverlay>), which is
		// outside the tree wrapper.text() searches — read the body directly, the same way a real
		// open dialog is only found there
		const recipe = { ...createRecipe("Test"), steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: defaultConfig("findReplace") }] };
		const wrapper = mountInDwc(BatchDialog, {
			props: { modelValue: true, paths: ["0:/gcodes/a.gcode", "0:/gcodes/b.gcode"], recipe, scriptsTrusted: false },
		});
		expect(document.body.textContent).toContain("0:/gcodes/a.gcode");
		expect(document.body.textContent).toContain("0:/gcodes/b.gcode");
		expect(document.body.textContent).toContain("Batch process 2 files");
		wrapper.unmount();
	});

	it("mounts the inspector with nothing selected", () => {
		const wrapper = mountInDwc(FileInspector, { props: { path: null } });
		expect(wrapper.text()).toContain("Select a G-code file");
	});

	it("mounts the editor with nothing selected", () => {
		const wrapper = mountInDwc(GcodeEditor, { props: { path: null } });
		expect(wrapper.text()).toContain("Select a G-code file");
		wrapper.unmount();
	});

	it("loads a real file into a live CM6 editor and shows its content", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G28\nG1 X10 Y10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => {
			expect(wrapper.text()).toContain("G1 X10 Y10");
		});
		wrapper.unmount();
	});

	it("shows the line-state gutter once the (deferred) index finishes building", async () => {
		downloadMock.mockResolvedValueOnce(new Blob([";LAYER_CHANGE\n;Z:0.20\nG1 Z0.2 F600\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => {
			expect(wrapper.text()).toContain("G1 Z0.2 F600");
		});
		// The gutter's own build is deferred a tick past the editor mounting - wait for it too
		await vi.waitFor(() => {
			expect(wrapper.text()).toContain("L0");
			expect(wrapper.text()).toContain("Z0.20");
		});
		wrapper.unmount();
	});

	it("opens in dark mode when DWC's own darkTheme setting is already on", async () => {
		dwc.settings.darkTheme = true;
		downloadMock.mockResolvedValueOnce(new Blob(["G28\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		document.body.appendChild(wrapper.element); // getComputedStyle needs a connected element
		await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));

		const cmEditor = wrapper.find(".cm-editor");
		expect(cmEditor.exists()).toBe(true);
		const bg = getComputedStyle(cmEditor.element).backgroundColor;
		expect(bg).not.toBe(""); // oneDarkTheme's own background, not the browser default
		expect(bg).not.toBe("rgba(0, 0, 0, 0)");

		wrapper.unmount();
	});

	it("follows a live darkTheme toggle without reloading the file", async () => {
		dwc.settings.darkTheme = false;
		downloadMock.mockResolvedValueOnce(new Blob(["G28\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		document.body.appendChild(wrapper.element);
		await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));

		const cmEditor = wrapper.find(".cm-editor");
		const lightBg = getComputedStyle(cmEditor.element).backgroundColor;

		dwc.settings.darkTheme = true;
		await nextTick();
		const darkBg = getComputedStyle(cmEditor.element).backgroundColor;
		expect(darkBg).not.toBe(lightBg);
		expect(wrapper.text()).toContain("G28"); // same document - not a reload

		wrapper.unmount();
	});

	it("opens the search panel via the toolbar Search button", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X10\nG1 X20\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X20"));

		expect(wrapper.find(".cm-search").exists()).toBe(false);
		const searchBtn = wrapper.findAll("button").find((b) => b.attributes("title") === "Search (Ctrl+F)");
		await searchBtn!.trigger("click");
		expect(wrapper.find(".cm-search").exists()).toBe(true);
		wrapper.unmount();
	});

	it("the docs-link button follows the cursor onto whatever code it sits on", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G28\nM104 S200\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("M104"));

		const docsLink = () => wrapper.findAll("a").find((a) => a.attributes("title") === "G-code reference");
		// cursorCode only updates off a real dispatched transaction (the updateListener never fires
		// for the view's initial creation), so it starts at the base URL regardless of where the
		// initial selection sits, until the first real edit or selection change.
		expect(docsLink()!.attributes("href")).toBe("https://docs.duet3d.com/en/User_manual/Reference/Gcodes");

		const vm = wrapper.vm as unknown as { editorInstance: { view: EditorView } };
		vm.editorInstance.view.dispatch({ selection: { anchor: 1 } }); // inside "G28"
		await nextTick();
		expect(docsLink()!.attributes("href")).toBe("https://docs.duet3d.com/en/User_manual/Reference/Gcodes/G28");

		const m104Pos = vm.editorInstance.view.state.doc.toString().indexOf("M104") + 1;
		vm.editorInstance.view.dispatch({ selection: { anchor: m104Pos } });
		await nextTick();
		expect(docsLink()!.attributes("href")).toBe("https://docs.duet3d.com/en/User_manual/Reference/Gcodes/M104");

		// Move onto the blank end of the (comment-free) line - no command there at all.
		vm.editorInstance.view.dispatch({ selection: { anchor: vm.editorInstance.view.state.doc.length } });
		await nextTick();
		expect(docsLink()!.attributes("href")).toBe("https://docs.duet3d.com/en/User_manual/Reference/Gcodes");

		wrapper.unmount();
	});

	it("aligns comments via the toolbar button - a real column change, undoable as one step", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X10 ;short\nG1 X10 Y20 ;longer\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("longer"));

		const alignBtn = wrapper.findAll("button").find((b) => b.attributes("title") === "Align comments");
		await alignBtn!.trigger("click");
		await nextTick();
		// "G1 X10" pads out to "G1 X10 Y20"'s column (10 chars + 1) once aligned.
		expect(wrapper.text()).toContain("G1 X10     ;short");
		wrapper.unmount();
	});

	it("reverts to the loaded content and disables itself once clean again", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G28\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));

		const revertBtn = () => wrapper.findAll("button").find((b) => b.attributes("title") === "Revert");
		expect(revertBtn()!.attributes("disabled")).toBeDefined(); // nothing to revert yet

		const vm = wrapper.vm as unknown as { editorInstance: { view: EditorView } };
		vm.editorInstance.view.dispatch({ changes: { from: 3, insert: "\nG1 X10" } });
		await nextTick();
		expect(wrapper.text()).toContain("G1 X10");
		expect(revertBtn()!.attributes("disabled")).toBeUndefined(); // now dirty, revert is live

		await revertBtn()!.trigger("click");
		await nextTick();
		expect(vm.editorInstance.view.state.doc.toString()).toBe("G28\n");
		expect(revertBtn()!.attributes("disabled")).toBeDefined(); // clean again

		wrapper.unmount();
	});

	it("the quick-search button opens the G/M-code picker by default, titled Find Code (F4)", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));

		const quickSearchBtn = () => wrapper.findAll("button").find((b) => b.attributes("title")?.startsWith("Find "));
		expect(quickSearchBtn()!.attributes("title")).toBe("Find Code (F4)");
		await quickSearchBtn()!.trigger("click");
		expect(wrapper.find(".cm-gcodeQuickSearch").exists()).toBe(true);
		const input = wrapper.find(".cm-gcodeQuickSearch-input").element as HTMLInputElement;
		expect(input.placeholder).toMatch(/code/i);
		wrapper.unmount();
	});

	it("the quick-search button switches to Find Expression (F4) once the cursor sits inside a { expression", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X{move.axes[0]}\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("move.axes"));

		const vm = wrapper.vm as unknown as { editorInstance: { view: EditorView } };
		vm.editorInstance.view.dispatch({ selection: { anchor: 6 } }); // "G1 X{m|ove.axes[0]}" - inside the braces
		await nextTick();

		const quickSearchBtn = () => wrapper.findAll("button").find((b) => b.attributes("title")?.startsWith("Find "));
		expect(quickSearchBtn()!.attributes("title")).toBe("Find Expression (F4)");
		await quickSearchBtn()!.trigger("click");
		const input = wrapper.find(".cm-gcodeQuickSearch-input").element as HTMLInputElement;
		expect(input.placeholder).toMatch(/object-model/i);
		wrapper.unmount();
	});

	it("F4 itself opens the same quick-search picker", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));

		const vm = wrapper.vm as unknown as { editorInstance: { view: EditorView } };
		vm.editorInstance.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", bubbles: true, cancelable: true }));
		expect(wrapper.find(".cm-gcodeQuickSearch").exists()).toBe(true);
		wrapper.unmount();
	});

	it("the stepper toggle shows/hides the scrub bar panel", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G28\nG1 X10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));

		expect(wrapper.text()).not.toContain("Step 1 /");
		const stepperBtn = wrapper.findAll("button").find((b) => b.attributes("title") === "Step through file");
		await stepperBtn!.trigger("click");
		// The execution-order index (unlike the old flat one) has no synchronous line-count fallback -
		// it needs the deferred parse+walk to actually finish before "Step 1 / N" is real.
		await vi.waitFor(() => expect(wrapper.text()).toContain("Step 1 /"));

		await stepperBtn!.trigger("click");
		expect(wrapper.text()).not.toContain("Step 1 /");
		wrapper.unmount();
	});

	it("stepping forward highlights the next line and shows its derived state", async () => {
		// T0 must be its own command token (a bare "T0" parameter on a G1 line is not valid RRF
		// syntax and state.ts's own tool tracking only fires on a real T-letter command).
		downloadMock.mockResolvedValueOnce(new Blob([";LAYER_CHANGE\nT0\nG1 X10 Y10 F1200\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10 Y10 F1200"));
		// The line-state index build is deferred a tick past mounting (see GcodeEditor.vue's own
		// comment on this) - the stepper's readout depends on it the same way the gutter test above does.
		await vi.waitFor(() => expect(wrapper.text()).toContain("L0")); // gutter proves the index is ready

		await wrapper.findAll("button").find((b) => b.attributes("title") === "Step through file")!.trigger("click");
		// The execution-order index is a second, separately-deferred build (see GcodeEditor.vue's own
		// comment) - wait for it too, not just the gutter's lineIndex, before driving the stepper.
		await vi.waitFor(() => expect(wrapper.text()).toContain("Step 1 / 3"));
		expect(wrapper.find(".cm-gcodeCurrentLine").exists()).toBe(true);
		expect(wrapper.find(".cm-gcodeCurrentLine").text()).toContain(";LAYER_CHANGE");

		const stepForward = () => wrapper.findAll("button").find((b) => b.attributes("title") === "Step forward");
		await stepForward()!.trigger("click");
		await stepForward()!.trigger("click");
		expect(wrapper.find(".cm-gcodeCurrentLine").text()).toContain("G1 X10 Y10 F1200");
		expect(wrapper.text()).toContain("Layer 0");
		expect(wrapper.text()).toContain("X10.00");
		expect(wrapper.text()).toContain("Y10.00");
		expect(wrapper.text()).toContain("Tool 0");
		expect(wrapper.text()).toContain("F1200");
		wrapper.unmount();
	});

	it("step back and forward are disabled at the file's own bounds", async () => {
		// No trailing newline: a Text built from a string ending in "\n" has an extra, empty final
		// line after it (verified directly, not assumed - see dwc-gcode-editor's own currentLine.ts
		// tests for the same real CM6 behaviour) - this fixture's true last line is "G1 X10" itself.
		downloadMock.mockResolvedValueOnce(new Blob(["G28\nG1 X10"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));
		await wrapper.findAll("button").find((b) => b.attributes("title") === "Step through file")!.trigger("click");
		await vi.waitFor(() => expect(wrapper.text()).toContain("Step 1 / 2"));

		const stepBack = () => wrapper.findAll("button").find((b) => b.attributes("title") === "Step back");
		const stepForward = () => wrapper.findAll("button").find((b) => b.attributes("title") === "Step forward");
		expect(stepBack()!.attributes("disabled")).toBeDefined(); // already at line 1

		await stepForward()!.trigger("click");
		expect(stepForward()!.attributes("disabled")).toBeDefined(); // now at the last line (2)
		expect(stepBack()!.attributes("disabled")).toBeUndefined();
		wrapper.unmount();
	});

	it("closing the stepper clears the current-line highlight", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G28\nG1 X10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));

		const stepperBtn = wrapper.findAll("button").find((b) => b.attributes("title") === "Step through file");
		await stepperBtn!.trigger("click");
		expect(wrapper.find(".cm-gcodeCurrentLine").exists()).toBe(true);
		await stepperBtn!.trigger("click");
		expect(wrapper.find(".cm-gcodeCurrentLine").exists()).toBe(false);
		wrapper.unmount();
	});

	it("a blocking M291 (OK box) pauses the walk with a prompt, and clicking OK continues", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(['G28\nM291 P"Ready?" R"Confirm" S2\nG1 X10\n']));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));
		await wrapper.findAll("button").find((b) => b.attributes("title") === "Step through file")!.trigger("click");
		await vi.waitFor(() => expect(wrapper.text()).toContain("Confirm"));
		expect(wrapper.text()).toContain("Ready?");

		const okBtn = wrapper.findAll("button").find((b) => b.text() === "OK");
		expect(okBtn).toBeDefined();
		await okBtn!.trigger("click");

		await vi.waitFor(() => expect(wrapper.text()).toContain("Step 1 / 3"));
		// The prompt's own OK button is gone (the answer is now only a removable chip - "Ready?"
		// legitimately still appears there, e.g. "Message box answers: Ready? → OK").
		expect(wrapper.findAll("button").find((b) => b.text() === "OK")).toBeUndefined();
		wrapper.unmount();
	});

	it("a blocking M291 value box (S5) validates the input and its answer reaches 'input' on a later line", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(['M291 P"How many?" S5 L0 H10\nif input > 3\n    G1 X1\nG1 Y1\n']));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 Y1"));
		await wrapper.findAll("button").find((b) => b.attributes("title") === "Step through file")!.trigger("click");
		await vi.waitFor(() => expect(wrapper.text()).toContain("How many?"));

		const submitBtn = () => wrapper.findAll("button").find((b) => b.text() === "Submit");
		expect(submitBtn()!.attributes("disabled")).toBeDefined(); // nothing typed yet

		const input = wrapper.find('input[placeholder^="number"]');
		expect(input.exists()).toBe(true);
		await input.setValue("15"); // out of the H10 bound
		expect(submitBtn()!.attributes("disabled")).toBeDefined();

		await input.setValue("7");
		expect(submitBtn()!.attributes("disabled")).toBeUndefined();
		await submitBtn()!.trigger("click");

		await vi.waitFor(() => expect(wrapper.text()).toContain("Step 1 / 4"));
		wrapper.unmount();
	});

	it("cancelling an OK/Cancel M291 aborts the walk, matching RRF's own default", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(['G28\nM291 P"Continue?" S3\nG1 X10\n']));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));
		await wrapper.findAll("button").find((b) => b.attributes("title") === "Step through file")!.trigger("click");
		await vi.waitFor(() => expect(wrapper.text()).toContain("Continue?"));

		await wrapper.findAll("button").find((b) => b.text() === "Cancel")!.trigger("click");

		await vi.waitFor(() => expect(wrapper.text()).toContain("Step 1 / 2")); // only G28 + the M291 line itself
		expect(wrapper.findAll("button").find((b) => b.text() === "Cancel")).toBeUndefined();
		wrapper.unmount();
	});

	it("switching to a different file resets the stepper back to line 1", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G28\nG1 X10\nG1 X20\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/a.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X20"));
		await wrapper.findAll("button").find((b) => b.attributes("title") === "Step through file")!.trigger("click");
		await vi.waitFor(() => expect(wrapper.text()).toContain("Step 1 / 3"));
		await wrapper.findAll("button").find((b) => b.attributes("title") === "Step forward")!.trigger("click");
		expect(wrapper.text()).toContain("Step 2 /");

		downloadMock.mockResolvedValueOnce(new Blob(["G28\nG1 X99\n"]));
		await wrapper.setProps({ path: "0:/gcodes/b.g" });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X99"));
		await vi.waitFor(() => expect(wrapper.text()).toContain("Step 1 /"));
		wrapper.unmount();
	});

	it("opens the color settings dialog via the toolbar button", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));

		const settingsBtn = wrapper.findAll("button").find((b) => b.attributes("title") === "Editor colors");
		await settingsBtn!.trigger("click");
		expect(document.body.textContent).toContain("Editor colors");
		expect(document.body.textContent).toContain("0:/sys/dwc-gcode-editor.colors.json");
		// One color input per category, for the initially-shown Light tab.
		expect(document.body.querySelectorAll("input[type=color]").length).toBe(10);
		wrapper.unmount();
	});

	it("Save persists the scheme to the SD card and applies it live to the same instance", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		document.body.appendChild(wrapper.element); // getComputedStyle needs a connected element
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));

		await wrapper.findAll("button").find((b) => b.attributes("title") === "Editor colors")!.trigger("click");
		const bgInput = document.body.querySelector("#gcode-editor-color-background") as HTMLInputElement;
		bgInput.value = "#123456";
		bgInput.dispatchEvent(new Event("input", { bubbles: true }));

		const saveBtn = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Save");
		saveBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await flushPromises();

		expect(colorFiles.get("0:/sys/dwc-gcode-editor.colors.json")).toContain("#123456");
		const cmEditor = wrapper.find(".cm-editor");
		expect(getComputedStyle(cmEditor.element).backgroundColor).toBe("#123456");
		wrapper.unmount();
	});

	it("Cancel closes the dialog without persisting or applying anything", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));

		await wrapper.findAll("button").find((b) => b.attributes("title") === "Editor colors")!.trigger("click");
		const bgInput = document.body.querySelector("#gcode-editor-color-background") as HTMLInputElement;
		bgInput.value = "#123456";
		bgInput.dispatchEvent(new Event("input", { bubbles: true }));

		const cancelBtn = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Cancel");
		cancelBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await flushPromises();

		expect(colorFiles.size).toBe(0);
		wrapper.unmount();
	});

	it("Reset to defaults resets the visible color inputs", async () => {
		downloadMock.mockResolvedValueOnce(new Blob(["G1 X10\n"]));
		const wrapper = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/sample.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G1 X10"));

		await wrapper.findAll("button").find((b) => b.attributes("title") === "Editor colors")!.trigger("click");
		const bgInput = document.body.querySelector("#gcode-editor-color-background") as HTMLInputElement;
		const originalDefault = bgInput.value;
		bgInput.value = "#123456";
		bgInput.dispatchEvent(new Event("input", { bubbles: true }));
		await nextTick();
		expect(bgInput.value).toBe("#123456");

		const resetBtn = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Reset to defaults");
		resetBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await nextTick();
		expect(bgInput.value).toBe(originalDefault);
		wrapper.unmount();
	});

	it("a saved scheme applies live to a DIFFERENT already-open editor instance, not just the one that saved it", async () => {
		downloadMock.mockResolvedValue(new Blob(["G1 X10\n"]));
		const a = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/a.g" } });
		document.body.appendChild(a.element);
		await vi.waitFor(() => expect(a.text()).toContain("G1 X10"));
		const b = mountInDwc(GcodeEditor, { props: { path: "0:/gcodes/b.g" } });
		document.body.appendChild(b.element);
		await vi.waitFor(() => expect(b.text()).toContain("G1 X10"));

		await a.findAll("button").find((btn) => btn.attributes("title") === "Editor colors")!.trigger("click");
		const bgInput = document.body.querySelector("#gcode-editor-color-background") as HTMLInputElement;
		bgInput.value = "#654321";
		bgInput.dispatchEvent(new Event("input", { bubbles: true }));
		const saveBtn = Array.from(document.body.querySelectorAll("button")).find((btn) => btn.textContent?.trim() === "Save");
		saveBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await flushPromises();

		const bCmEditor = b.find(".cm-editor");
		expect(getComputedStyle(bCmEditor.element).backgroundColor).toBe("#654321");
		a.unmount();
		b.unmount();
	});

	it("mounts the workspace with nothing selected", () => {
		const wrapper = mountInDwc(GcodeWorkspace, { props: { selectedPath: null } });
		expect(wrapper.text()).toContain("Select a G-code file");
		wrapper.unmount();
	});

	it("opens the initially-selected file with no tab strip shown for just one tab", async () => {
		downloadMock.mockResolvedValue(new Blob(["G28\n"]));
		const wrapper = mountInDwc(GcodeWorkspace, { props: { selectedPath: "0:/gcodes/a.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));
		expect(wrapper.findAllComponents({ name: "VTab" }).length).toBe(0);
		wrapper.unmount();
	});

	it("opens a second tab for a different file, keeping the first mounted", async () => {
		downloadMock.mockResolvedValue(new Blob(["G28\n"]));
		const wrapper = mountInDwc(GcodeWorkspace, { props: { selectedPath: "0:/gcodes/a.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));

		await wrapper.setProps({ selectedPath: "0:/gcodes/b.g" });
		await vi.waitFor(() => expect(wrapper.text()).toContain("b.g"));
		expect(wrapper.text()).toContain("a.g");
		wrapper.unmount();
	});

	it("re-selecting an already-open file focuses it rather than opening a duplicate tab", async () => {
		downloadMock.mockResolvedValue(new Blob(["G28\n"]));
		const wrapper = mountInDwc(GcodeWorkspace, { props: { selectedPath: "0:/gcodes/a.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));

		await wrapper.setProps({ selectedPath: "0:/gcodes/b.g" });
		await vi.waitFor(() => expect(wrapper.text()).toContain("b.g"));

		await wrapper.setProps({ selectedPath: "0:/gcodes/a.g" });
		await wrapper.vm.$nextTick();
		const tabs = wrapper.findAll(".v-tab").map((t) => t.text());
		expect(tabs.filter((t) => t.includes("a.g"))).toHaveLength(1);
		wrapper.unmount();
	});

	it("closing one of two tabs drops back to a single, strip-less tab", async () => {
		downloadMock.mockResolvedValue(new Blob(["G28\n"]));
		const wrapper = mountInDwc(GcodeWorkspace, { props: { selectedPath: "0:/gcodes/a.g" } });
		await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));
		await wrapper.setProps({ selectedPath: "0:/gcodes/b.g" });
		await vi.waitFor(() => expect(wrapper.text()).toContain("b.g"));

		const closeBtn = wrapper.findAll("button").find((b) => b.attributes("title")?.includes("Close b.g"));
		expect(closeBtn).toBeDefined();
		await closeBtn!.trigger("click");
		await wrapper.vm.$nextTick();
		expect(wrapper.text()).not.toContain("b.g");
		expect(wrapper.findAllComponents({ name: "VTab" }).length).toBe(0); // back to one tab, strip hidden
		wrapper.unmount();
	});

	describe("split view", () => {
		async function openTwoTabs(): Promise<ReturnType<typeof mountInDwc>> {
			downloadMock.mockResolvedValue(new Blob(["G28\n"]));
			const wrapper = mountInDwc(GcodeWorkspace, { props: { selectedPath: "0:/gcodes/a.g" } });
			await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));
			await wrapper.setProps({ selectedPath: "0:/gcodes/b.g" });
			await vi.waitFor(() => expect(wrapper.text()).toContain("b.g"));
			return wrapper;
		}

		it("Split right moves the active tab into a second pane, both editors visible", async () => {
			const wrapper = await openTwoTabs();
			const splitBtn = wrapper.findAll("button").find((b) => b.attributes("title") === "Split right");
			expect(splitBtn).toBeDefined();
			await splitBtn!.trigger("click");
			await wrapper.vm.$nextTick();

			expect(wrapper.text()).toContain("a.g");
			expect(wrapper.text()).toContain("b.g");
			const closeSplitBtn = wrapper.findAll("button").find((b) => b.attributes("title") === "Close split");
			expect(closeSplitBtn).toBeDefined();
			wrapper.unmount();
		});

		it("Close split merges the second pane's tab back into one strip", async () => {
			const wrapper = await openTwoTabs();
			await wrapper.findAll("button").find((b) => b.attributes("title") === "Split right")!.trigger("click");
			await wrapper.vm.$nextTick();

			const closeSplitBtn = wrapper.findAll("button").find((b) => b.attributes("title") === "Close split");
			await closeSplitBtn!.trigger("click");
			await wrapper.vm.$nextTick();

			expect(wrapper.findAll("button").find((b) => b.attributes("title") === "Close split")).toBeUndefined();
			expect(wrapper.text()).toContain("a.g");
			expect(wrapper.text()).toContain("b.g");
			wrapper.unmount();
		});

		it("Split right is disabled with only one tab open", async () => {
			downloadMock.mockResolvedValue(new Blob(["G28\n"]));
			const wrapper = mountInDwc(GcodeWorkspace, { props: { selectedPath: "0:/gcodes/a.g" } });
			await vi.waitFor(() => expect(wrapper.text()).toContain("G28"));
			// The tab strip (and its Split right button) only renders with 2+ tabs to begin with
			expect(wrapper.findAll("button").find((b) => b.attributes("title") === "Split right")).toBeUndefined();
			wrapper.unmount();
		});

		it("dragging a tab onto the other pane moves it there", async () => {
			const wrapper = await openTwoTabs();
			await wrapper.findAll("button").find((b) => b.attributes("title") === "Split right")!.trigger("click");
			await wrapper.vm.$nextTick();
			// After splitRight(), the active tab (b.g) moved to the secondary pane; a.g stays primary
			const dropTargets = wrapper.findAll(".gcode-workspace-body");
			expect(dropTargets.length).toBe(2);

			// Drag a.g (tab id 1, opened first) from the primary pane onto the secondary pane's body
			await dropTargets[1].trigger("drop", { dataTransfer: { getData: () => "1" } });
			await wrapper.vm.$nextTick();

			// Both files must now be in the SAME (secondary) pane's tab strip
			const secondaryPaneTabs = dropTargets[1].element.closest(".gcode-workspace-pane")?.querySelectorAll(".v-tab");
			expect(secondaryPaneTabs?.length).toBe(2);
			wrapper.unmount();
		});

		it("persists the split ratio to localStorage on drag release", async () => {
			// This harness's happy-dom `localStorage` is a non-functional stub (documented
			// elsewhere in this file and in src/__tests__/autoRun.test.ts) - a scoped in-memory
			// stand-in, restored at the end of this one test, is the only way to exercise this.
			const memoryStorage = new Map<string, string>();
			vi.stubGlobal("localStorage", {
				getItem: (key: string) => memoryStorage.get(key) ?? null,
				setItem: (key: string, value: string) => { memoryStorage.set(key, value); },
				removeItem: (key: string) => { memoryStorage.delete(key); },
			});

			try {
				const wrapper = await openTwoTabs();
				await wrapper.findAll("button").find((b) => b.attributes("title") === "Split right")!.trigger("click");
				await wrapper.vm.$nextTick();

				const divider = wrapper.find(".gcode-workspace-divider");
				expect(divider.exists()).toBe(true);
				vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => {});
				// A non-zero `left` matters here: it is what proves the ratio is computed relative
				// to the container's own position, not the raw viewport X coordinate.
				vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
					{ left: 40, right: 440, top: 0, bottom: 100, width: 400, height: 100, x: 40, y: 0, toJSON() { } } as DOMRect,
				);

				await divider.trigger("pointerdown", { pointerId: 1 });
				await divider.trigger("pointermove", { pointerId: 1, clientX: 140 }); // (140-40)/400 = 25%
				await divider.trigger("pointerup", { pointerId: 1 });

				expect(memoryStorage.get("gCodePostProcessor.edit.splitRatio")).toBe("0.25");
				wrapper.unmount();
			} finally {
				vi.unstubAllGlobals();
				vi.restoreAllMocks();
			}
		});
	});

	it("mounts the diff preview with no run yet", () => {
		const wrapper = mountInDwc(DiffPreview, {
			props: { result: null, recipe: null, sourceName: "" },
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
		downloadMock.mockReset();
		downloadMock.mockRejectedValue(new Error("No such file"));

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

describe("PostProcessorPage diagnostics report (F4)", () => {
	beforeEach(() => {
		resetDwc();
		sizeOfMock.mockReset();
		sizeOfMock.mockResolvedValue(null);
		downloadMock.mockReset();
		downloadMock.mockRejectedValue(new Error("No such file"));
		buildReportMock.mockClear();
		downloadReportMock.mockClear();
		copyReportMock.mockClear();

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

	it("offers Download and Copy diagnostics from the About dialog, and the report state carries the recipe and path but not the diff", async () => {
		setConnected(true);
		const wrapper = mountInDwc(PostProcessorPage);
		await wrapper.findComponent(RecipeEditor).vm.$emit("add");
		await flushPromises();
		await wrapper.findComponent(GcodeBrowser).vm.$emit("update:modelValue", "0:/gcodes/part.gcode");
		await flushPromises();

		await wrapper.find('[title="About"]').trigger("click");
		await flushPromises();

		const buttons = Array.from(document.body.querySelectorAll("button")) as Array<HTMLButtonElement>;
		const download = buttons.find((b) => (b.textContent ?? "").includes("Download diagnostics"));
		const copy = buttons.find((b) => (b.textContent ?? "").includes("Copy diagnostics"));
		expect(download).toBeDefined();
		expect(copy).toBeDefined();

		download!.click();
		await flushPromises();

		expect(downloadReportMock).toHaveBeenCalledTimes(1);
		const opts = buildReportMock.mock.calls.at(-1)![0] as { state: Record<string, unknown> };
		expect(opts.state).toHaveProperty("recipe");
		expect(opts.state.recipe).not.toBeNull();
		expect(opts.state.selectedPath).toBe("0:/gcodes/part.gcode");
		expect(Object.keys(opts.state)).not.toContain("diff");
		expect(JSON.stringify(opts.state)).not.toContain("scriptsTrusted\":true");

		wrapper.unmount();
	});
});

describe("responsive layout (F6)", () => {
	beforeEach(() => {
		resetDwc();
		sizeOfMock.mockReset();
		sizeOfMock.mockResolvedValue(null);
		downloadMock.mockReset();
		downloadMock.mockRejectedValue(new Error("No such file"));
		setDisplayWidth(1200);
	});

	function setDisplayWidth(width: number): void {
		(window as unknown as { innerWidth: number }).innerWidth = width;
		window.dispatchEvent(new Event("resize"));
	}

	it("useBreakpoint reacts to a window resize (the stop point outcome)", async () => {
		const { useBreakpoint } = await import("../src/dwc/useBreakpoint");
		let bp!: ReturnType<typeof useBreakpoint>;
		const probe = defineComponent({
			setup() { bp = useBreakpoint(); return () => h("div"); },
		});
		mountInDwc(probe);
		setDisplayWidth(1400);
		await nextTick();
		expect(bp.xs.value).toBe(false);
		expect(bp.mobile.value).toBe(false);

		setDisplayWidth(400);
		await nextTick();
		expect(bp.xs.value).toBe(true);
		expect(bp.mobile.value).toBe(true);
		expect(bp.controlDensity.value).toBe("compact"); // largeButtons undefined in the test settings bag
	});

	// Asserts the actual swap, not just that a title exists — the titles are unconditional, so a test
	// that only checked for them would pass at any width and catch nothing
	it("collapses the toolbar actions to icons at xs, and keeps their titles so nothing vanishes", async () => {
		setDisplayWidth(1400);
		await nextTick();
		const wide = mountInDwc(PostProcessorPage);
		await nextTick();
		const wideApply = wide.findAll("button").find((b) => b.attributes("title") === "Apply");
		expect(wideApply).toBeDefined();
		expect(wideApply!.text()).toContain("Apply");

		setDisplayWidth(400);
		await nextTick();
		const narrow = mountInDwc(PostProcessorPage);
		await nextTick();
		const narrowApply = narrow.findAll("button").find((b) => b.attributes("title") === "Apply");
		expect(narrowApply).toBeDefined();
		// Icon-only: the label is gone from the DOM, but the control (and its title) is still there
		expect(narrowApply!.text()).not.toContain("Apply");
		expect(narrowApply!.classes().join(" ")).toContain("v-btn--icon");
	});

});

describe("PostProcessorPage preflight gate (E13)", () => {
	beforeEach(() => {
		resetDwc();
		sizeOfMock.mockReset();
		sizeOfMock.mockResolvedValue(null);
		downloadMock.mockReset();
		downloadMock.mockRejectedValue(new Error("No such file"));
		setConnected(true);

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

	async function setup(gateOn: boolean) {
		const { usePluginSettings } = await import("../src/dwc/pluginSettings");
		const wrapper = mountInDwc(PostProcessorPage);
		if (gateOn) {
			// Flip the per-board setting through the same store the page reads
			usePluginSettings().setPreflightGate(true);
			await nextTick();
		}
		await wrapper.findComponent(RecipeEditor).vm.$emit("add");
		await flushPromises();
		await wrapper.findComponent(GcodeBrowser).vm.$emit("update:modelValue", "0:/gcodes/part.gcode");
		await flushPromises();
		// Open the Inspect tab so FileInspector mounts, then hand it an analysis with an error
		const tabs = wrapper.findAll(".v-tab");
		const inspectTab = tabs.find((t) => t.text().includes("Inspect"));
		await inspectTab!.trigger("click");
		await flushPromises();
		return { wrapper };
	}

	/** The shape FileInspector now emits: the merged check list plus the path it belongs to. */
	const ERROR_CHECK = { level: "error" as const, code: "unsupported:M900", title: "M900 is not supported by RepRapFirmware", detail: "Seen 1 time." };
	const MACRO_ERROR = { level: "error" as const, code: "macro:missing", title: "start.g is not on the SD card", detail: "M98 calls it." };

	function applyButton(wrapper: ReturnType<typeof mountInDwc>) {
		return wrapper.findAll("button").find((b) => (b.attributes("title") ?? "") === "Apply"
			|| b.text().trim() === "Apply");
	}

	it("blocks Apply and names the check when the gate is on and preflight has an error", async () => {
		const { wrapper } = await setup(true);
		wrapper.findComponent(FileInspector).vm.$emit("checked", [ERROR_CHECK], "0:/gcodes/part.gcode");
		await flushPromises();
		expect(applyButton(wrapper)!.attributes("disabled")).toBeDefined();
		expect(wrapper.text()).toMatch(/Preflight found/i);
	});

	// The macro check is asynchronous and lands after the analysis, so it used to be invisible to the
	// gate even though the Inspect tab (and docs/usage.md) call it an Error
	it("blocks on an error the asynchronous macro check contributes, not just the synchronous ones", async () => {
		const { wrapper } = await setup(true);
		const inspector = wrapper.findComponent(FileInspector);
		inspector.vm.$emit("checked", [], "0:/gcodes/part.gcode");
		await flushPromises();
		// Inspected and clean: neither blocked nor nagged
		expect(wrapper.text()).not.toMatch(/Preflight found/i);
		expect(wrapper.text()).not.toMatch(/has not been inspected yet/i);

		inspector.vm.$emit("checked", [MACRO_ERROR], "0:/gcodes/part.gcode");
		await flushPromises();
		expect(wrapper.text()).toMatch(/Preflight found/i);
		expect(applyButton(wrapper)!.attributes("disabled")).toBeDefined();
	});

	// An inspection of a large file takes tens of seconds; if the selection moves on while it runs,
	// its verdict must not be recorded against the file the user is now looking at
	it("ignores a verdict that arrives for a file that is no longer selected", async () => {
		const { wrapper } = await setup(true);
		wrapper.findComponent(FileInspector).vm.$emit("checked", [ERROR_CHECK], "0:/gcodes/some-other-file.gcode");
		await flushPromises();
		expect(wrapper.text()).not.toMatch(/Preflight found/i);
		expect(wrapper.text()).toMatch(/has not been inspected yet/i);
	});

	it("does not block Apply when the same analysis comes in but the gate is off", async () => {
		const { wrapper } = await setup(false);
		wrapper.findComponent(FileInspector).vm.$emit("checked", [ERROR_CHECK], "0:/gcodes/part.gcode");
		await flushPromises();
		// Apply is governed only by the normal safety layer now — not by preflight
		expect(wrapper.text()).not.toMatch(/Preflight found/i);
	});

	it("does not block Apply when the gate is on but the file has not been inspected, and says so", async () => {
		const { wrapper } = await setup(true);
		// No `checked` emitted — file never inspected
		await flushPromises();
		expect(wrapper.text()).toMatch(/has not been inspected yet/i);
		// The gate does not hard-block an un-inspected file
		expect(wrapper.text()).not.toMatch(/Preflight found/i);
	});

	it("clears the previous file's preflight result when the selection changes", async () => {
		const { wrapper } = await setup(true);
		wrapper.findComponent(FileInspector).vm.$emit("checked", [ERROR_CHECK], "0:/gcodes/part.gcode");
		await flushPromises();
		expect(wrapper.text()).toMatch(/Preflight found/i);

		await wrapper.findComponent(GcodeBrowser).vm.$emit("update:modelValue", "0:/gcodes/other.gcode");
		await flushPromises();
		// The stale error must not carry over — the new file is simply "not inspected yet"
		expect(wrapper.text()).not.toMatch(/Preflight found/i);
		expect(wrapper.text()).toMatch(/has not been inspected yet/i);
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
