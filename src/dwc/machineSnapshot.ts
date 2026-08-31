/**
 * Narrowing from DWC's loosely-typed object model into the plain snapshots the preflight checks and
 * the move-time model take. Done in exactly one place so the checks stay pure and a model shape
 * change breaks here rather than in eight different rules.
 */

import { emptySnapshot, type MachineSnapshot } from "../model/checks";
import type { MachineLimits } from "../model/gcode/timeModel";

interface LooseModel {
	move?: {
		axes?: Array<{
			letter?: string; min?: number; max?: number; homed?: boolean;
			speed?: number; acceleration?: number; jerk?: number;
		}>;
		/**
		 * Extruders are their own array in RepRapFirmware's object model (confirmed against
		 * ObjectModel/src/move/Extruder.ts) — not part of `axes`, and with no letter of their own.
		 * The time model keys every limit by axis letter, so the first configured extruder's
		 * limits are exposed here under the conventional "E".
		 */
		extruders?: Array<{ speed?: number; acceleration?: number; jerk?: number } | null>;
		/** Per-motion-system limits (current schema) — checked first, since `printingAcceleration`/
		 *  `travelAcceleration` directly on `move` are documented as deprecated in favour of these,
		 *  even though they still exist and are populated for the common single-motion-system case. */
		motionSystems?: Array<{ printingAcceleration?: number; travelAcceleration?: number } | null>;
		/** @deprecated kept as the fallback — see motionSystems above. */
		printingAcceleration?: number;
		/** @deprecated kept as the fallback — see motionSystems above. */
		travelAcceleration?: number;
	};
	tools?: Array<{ number?: number; heaters?: Array<number> } | null>;
	fans?: Array<unknown>;
	heat?: {
		heaters?: Array<{ max?: number } | null>;
		bedHeaters?: Array<number>;
	};
	job?: { file?: { fileName?: string } };
	state?: { status?: string };
	plugins?: Map<string, { version?: string }>;
}

export function machineSnapshot(model: unknown): MachineSnapshot {
	const m = (model ?? {}) as LooseModel;
	const snapshot = emptySnapshot();

	for (const axis of m.move?.axes ?? []) {
		if (typeof axis?.letter !== "string") continue;
		snapshot.axes.push({
			letter: axis.letter,
			min: typeof axis.min === "number" ? axis.min : Number.NaN,
			max: typeof axis.max === "number" ? axis.max : Number.NaN,
		});
		if (axis.homed === true) snapshot.anyAxisHomed = true;
	}

	const tools = m.tools ?? [];
	for (let i = 0; i < tools.length; i++) {
		const tool = tools[i];
		if (tool === null || tool === undefined) continue;
		snapshot.tools.push(typeof tool.number === "number" ? tool.number : i);
		snapshot.toolHeaters.push(Array.isArray(tool.heaters) ? tool.heaters : []);
	}

	snapshot.fanCount = (m.fans ?? []).length;
	snapshot.heaterMaxTemps = (m.heat?.heaters ?? []).map((h) => (typeof h?.max === "number" ? h.max : null));
	// bedHeaters holds -1 for an unconfigured slot
	snapshot.bedHeaters = (m.heat?.bedHeaters ?? []).filter((h) => typeof h === "number" && h >= 0);

	return snapshot;
}

/**
 * Machine motion limits for the move-time model — axis speed/acceleration/jerk plus the extruder's
 * own (exposed under "E", since extruders have no letter of their own in the object model) and the
 * M204 printing/travel acceleration.
 */
export function machineLimits(model: unknown): MachineLimits {
	const m = (model ?? {}) as LooseModel;

	const maxSpeed: Record<string, number> = {};
	const maxAccel: Record<string, number> = {};
	const jerk: Record<string, number> = {};

	for (const axis of m.move?.axes ?? []) {
		if (typeof axis?.letter !== "string") continue;
		if (typeof axis.speed === "number") maxSpeed[axis.letter] = axis.speed;
		if (typeof axis.acceleration === "number") maxAccel[axis.letter] = axis.acceleration;
		if (typeof axis.jerk === "number") jerk[axis.letter] = axis.jerk;
	}

	const extruder = (m.move?.extruders ?? []).find((e) => e !== null && e !== undefined);
	if (extruder) {
		if (typeof extruder.speed === "number") maxSpeed.E = extruder.speed;
		if (typeof extruder.acceleration === "number") maxAccel.E = extruder.acceleration;
		if (typeof extruder.jerk === "number") jerk.E = extruder.jerk;
	}

	const motionSystem = m.move?.motionSystems?.find((s) => s !== null && s !== undefined);
	const printAccel = motionSystem?.printingAcceleration ?? m.move?.printingAcceleration;
	const travelAccel = motionSystem?.travelAcceleration ?? m.move?.travelAcceleration;

	return {
		maxSpeed,
		maxAccel,
		jerk,
		printAccel: typeof printAccel === "number" ? printAccel : null,
		travelAccel: typeof travelAccel === "number" ? travelAccel : null,
	};
}

/** The file the machine is currently printing, or null. */
export function jobFileName(model: unknown): string | null {
	const name = (model as LooseModel)?.job?.file?.fileName;
	return typeof name === "string" && name !== "" ? name : null;
}

/** Machine status, lower-cased, or null. */
export function machineStatus(model: unknown): string | null {
	const status = (model as LooseModel)?.state?.status;
	return typeof status === "string" ? status.toLowerCase() : null;
}

/**
 * The version of this plugin as installed on the connected machine, read from the object model's
 * plugins map. Used to stamp processed files — a version that never existed must never end up in a
 * stamp, so this is the one place that reads it rather than each caller guessing "0.0.0" on its own.
 */
export function installedPluginVersion(model: unknown, manifestId: string): string {
	return (model as LooseModel)?.plugins?.get(manifestId)?.version ?? "0.0.0";
}
