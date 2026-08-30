/**
 * Preflight checks: does this file stand a chance of running on *this* machine?
 *
 * Takes a plain snapshot of the machine rather than the object model itself, so the rules are pure
 * and testable, and so a check cannot accidentally start depending on DWC internals. The caller
 * (`machineSnapshot` in the UI layer) does the narrowing from the loosely-typed model exactly once.
 */

import type { FileAnalysis } from "./analysis";

export type CheckLevel = "error" | "warning" | "info";

export interface CheckResult {
	level: CheckLevel;
	code: string;
	title: string;
	detail: string;
}

export interface AxisLimit {
	letter: string;
	min: number;
	max: number;
}

export interface MachineSnapshot {
	axes: Array<AxisLimit>;
	/** Tool numbers configured on the machine. */
	tools: Array<number>;
	/** Number of configured fans. */
	fanCount: number;
	/** Highest allowed temperature per heater, indexed by heater number. */
	heaterMaxTemps: Array<number | null>;
	/** Heater numbers used by tools, in tool order. */
	toolHeaters: Array<Array<number>>;
	/** Bed heater numbers. */
	bedHeaters: Array<number>;
	/** True when the machine reports at least one axis as homed. */
	anyAxisHomed: boolean;
}

export function emptySnapshot(): MachineSnapshot {
	return {
		axes: [], tools: [], fanCount: 0, heaterMaxTemps: [],
		toolHeaters: [], bedHeaters: [], anyAxisHomed: false,
	};
}

/**
 * Run every check. Order is by severity then by how likely the user is to act on it, because this
 * list is read top-down and the first two entries are the ones that get attention.
 */
export function runChecks(analysis: FileAnalysis, machine: MachineSnapshot): Array<CheckResult> {
	const results: Array<CheckResult> = [
		...checkUnsupportedCommands(analysis),
		...checkExtents(analysis, machine),
		...checkTools(analysis, machine),
		...checkTemperatures(analysis, machine),
		...checkFans(analysis, machine),
		...checkStructure(analysis),
	];
	const order: Record<CheckLevel, number> = { error: 0, warning: 1, info: 2 };
	return results.sort((a, b) => order[a.level] - order[b.level]);
}

function checkUnsupportedCommands(analysis: FileAnalysis): Array<CheckResult> {
	return analysis.dialect.unsupported.map((entry) => ({
		level: "error" as const,
		code: `unsupported:${entry.code}`,
		title: `${entry.code} is not supported by RepRapFirmware`,
		detail: `${entry.note}. Seen ${entry.count} ${entry.count === 1 ? "time" : "times"}. The "Map a command" step can rewrite it.`,
	}));
}

function checkExtents(analysis: FileAnalysis, machine: MachineSnapshot): Array<CheckResult> {
	if (analysis.extents === null || machine.axes.length === 0) return [];
	const results: Array<CheckResult> = [];
	const pairs: Array<{ letter: string; min: number; max: number }> = [
		{ letter: "X", min: analysis.extents.minX, max: analysis.extents.maxX },
		{ letter: "Y", min: analysis.extents.minY, max: analysis.extents.maxY },
		{ letter: "Z", min: analysis.extents.minZ, max: analysis.extents.maxZ },
	];

	for (const used of pairs) {
		const axis = machine.axes.find((a) => a.letter.toUpperCase() === used.letter);
		if (axis === undefined) continue;
		if (!Number.isFinite(axis.min) || !Number.isFinite(axis.max)) continue;
		if (used.min < axis.min - 0.01 || used.max > axis.max + 0.01) {
			results.push({
				level: "error",
				code: `extents:${used.letter}`,
				title: `${used.letter} moves outside the machine limits`,
				detail: `The file spans ${used.min.toFixed(2)} to ${used.max.toFixed(2)} mm; the machine allows ${axis.min} to ${axis.max}. RepRapFirmware will clamp or refuse these moves.`,
			});
		}
	}
	return results;
}

