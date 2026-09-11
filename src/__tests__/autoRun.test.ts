import { beforeEach, describe, expect, it, vi } from "vitest";
import { dwc, notifications, patchModel, resetDwc, setConnected } from "dwc-plugin-test-kit";

// This harness's happy-dom `localStorage` is a non-functional stub (`localStorage.setItem` is not a
// function — confirmed the same way test/component.test.ts's own comment documents it for
// recipeStore), and autoRun's enable/silent flags are plain localStorage reads with no other
// fallback. A tiny in-memory stand-in is the only way to exercise that logic here; real DWC runs in
// an actual browser, where the real localStorage works.
const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => memoryStorage.get(key) ?? null,
	setItem: (key: string, value: string) => { memoryStorage.set(key, value); },
	removeItem: (key: string) => { memoryStorage.delete(key); },
});

import { HISTORY_INDEX, WORK_DIR } from "../model/constants";
import { parseHistory } from "../model/io/history";
import { createRecipe, newUid, type Recipe } from "../model/recipe";
import { useRecipes } from "../dwc/recipeStore";
import { FakeGateway, SAMPLE } from "./helpers";

const confirmMock = vi.fn<(title?: string, prompt?: string) => Promise<boolean>>();
vi.mock("@/composables/useConfirmDialog", () => ({
	showConfirmDialog: (title?: string, prompt?: string) => confirmMock(title, prompt),
	showMessageBox: () => Promise.resolve(),
}));

let gateway: FakeGateway;
/** When set, `createGateway()` hands back a gateway whose download resolves something `prescan`
 *  will throw on — a stand-in for any unexpected failure inside `handleFileUploaded`. */
let poisonNextRun = false;
vi.mock("../dwc/gateway", () => ({
	createGateway: () => (poisonNextRun
		? { ...gateway, download: async () => ({ size: 10 } as unknown as Blob) }
		: gateway),
}));

const SOURCE = "0:/gcodes/benchy.gcode";

// Imported after the mocks above so it picks up the mocked modules
import {
	handleFileUploaded, isAutoRunEnabled, isAutoRunSilent, queueFileUploaded, setAutoRunEnabled,
	setAutoRunSilent,
} from "../dwc/autoRun";

function matchingRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		...createRecipe("Halve the speed"),
		match: "*.gcode",
		steps: [{ uid: newUid(), type: "findReplace", enabled: true, config: { find: "F1800", replace: "F900" } }],
		...overrides,
	};
}

function scriptedRecipe(): Recipe {
	return {
		...createRecipe("Scripted"),
		match: "*.gcode",
		steps: [{ uid: newUid(), type: "script", enabled: true, config: {} }],
	};
}

