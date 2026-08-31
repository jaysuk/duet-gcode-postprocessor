/**
 * Shared plugin identifiers. Kept in a leaf module so any file can import them without pulling in
 * index.ts (which would create an import cycle).
 */

/** Manifest id (plugin.json `id`) — used for dwcPluginLoaded/Unloaded events and the update hub. */
export const PLUGIN_MANIFEST_ID = "GCodePostProcessor";

/** camelCase key for settings persistence and i18n (`plugins.gCodePostProcessor.*`). */
export const PLUGIN_ID = "gCodePostProcessor";

/** Route path for the standalone DWC page. */
export const ROUTE_PATH = "/Plugins/GCodePostProcessor";

/** Embeddable widget id for Flexible Layouts. */
export const EMBEDDABLE_ID = "GCodePostProcessor.Widget";

export const REPO_OWNER = "jaysuk";
export const REPO_NAME = "duet-gcode-postprocessor";
export const DOCS_URL = "https://github.com/jaysuk/duet-gcode-postprocessor/blob/main/docs/usage.md";

/**
 * Where the plugin keeps its own files on the SD card. A top-level directory rather than somewhere
 * under 0:/gcodes, so backups do not appear in DWC's Jobs list, and rather than under 0:/sys, which
 * belongs to the machine configuration rather than to a plugin's working files.
 */
export const WORK_DIR = "0:/postproc";
export const BACKUP_DIR = `${WORK_DIR}/backups`;
export const BACKUP_INDEX = `${WORK_DIR}/backups.json`;
/** Oldest backups are pruned once there are more than this many. */
export const MAX_BACKUPS = 20;

/** localStorage keys (namespaced under the camelCase plugin id). */
export const LS_SELECTED_FILE = "gCodePostProcessor.selectedFile";
export const LS_DIRECTORY = "gCodePostProcessor.directory";
export const LS_ACTIVE_RECIPE = "gCodePostProcessor.activeRecipe";
export const LS_TRUSTED_SCRIPTS = "gCodePostProcessor.trustedScripts";
export const LS_UPDATE_ENABLED = "gCodePostProcessor.updateCheck.enabled";
export const LS_UPDATE_LAST = "gCodePostProcessor.updateCheck.lastCheck";
export const LS_UPDATE_DISMISSED = "gCodePostProcessor.updateCheck.dismissed";

/** Files bigger than this get a "this will be slow" warning before processing. */
export const LARGE_FILE_WARN_BYTES = 250 * 1024 * 1024;

/** Read granularity when streaming a file through the pipeline. */
export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** Output is flushed into a Blob part (and the working string released) at this size. */
export const OUTPUT_FLUSH_BYTES = 8 * 1024 * 1024;

/** How much of the head/tail is pre-scanned for slicer metadata before the main pass. */
export const METADATA_SCAN_BYTES = 96 * 1024;