function checkTools(analysis: FileAnalysis, machine: MachineSnapshot): Array<CheckResult> {
	if (machine.tools.length === 0) return [];
	const missing = analysis.tools.filter((t) => !machine.tools.includes(t));
	if (missing.length === 0) return [];
	return [{
		level: "error",
		code: "tools:missing",
		title: `The file selects ${missing.length === 1 ? "a tool that is" : "tools that are"} not configured`,
		detail: `T${missing.join(", T")} ${missing.length === 1 ? "is" : "are"} used by this file but not defined on this machine (configured: ${machine.tools.length === 0 ? "none" : `T${machine.tools.join(", T")}`}).`,
	}];
}

function checkTemperatures(analysis: FileAnalysis, machine: MachineSnapshot): Array<CheckResult> {
	const results: Array<CheckResult> = [];

	if (analysis.maxToolTemp !== null) {
		const limits = machine.toolHeaters
			.flat()
			.map((h) => machine.heaterMaxTemps[h])
			.filter((t): t is number => typeof t === "number");
		const limit = limits.length > 0 ? Math.min(...limits) : null;
		if (limit !== null && analysis.maxToolTemp > limit) {
			results.push({
				level: "error",
				code: "temp:tool",
				title: "Hot end temperature exceeds the configured limit",
				detail: `The file asks for ${analysis.maxToolTemp} °C; the lowest tool heater limit (M143) is ${limit} °C. RepRapFirmware will fault the heater.`,
			});
		}
	}

	if (analysis.maxBedTemp !== null) {
		const limits = machine.bedHeaters
			.map((h) => machine.heaterMaxTemps[h])
			.filter((t): t is number => typeof t === "number");
		const limit = limits.length > 0 ? Math.min(...limits) : null;
		if (limit !== null && analysis.maxBedTemp > limit) {
			results.push({
				level: "error",
				code: "temp:bed",
				title: "Bed temperature exceeds the configured limit",
				detail: `The file asks for ${analysis.maxBedTemp} °C; the bed heater limit (M143) is ${limit} °C.`,
			});
		}
	}

	if (analysis.maxChamberTemp !== null && machine.heaterMaxTemps.length > 0) {
		results.push({
			level: "info",
			code: "temp:chamber",
			title: "The file sets a chamber temperature",
			detail: `M141/M191 asks for ${analysis.maxChamberTemp} °C. Check a chamber heater is configured, or the command will fail.`,
		});
	}

	return results;
}

function checkFans(analysis: FileAnalysis, machine: MachineSnapshot): Array<CheckResult> {
	if (machine.fanCount === 0) return [];
	const missing = analysis.fans.filter((f) => f >= machine.fanCount);
	if (missing.length === 0) return [];
	return [{
		level: "warning",
		code: "fans:missing",
		title: "The file drives a fan that is not configured",
		detail: `M106 P${missing.join(", P")} used, but this machine has ${machine.fanCount} fan${machine.fanCount === 1 ? "" : "s"} (P0${machine.fanCount > 1 ? `–P${machine.fanCount - 1}` : ""}).`,
	}];
}

function checkStructure(analysis: FileAnalysis): Array<CheckResult> {
	const results: Array<CheckResult> = [];

	if (!analysis.homes) {
		results.push({
			level: "warning",
			code: "structure:noHoming",
			title: "No homing command in the file",
			detail: "There is no G28 anywhere. That is correct if your start macro homes, but not if the slicer was expected to.",
		});
	}
	if (analysis.tools.length === 0 && (analysis.commandCounts.get("G1") ?? 0) > 0) {
		results.push({
			level: "info",
			code: "structure:noToolSelect",
			title: "No tool is selected",
			detail: "The file never issues a T command. On a machine with tools defined, extrusion before a tool is selected is an error.",
		});
	}
	if (analysis.layers <= 1 && analysis.lines > 1000) {
		results.push({
			level: "info",
			code: "structure:noLayers",
			title: "No layer markers found",
			detail: "Layer-anchored steps fall back to detecting Z-only moves in this file, which is less reliable. Check the layer count in the inspector before relying on it.",
		});
	}
	if (analysis.meta.slicer === "unknown") {
		results.push({
			level: "info",
			code: "structure:unknownSlicer",
			title: "Slicer not recognised",
			detail: "No slicer signature was found in the header or footer, so metadata-based fields (layer count, print time) are unavailable.",
		});
	}
	return results;
}
