/**
 * Narrowing from DWC's loosely-typed object model into the plain snapshot the preflight checks
 * take. Done in exactly one place so the checks stay pure and a model shape change breaks here
 * rather than in eight different rules.
 */

import { emptySnapshot, type MachineSnapshot } from "../model/checks";

interface LooseModel {
	move?: { axes?: Array<{ letter?: string; min?: number; max?: number; homed?: boolean }> };
	tools?: Array<{ number?: number; heaters?: Array<number> } | null>;
	fans?: Array<unknown>;
	heat?: {
		heaters?: Array<{ max?: number } | null>;
		bedHeaters?: Array<number>;
	};
	job?: { file?: { fileName?: string } };
	state?: { status?: string };
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
