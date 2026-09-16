/**
 * G-code Post-Processor — DuetWebControl 3.7 entry point.
 *
 * Registers the page, publishes the compact widget to Flexible Layouts, wires up diagnostics and
 * the self-update check, and tears all of it down again on unload: DWC can stop and restart a
 * plugin without a page refresh, and a route or listener left behind survives as a duplicate.
 */

import {
	registerEmbeddableComponent, registerPluginContextMenuItem, registerPluginMessages, registerRoute,
	unregisterEmbeddableComponent, unregisterRoute,
} from "@/plugins";
import { ContextMenuType } from "@/stores/ui";
import Events from "@/utils/events";
import { clearAnnouncedUpdate, installErrorCapture } from "dwc-plugin-runtime";

import PostProcessorPage from "./components/PostProcessorPage.vue";
import PostProcessorWidget from "./components/PostProcessorWidget.vue";
import { installAutoRun } from "./dwc/autoRun";
import en from "./i18n/en.json";
import { EMBEDDABLE_ID, PLUGIN_ID, PLUGIN_MANIFEST_ID, ROUTE_PATH } from "./model/constants";
import { runUpdateCheck } from "./model/updateCheck";

registerPluginMessages(PLUGIN_ID, { en });

registerRoute(PostProcessorPage, {
	Plugins: {
		GCodePostProcessor: {
			icon: "mdi-file-replace-outline",
			caption: "plugins.gCodePostProcessor.menuCaption",
			path: ROUTE_PATH,
			// Deep-link form: /Plugins/GCodePostProcessor/<volume>/<sd-path> opens straight to that
			// file's Edit tab - mirrors DWC's own bundled GCodeViewer plugin's identical
			// :volume?/:path(.*)? pattern, the established convention for this exact case.
			routePath: `${ROUTE_PATH}/:volume?/:path(.*)?`,
		},
	},
});

// The right-click "check for errors" / "edit" entry this whole feature started from - shown on
// G-code file rows in both the Jobs page and the Explorer's gcode folders (ContextMenuType only
// has one member, JobFileList, but FileList.vue shows these on any gcode directory, not just the
// dedicated Jobs list). Same mechanism DWC's own bundled GCodeViewer plugin uses for its
// "view as 3D model" entry - confirmed real and current by reading that plugin's own index.ts.
registerPluginContextMenuItem(
	"Edit in G-code Post-Processor",
	ROUTE_PATH,
	"mdi-file-replace-outline",
	"gCodePostProcessor.editFile",
	ContextMenuType.JobFileList,
);

// registerEmbeddableComponent needs DWC 3.7.0-alpha.7+; guard so an older 3.7 still gets the page
let embedded = false;
try {
	if (typeof registerEmbeddableComponent === "function") {
		registerEmbeddableComponent({
			id: EMBEDDABLE_ID,
			pluginId: PLUGIN_MANIFEST_ID,
			caption: "plugins.gCodePostProcessor.widget",
			icon: "mdi-file-replace-outline",
			description: "plugins.gCodePostProcessor.widgetDesc",
			component: PostProcessorWidget,
			defaultSize: { w: 4, h: 6 },
			machineMode: "any",
		});
		embedded = true;
	}
} catch (e) {
	console.warn("[GCodePostProcessor] embeddable registration unavailable:", e);
}

const uninstallErrorCapture = installErrorCapture();
const uninstallAutoRun = installAutoRun();

// Deferred so the connection and object model have settled enough to read the installed version
setTimeout(() => { void runUpdateCheck({ notify: true }); }, 4000);

function onPluginUnloaded(id: string): void {
	if (id !== PLUGIN_MANIFEST_ID) return;
	unregisterRoute(ROUTE_PATH);
	if (embedded) unregisterEmbeddableComponent(EMBEDDABLE_ID);
	clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
	uninstallErrorCapture();
	uninstallAutoRun();
	Events.off("dwcPluginUnloaded", onPluginUnloaded);
}

Events.on("dwcPluginUnloaded", onPluginUnloaded);
