/**
 * Bundled recipes.
 *
 * These exist to make the first five minutes useful — the plugin should not open on an empty step
 * list and a blank find/replace box. They are also the reference for how a step is meant to be
 * configured, and each one is covered by a golden-file test.
 */

import { newUid, RECIPE_VERSION, type Recipe, type RecipeStep } from "./recipe";

function step(type: string, config: Record<string, unknown>, note?: string): RecipeStep {
	return { uid: newUid(), type, enabled: true, config, ...(note === undefined ? {} : { note }) };
}

export interface Preset {
	key: string;
	name: string;
	description: string;
	build(): Recipe;
}

export const PRESETS: ReadonlyArray<Preset> = Object.freeze([
	{
		key: "marlinToRrf",
		name: "Marlin to RepRapFirmware",
		description: "Rewrites the handful of commands that actually differ: linear advance, jerk, mesh loading and probe offset. Not a general translator — check the result.",
		build(): Recipe {
			return {
				id: newUid(),
				name: "Marlin to RepRapFirmware",
				description: "Curated mapping for the commands RepRapFirmware does not implement.",
				version: RECIPE_VERSION,
				steps: [
					step("commandMap", {
						from: "M900", to: "M572", paramMap: "K=S", addParams: "D0", dropParams: "T",
						keepOriginal: true, layerFrom: -1, layerTo: -1,
					}, "Linear advance to pressure advance"),
					step("commandMap", {
						from: "M205", to: "M566", paramMap: "", addParams: "", dropParams: "J,S,T",
						keepOriginal: true, layerFrom: -1, layerTo: -1,
					}, "Jerk — note M566 is mm/min, M205 is mm/s: check the numbers"),
					step("commandMap", {
						from: "M420", to: "G29", paramMap: "", addParams: "S1", dropParams: "L,V,Z",
						keepOriginal: true, layerFrom: -1, layerTo: -1,
					}, "Load the height map"),
					step("deleteLines", {
						pattern: "^M(501|502|851)\\b", regex: true, caseSensitive: true,
						action: "comment", note: "no RepRapFirmware equivalent — settings live in config.g",
						layerFrom: -1, layerTo: -1,
					}, "Disable EEPROM and probe-offset commands"),
				],
			};
		},
	},
	{
		key: "pauseAtLayer",
		name: "Pause at a layer",
		description: "Inserts a pause at a chosen layer, for an insert or a colour change.",
		build(): Recipe {
			return {
				id: newUid(),
				name: "Pause at a layer",
				version: RECIPE_VERSION,
				steps: [
					step("insertAt", {
						anchor: "layer", layer: 10, position: "before",
						text: "M400\nM25 ; pause — resume from DWC when ready",
						interval: 1, offset: 0, z: 1, tolerance: 0.05, tool: -1,
						pattern: "", regex: false, caseSensitive: true, percent: 50, once: false,
					}, "Change the layer number to suit the print"),
				],
			};
		},
	},
	{
		key: "timelapse",
		name: "Timelapse trigger every layer",
		description: "Calls a macro at every layer change — the usual way to drive a timelapse from DWC.",
		build(): Recipe {
			return {
				id: newUid(),
				name: "Timelapse trigger every layer",
				version: RECIPE_VERSION,
				steps: [
					step("insertAt", {
						anchor: "everyLayer", interval: 1, offset: 0, position: "after",
						text: "M98 P\"0:/macros/timelapse.g\" ; layer {layer}, Z{z}",
						layer: 1, z: 1, tolerance: 0.05, tool: -1,
						pattern: "", regex: false, caseSensitive: true, percent: 50, once: false,
					}, "Point this at your own macro"),
				],
			};
		},
	},
	{
		key: "pressureAdvanceTower",
		name: "Pressure advance tower",
		description: "Turns an already-sliced tower into a pressure-advance calibration print by sweeping M572 up the Z height.",
		build(): Recipe {
			return {
				id: newUid(),
				name: "Pressure advance tower",
				version: RECIPE_VERSION,
				steps: [
					step("rangeVary", {
						template: "M572 D0 S{value}",
						from: 0, to: 0.1, mode: "bands", bands: 11, layersPerBand: 10,
						startLayer: 2, decimals: 3,
						announce: true, announceTemplate: "M117 PA {value}",
					}, "11 bands of 10 layers, 0 to 0.1"),
				],
			};
		},
	},
	{
		key: "slowFirstLayers",
		name: "Slow the first layers",
		description: "Halves the feedrate for the first two layers, for adhesion on a difficult bed.",
		build(): Recipe {
			return {
				id: newUid(),
				name: "Slow the first layers",
				version: RECIPE_VERSION,
				steps: [
					step("paramRewrite", {
						commands: "G0, G1", param: "F", op: "scale", value: 0.5,
						min: 0, max: 0, decimals: 0, skipMissing: true,
						layerFrom: 0, layerTo: 1,
					}),
				],
			};
		},
	},
	{
		key: "stripThumbnails",
		name: "Strip thumbnails and comments",
		description: "Removes embedded preview images and slicer comments. Can halve the file size, which matters on a slow SD card.",
		build(): Recipe {
			return {
				id: newUid(),
				name: "Strip thumbnails and comments",
				version: RECIPE_VERSION,
				steps: [
					step("deleteLines", {
						pattern: "^;\\s*(thumbnail|[A-Za-z0-9+/=]{40,}$)", regex: true, caseSensitive: false,
						action: "delete", note: "", layerFrom: -1, layerTo: -1,
					}, "Thumbnail blocks and their base64 payload"),
					step("deleteLines", {
						pattern: "^\\s*;", regex: true, caseSensitive: true,
						action: "delete", note: "", layerFrom: -1, layerTo: -1,
					}, "All whole-line comments"),
				],
			};
		},
	},
	{
		key: "replaceStartGcode",
		name: "Hand the start sequence to the printer",
		description: "Comments out the slicer's start block and calls start.g instead, so the printer owns its own start sequence.",
		build(): Recipe {
			return {
				id: newUid(),
				name: "Hand the start sequence to the printer",
				version: RECIPE_VERSION,
				steps: [
					step("insertAt", {
						anchor: "firstLayerChange", position: "before",
						text: "M98 P\"0:/macros/print_start.g\"",
						layer: 1, interval: 1, offset: 0, z: 1, tolerance: 0.05, tool: -1,
						pattern: "", regex: false, caseSensitive: true, percent: 50, once: false,
					}, "Call your own start macro at the first layer change"),
				],
			};
		},
	},
	{
		key: "boostBridgeCooling",
		name: "Boost bridge cooling",
		description: "Runs bridges and overhangs at full fan speed, without the slicer's own setting undoing it, leaving every other feature untouched.",
		build(): Recipe {
			return {
				id: newUid(),
				name: "Boost bridge cooling",
				version: RECIPE_VERSION,
				steps: [
					step("fanByFeature", {
						overrides: "bridge=255\noverhang=255",
						scale: "0-255", firstLayerEnabled: false, firstLayerSpeed: 0,
						action: "comment", note: "suppressed by fan override",
					}, "Adjust the scale to 0-1 first if the Inspect tab shows this file uses fractional fan speeds"),
				],
			};
		},
	},
]);

export function findPreset(key: string): Preset | null {
	return PRESETS.find((p) => p.key === key) ?? null;
}
