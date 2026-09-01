/**
 * Narrowing from DWC's loosely-typed object model into the plain snapshots the preflight checks and
 * the move-time model take. Done in exactly one place so the checks stay pure and a model shape
 * change breaks here rather than in eight different rules.
 */

import { emptySnapshot, type MachineSnapshot } from "../model/checks";
import type { MachineLimits } from "../model/gcode/timeModel";
import type { HeaterModel, ToolConfig, ToolHeaterConfig } from "../model/preheat";

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
	tools?: Array<{
		number?: number;
		heaters?: Array<number>;
		active?: Array<number>;
		standby?: Array<number>;
	} | null>;
	fans?: Array<unknown>;
	heat?: {
		heaters?: Array<{
			max?: number;
			model?: {
				heatingRate?: number; deadTime?: number; coolingRate?: number; coolingExp?: number;
			};
		} | null>;
		bedHeaters?: Array<number>;
	};
	job?: { file?: { fileName?: string }; lastDuration?: number | null };
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
 * `machineLimits` and `machineLimitsComplete` share this single pass over the model, so there is
 * exactly one place that knows what "complete" means and it cannot silently drift from what the
 * limits themselves are actually built from.
 */
function computeMachineLimits(model: unknown): { limits: MachineLimits; complete: boolean } {
	const m = (model ?? {}) as LooseModel;

	const maxSpeed: Record<string, number> = {};
	const maxAccel: Record<string, number> = {};
	const jerk: Record<string, number> = {};
	let complete = true;

	const axes = m.move?.axes ?? [];
	if (axes.length === 0) complete = false;
	for (const axis of axes) {
		if (typeof axis?.letter !== "string") continue;
		if (typeof axis.speed === "number") maxSpeed[axis.letter] = axis.speed; else complete = false;
		if (typeof axis.acceleration === "number") maxAccel[axis.letter] = axis.acceleration; else complete = false;
		if (typeof axis.jerk === "number") jerk[axis.letter] = axis.jerk; else complete = false;
	}

	const extruder = (m.move?.extruders ?? []).find((e) => e !== null && e !== undefined);
	if (extruder) {
		if (typeof extruder.speed === "number") maxSpeed.E = extruder.speed; else complete = false;
		if (typeof extruder.acceleration === "number") maxAccel.E = extruder.acceleration; else complete = false;
		if (typeof extruder.jerk === "number") jerk.E = extruder.jerk; else complete = false;
	} else {
		complete = false;
	}

	const motionSystem = m.move?.motionSystems?.find((s) => s !== null && s !== undefined);
	const printAccel = motionSystem?.printingAcceleration ?? m.move?.printingAcceleration;
	const travelAccel = motionSystem?.travelAcceleration ?? m.move?.travelAcceleration;
	if (typeof printAccel !== "number") complete = false;
	if (typeof travelAccel !== "number") complete = false;

	return {
		limits: {
			maxSpeed,
			maxAccel,
			jerk,
			printAccel: typeof printAccel === "number" ? printAccel : null,
			travelAccel: typeof travelAccel === "number" ? travelAccel : null,
		},
		complete,
	};
}

/**
 * Machine motion limits for the move-time model — axis speed/acceleration/jerk plus the extruder's
 * own (exposed under "E", since extruders have no letter of their own in the object model) and the
 * M204 printing/travel acceleration.
 *
 * Returns whatever it can find even when incomplete — `TimeEstimator` degrades gracefully on a
 * missing value (falling back to `distance / feedrate` for that axis) rather than throwing. A caller
 * presenting the resulting estimate as machine-specific must check {@link machineLimitsComplete}
 * first: a number quietly computed from partial defaults is not what "estimated from this machine's
 * limits" claims to be. See docs/tasks/07-audit-defects.md, defect E.
 */
export function machineLimits(model: unknown): MachineLimits {
	return computeMachineLimits(model).limits;
}

/**
 * False when at least one axis, the extruder, or either M204 acceleration could not be read from the
 * object model — the Inspect button is disabled while disconnected, so this is not about an empty
 * model, it is about a real but incompletely configured machine (an untuned or newly added axis, a
 * single-motion-system board that still lacks `move.motionSystems`). See {@link machineLimits}.
 */
export function machineLimitsComplete(model: unknown): boolean {
	return computeMachineLimits(model).complete;
}

/**
 * Per-tool heater configuration for predictive pre-heat: which heaters each tool drives, their
 * active/standby temperatures, and each heater's tuned `M307` model. One entry per tool; a tool with
 * no heaters at all (a laser, a pen) gets an empty `heaters` array rather than being omitted, so the
 * step can still report "this tool has no heater" instead of silently skipping it.
 */
export function toolHeaterConfigs(model: unknown): Array<ToolConfig> {
	const m = (model ?? {}) as LooseModel;
	const heaters = m.heat?.heaters ?? [];
	const tools = m.tools ?? [];

	const result: Array<ToolConfig> = [];
	for (let i = 0; i < tools.length; i++) {
		const tool = tools[i];
		if (tool === null || tool === undefined) continue;
		const toolNumber = typeof tool.number === "number" ? tool.number : i;
		const heaterIndices = Array.isArray(tool.heaters) ? tool.heaters : [];

		const toolHeaters: Array<ToolHeaterConfig> = heaterIndices.map((heaterIndex, slot) => {
			const heater = heaters[heaterIndex];
			const hm = heater?.model;
			const heaterModel: HeaterModel | null = hm !== undefined
				&& typeof hm.heatingRate === "number" && hm.heatingRate > 0
				? {
					heatingRate: hm.heatingRate,
					deadTime: typeof hm.deadTime === "number" ? hm.deadTime : 0,
					coolingRate: typeof hm.coolingRate === "number" ? hm.coolingRate : 0,
					coolingExp: typeof hm.coolingExp === "number" ? hm.coolingExp : 1.35,
				}
				: null;
			return {
				heaterIndex,
				active: Array.isArray(tool.active) && typeof tool.active[slot] === "number" ? tool.active[slot] : 0,
				standby: Array.isArray(tool.standby) && typeof tool.standby[slot] === "number" ? tool.standby[slot] : 0,
				model: heaterModel,
			};
		});

		result.push({ toolNumber, heaters: toolHeaters });
	}
	return result;
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

/** The live status and last completed job's duration `model/io/simulate.ts` polls on — see that
 *  module's own comment for why these two fields are what it watches. */
export function simulationStatus(model: unknown): { status: string | null; lastDurationSeconds: number | null } {
	const duration = (model as LooseModel)?.job?.lastDuration;
	return {
		status: machineStatus(model),
		lastDurationSeconds: typeof duration === "number" && Number.isFinite(duration) ? duration : null,
	};
}

/**
 * The version of this plugin as installed on the connected machine, read from the object model's
 * plugins map. Used to stamp processed files — a version that never existed must never end up in a
 * stamp, so this is the one place that reads it rather than each caller guessing "0.0.0" on its own.
 */
export function installedPluginVersion(model: unknown, manifestId: string): string {
	return (model as LooseModel)?.plugins?.get(manifestId)?.version ?? "0.0.0";
}