describe("autoRun", () => {
	beforeEach(() => {
		resetDwc();
		memoryStorage.clear();
		setConnected(true);
		confirmMock.mockReset();
		confirmMock.mockResolvedValue(false);
		poisonNextRun = false;
		gateway = new FakeGateway({ [SOURCE]: SAMPLE + "\n" });

		// The test kit's settings stub has no registerPluginData/setPluginData, so recipeStore falls
		// back to real localStorage, which is a non-functional stub under happy-dom (documented in
		// test/component.test.ts). Fill in the per-board path with the same reactive bag a real DWC
		// would expose, so recipes added in a test are visible to autoRun's own useRecipes() call.
		const settings = dwc.settings as Record<string, unknown> & { plugins: Record<string, unknown> };
		settings.plugins = {};
		(settings as Record<string, unknown>).registerPluginData = (plugin: string, key: string, value: unknown) => {
			const bag = (settings.plugins[plugin] ?? {}) as Record<string, unknown>;
			if (!(key in bag)) settings.plugins[plugin] = { ...bag, [key]: value };
		};
		(settings as Record<string, unknown>).setPluginData = (plugin: string, key: string, value: unknown) => {
			settings.plugins[plugin] = { ...(settings.plugins[plugin] as Record<string, unknown> ?? {}), [key]: value };
		};

		setAutoRunEnabled(true);
	});

	function addRecipe(recipe: Recipe): void {
		useRecipes().add(recipe);
	}

	it("the auto-run toggles round-trip and silent mode is cleared when disabling", () => {
		setAutoRunSilent(true);
		expect(isAutoRunSilent()).toBe(true);
		setAutoRunEnabled(false);
		expect(isAutoRunEnabled()).toBe(false);
		expect(isAutoRunSilent()).toBe(false);
	});

	it("does nothing when auto-run is disabled", async () => {
		setAutoRunEnabled(false);
		addRecipe(matchingRecipe());
		await handleFileUploaded({ filename: SOURCE });
		expect(gateway.log).toEqual([]);
	});

	describe("the plugin's own uploads are ignored", () => {
		it.each([
			`${WORK_DIR}/backups/benchy.20260906.gcode`,
			`${SOURCE}.pp.tmp`,
			HISTORY_INDEX,
		])("ignores %s", async (path) => {
			addRecipe(matchingRecipe());
			await handleFileUploaded({ filename: path });
			expect(gateway.log).toEqual([]);
		});
	});

	it("does nothing for a non-G-code upload", async () => {
		addRecipe(matchingRecipe());
		await handleFileUploaded({ filename: "0:/gcodes/readme.txt" });
		expect(gateway.log).toEqual([]);
	});

	it("does nothing when no recipe matches", async () => {
		addRecipe(matchingRecipe({ match: "*.bgcode" }));
		await handleFileUploaded({ filename: SOURCE });
		expect(gateway.log).toEqual([]);
	});

	it("does nothing and notifies when more than one recipe matches", async () => {
		addRecipe(matchingRecipe({ name: "A" }));
		addRecipe(matchingRecipe({ name: "B" }));
		await handleFileUploaded({ filename: SOURCE });
		expect(gateway.log.filter((l) => l.startsWith("upload"))).toEqual([]);
		expect(notifications().some((n) => n.message?.includes("recipes match"))).toBe(true);
	});

	it("refuses a recipe containing a script, and never calls processFile", async () => {
		addRecipe(scriptedRecipe());
		await handleFileUploaded({ filename: SOURCE });
		// The refusal happens before anything is fetched at all — `processFile` is the only thing
		// that downloads the source on this path, so zero downloads proves it was never entered
		expect(gateway.log.filter((l) => l.startsWith("download") && l.includes("benchy"))).toEqual([]);
		expect(gateway.log.filter((l) => l.startsWith("upload") || l.startsWith("move"))).toEqual([]);
		expect(notifications().some((n) => n.message?.includes("script"))).toBe(true);
	});

	// A recipe matching on name or folder alone needs nothing from the file's contents, so auto-run
	// must not fetch it just to look: `processFile` downloads its own copy, and a second transfer of
	// a print file is exactly what this plugin's chunked-read design exists to avoid.
	it("transfers the file once when no candidate recipe matches on the slicer", async () => {
		confirmMock.mockResolvedValue(true);
		addRecipe(matchingRecipe());
		await handleFileUploaded({ filename: SOURCE });
		expect(gateway.log.filter((l) => l === `download ${SOURCE}`)).toHaveLength(1);
	});

	it("fetches the file when a candidate does match on the slicer, and honours the result", async () => {
		confirmMock.mockResolvedValue(true);
		// SAMPLE carries no recognisable slicer banner, so a Cura rule must reject it
		addRecipe(matchingRecipe({ name: "Cura only", matchSlicer: "Cura" }));
		await handleFileUploaded({ filename: SOURCE });
		expect(gateway.log.filter((l) => l === `download ${SOURCE}`)).toHaveLength(1);
		expect(gateway.log.filter((l) => l.startsWith("upload"))).toEqual([]);
	});

	it("refuses when the file is the one currently printing", async () => {
		patchModel({ job: { file: { fileName: SOURCE } } });
		addRecipe(matchingRecipe());
		await handleFileUploaded({ filename: SOURCE });
		expect(gateway.log.filter((l) => l.startsWith("upload"))).toEqual([]);
		expect(notifications().some((n) => n.message?.includes("current print job") || n.message?.includes("job"))).toBe(true);
	});

	it("writes nothing when the confirmation is declined", async () => {
		confirmMock.mockResolvedValue(false);
		addRecipe(matchingRecipe());
		await handleFileUploaded({ filename: SOURCE });
		expect(gateway.log.filter((l) => l.startsWith("upload"))).toEqual([]);
	});

	it("writes the file and records history when the confirmation is accepted", async () => {
		confirmMock.mockResolvedValue(true);
		addRecipe(matchingRecipe());
		await handleFileUploaded({ filename: SOURCE });

		expect(gateway.log.some((l) => l.startsWith("upload"))).toBe(true);
		const history = parseHistory(gateway.files.get(HISTORY_INDEX) ?? "");
		expect(history).toHaveLength(1);
		expect(history[0].origin).toBe("auto");
		expect(history[0].ok).toBe(true);
	});

	it("in silent mode, writes without asking for confirmation", async () => {
		setAutoRunSilent(true);
		addRecipe(matchingRecipe());
		await handleFileUploaded({ filename: SOURCE });
		expect(confirmMock).not.toHaveBeenCalled();
		expect(gateway.log.some((l) => l.startsWith("upload"))).toBe(true);
	});

	// The queue chains every upload off the previous one's promise. Before this was guarded, one
	// unexpected throw left `queue` rejected and every later upload's `.then` was skipped — auto-run
	// went permanently and silently dead for the rest of the session.
	it("keeps working after one run fails unexpectedly", async () => {
		confirmMock.mockResolvedValue(true);
		addRecipe(matchingRecipe());
		gateway.files.set("0:/gcodes/second.gcode", SAMPLE + "\n");

		poisonNextRun = true;
		await queueFileUploaded({ filename: SOURCE });
		poisonNextRun = false;

		gateway.log.length = 0;
		await queueFileUploaded({ filename: "0:/gcodes/second.gcode" });
		expect(gateway.log.some((l) => l.startsWith("upload"))).toBe(true);
	});

	it("processes two uploads serially, not concurrently", async () => {
		confirmMock.mockResolvedValue(true);
		addRecipe(matchingRecipe());
		gateway.files.set("0:/gcodes/second.gcode", SAMPLE + "\n");

		const first = queueFileUploaded({ filename: SOURCE });
		const second = queueFileUploaded({ filename: "0:/gcodes/second.gcode" });
		await Promise.all([first, second]);

		// Serial execution means the first file's whole upload/move sequence completes before the
		// second file's download even starts — so the log never interleaves the two paths
		const firstDownloadIndex = gateway.log.findIndex((l) => l.startsWith("download") && l.includes("benchy"));
		const secondDownloadIndex = gateway.log.findIndex((l) => l.startsWith("download") && l.includes("second"));
		const firstMoveIndex = gateway.log.findIndex((l) => l.startsWith("move") && l.includes("benchy"));
		expect(firstMoveIndex).toBeGreaterThan(-1);
		expect(secondDownloadIndex).toBeGreaterThan(firstMoveIndex);
		expect(firstDownloadIndex).toBeLessThan(secondDownloadIndex);
	});
});
