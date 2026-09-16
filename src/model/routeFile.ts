/**
 * Resolve an SD-card file path from a plugin route's `:volume?/:path(.*)?` params — the pattern
 * DWC's own bundled `GCodeViewer` plugin already uses for exactly this ("a plugin page deep-linked
 * to one file"), and what `registerPluginContextMenuItem`'s `path` option navigates to (see
 * `index.ts` and `FileList.vue`'s own `onPluginContextMenuItem`, which builds the URL as
 * `<pluginPath>/<volume>/<sd-path>`). Kept pure and separate from `PostProcessorPage.vue` so the
 * param-parsing rules — Vue Router hands a catch-all segment back as a string, but a repeated
 * param name as an array — get real, direct test coverage without mounting a router.
 */
export type RouteParams = Record<string, string | ReadonlyArray<string> | undefined>;

/** Empty string when the route carries no file (the plugin's bare path, or an unmatched route). */
export function sdPathFromRouteParams(params: RouteParams): string {
	const rawVolume = Array.isArray(params.volume) ? params.volume[0] : params.volume;
	const rawPath = Array.isArray(params.path) ? params.path.join("/") : params.path;
	const filePath = rawPath ?? "";
	if (filePath === "") return "";
	const volume = rawVolume !== undefined && /^\d+$/.test(rawVolume) ? rawVolume : "0";
	return `${volume}:/${filePath}`;
}
