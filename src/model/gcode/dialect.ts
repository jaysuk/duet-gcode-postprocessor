/**
 * G-code flavour detection and RRF command-support lookup.
 *
 * The point is not academic classification — it is answering "will this file run on this printer?"
 * before it stalls 40 minutes in. Evidence is command-level and reported back to the user rather
 * than reduced to a single verdict, because a mixed file (RRF start G-code, Marlin body) is the
 * common real case and a one-word answer would hide it.
 */

export type Flavour = "rrf" | "marlin" | "klipper" | "unknown";

export interface DialectEvidence {
	/** The command or macro that produced the evidence. */
	code: string;
	/** How many times it appeared. */
	count: number;
	/** What its presence indicates. */
	flavour: Exclude<Flavour, "unknown">;
	/** Human explanation, e.g. "Marlin linear advance; RepRapFirmware uses M572". */
	note: string;
}

export interface DialectReport {
	flavour: Flavour;
	evidence: Array<DialectEvidence>;
	/** Commands seen that RepRapFirmware does not implement at all. */
	unsupported: Array<{ code: string; count: number; note: string }>;
}

interface Marker {
	flavour: Exclude<Flavour, "unknown">;
	note: string;
	/** Weight towards the verdict — a single M572 says more than a single M104. */
	weight: number;
}

/**
 * Commands that are characteristic of one firmware. Deliberately excludes anything both
 * firmwares implement identically (G0/G1, M104, M109, M106) — those carry no signal.
 */
const MARKERS: Record<string, Marker> = {
	M572: { flavour: "rrf", note: "RepRapFirmware pressure advance", weight: 3 },
	M566: { flavour: "rrf", note: "RepRapFirmware jerk / instantaneous speed change", weight: 3 },
	M291: { flavour: "rrf", note: "RepRapFirmware message box", weight: 3 },
	M950: { flavour: "rrf", note: "RepRapFirmware object creation", weight: 3 },
	M98: { flavour: "rrf", note: "RepRapFirmware macro call", weight: 2 },
	M116: { flavour: "rrf", note: "RepRapFirmware wait for temperatures", weight: 1 },
	M900: { flavour: "marlin", note: "Marlin linear advance — RepRapFirmware uses M572", weight: 3 },
	M205: { flavour: "marlin", note: "Marlin jerk / junction deviation — RepRapFirmware uses M566", weight: 3 },
	M420: { flavour: "marlin", note: "Marlin bed levelling state — RepRapFirmware uses G29 S1", weight: 3 },
	M104: { flavour: "marlin", note: "", weight: 0 },
	M84: { flavour: "marlin", note: "Marlin disable steppers — RepRapFirmware prefers M18", weight: 1 },
	M108: { flavour: "marlin", note: "Marlin break out of wait", weight: 2 },
	M501: { flavour: "marlin", note: "Marlin restore settings from EEPROM", weight: 2 },
	M851: { flavour: "marlin", note: "Marlin Z probe offset — RepRapFirmware uses G31", weight: 3 },
};

/** Bare-word macros that only exist in Klipper. */
const KLIPPER_MACROS = [
	"SET_PRESSURE_ADVANCE", "SET_VELOCITY_LIMIT", "SET_HEATER_TEMPERATURE",
	"EXCLUDE_OBJECT_DEFINE", "EXCLUDE_OBJECT_START", "BED_MESH_PROFILE", "BED_MESH_CALIBRATE",
	"PRINT_START", "PRINT_END", "SET_GCODE_OFFSET", "TURN_OFF_HEATERS",
];

/** Commands RepRapFirmware simply does not implement. */
const RRF_UNSUPPORTED: Record<string, string> = {
	M900: "Not implemented by RepRapFirmware — the equivalent is M572 D<drive> S<factor>",
	M205: "Not implemented by RepRapFirmware — the equivalent is M566 X/Y/Z/E (mm/min)",
	M420: "Not implemented by RepRapFirmware — use G29 S1 to load a height map",
	M851: "Not implemented by RepRapFirmware — the trigger height belongs in G31 Z",
	M108: "Not implemented by RepRapFirmware",
	M501: "Not implemented by RepRapFirmware — settings live in config.g / config-override.g",
	M502: "Not implemented by RepRapFirmware — settings live in config.g / config-override.g",
	M413: "Not implemented by RepRapFirmware (power-loss recovery is M916/M911)",
};

/**
 * Classify a command histogram. Takes counts rather than the file so it composes with the
 * inspector's single pass, and so it is trivially unit-testable.
 */
export function detectDialect(counts: ReadonlyMap<string, number>): DialectReport {
	const evidence: Array<DialectEvidence> = [];
	const scores: Record<Exclude<Flavour, "unknown">, number> = { rrf: 0, marlin: 0, klipper: 0 };

	for (const [code, count] of counts) {
		const marker = MARKERS[code];
		if (marker !== undefined && marker.weight > 0) {
			scores[marker.flavour] += marker.weight;
			evidence.push({ code, count, flavour: marker.flavour, note: marker.note });
		}
		if (KLIPPER_MACROS.includes(code)) {
			scores.klipper += 3;
			evidence.push({ code, count, flavour: "klipper", note: "Klipper macro" });
		}
	}

	const unsupported: Array<{ code: string; count: number; note: string }> = [];
	for (const [code, count] of counts) {
		const note = RRF_UNSUPPORTED[code];
		if (note !== undefined) unsupported.push({ code, count, note });
	}

	evidence.sort((a, b) => b.count - a.count);
	unsupported.sort((a, b) => b.count - a.count);

	let flavour: Flavour = "unknown";
	let best = 0;
	for (const key of ["rrf", "marlin", "klipper"] as const) {
		if (scores[key] > best) {
			best = scores[key];
			flavour = key;
		}
	}
	return { flavour, evidence, unsupported };
}

/** Bare-word command at the start of a line, used to spot Klipper macros. */
export function bareMacroName(line: string): string | null {
	const m = /^\s*([A-Z][A-Z0-9_]{2,})(?:\s|$)/.exec(line);
	return m === null ? null : m[1];
}
