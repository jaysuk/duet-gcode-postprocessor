/**
 * RepRapFirmware's tool-temperature commands, and what a `G10` line actually is — read one way for
 * everything that needs them: the preflight analysis (`analysis.ts`), print recovery
 * (`steps/restartFrom.ts`), travel detection (`steps/travel.ts`), tool renumbering
 * (`steps/toolRenumber.ts`) and predictive pre-heat (`steps/preheat.ts`). Kept in one place so they
 * cannot drift into disagreeing about what a line means — which is exactly what happened before this
 * module existed: `travel.ts` called any `G10` without a `P` a retraction, `toolRenumber.ts` left every
 * `G10` alone as ambiguous, and `preheat.ts` counted a `G10 L2`/`L20` workplace offset carrying an `S`
 * or `R` as a tool's temperature setup.
 *
 * - **`M568 P<tool> S<active> R<standby> A<state>`** (RRF 3.3+) — `Duet3D/wiki-content`'s own words:
 *   "Temperatures set with M568 do not wait for the heaters to reach temp before proceeding. In
 *   order to wait for the temp use a M116 command after the M568". `A` is the heater state: 0 off,
 *   1 standby, 2 active.
 * - **`G10 P<tool> S<active> R<standby>`** — the older form M568 replaces; the wiki says the same
 *   about waiting.
 *
 * Both are verified against RepRapFirmware source (`src/GCodes/GCodes.cpp`'s `SetOrReportOffsets`,
 * which both `case 568` and `case 10` call): `S` and `R` are each read with `GetFloatArray` — a colon
 * list, one value per heater of the tool, so `S185:200:150` sets three heaters — and nothing in the
 * function waits. `P` is optional; without it the current tool is meant.
 */

import { findParam, paramNumber, paramNumberList, parseParams, type ParsedParam } from "./tokenise";

/**
 * Which of `G10`'s three meanings a line has, by RepRapFirmware's own dispatch (`GCodes2.cpp`,
 * `case 10`). The wiki's per-form summaries are narrower (temperatures: "a P combined with at least
 * an R or S"), but its note on command queueing states the firmware's rule exactly — a `G10` with
 * no `L` and "at least one P, R, S or axis letter parameter" is tool settings. In full:
 *
 * - **With an `L` parameter:** `L1` is tool settings, the same as no `L`; `L2`/`L20` set a workplace
 *   coordinate system's origin, and there `P` is a coordinate system number, **not** a tool; any
 *   other `L` is rejected by the firmware and does nothing.
 * - **With no `L`:** *any* of `P`, `R`, `S` or an axis letter makes it tool settings — temperatures
 *   (`S`/`R`) and/or tool offsets (axis letters), for tool `P` or the current tool. So `G10 S200` is
 *   the current tool's active temperature, not a retraction, even though it has no `P`.
 * - **Otherwise** — nothing that marks it as tool settings — it is RRF's firmware retraction.
 */
export type G10Form = "retract" | "toolSettings" | "workplace" | "unrecognised";

/**
 * The axis letters RRF checks for (`axisLetters[0..numVisibleAxes)`): X, Y, Z and the extra-axis
 * letters `M584` accepts, `UVWABCD` (the wiki's M584 entry). RRF checks only the machine's
 * *configured* axes, which a file on its own cannot know — so each of these counts whether or not
 * this machine has it, and a `G10` that might be a tool offset is not taken for a retraction. Not
 * covered: RRF 3.4+'s lowercase axes (`a`–`l`, more on the MB6HC/MB6XD), which the wiki says must be
 * written with a leading quote (`'A10`) — not something a slicer emits in a `G10`.
 */
const AXIS_LETTERS: ReadonlyArray<string> = ["X", "Y", "Z", "U", "V", "W", "A", "B", "C", "D"];

function g10FormOf(params: ReadonlyArray<ParsedParam>): G10Form {
	if (findParam(params, "L") !== null) {
		const l = paramNumber(params, "L");
		if (l === 1) return "toolSettings";
		if (l === 2 || l === 20) return "workplace";
		return "unrecognised";
	}
	for (const letter of ["P", "R", "S", ...AXIS_LETTERS]) {
		if (findParam(params, letter) !== null) return "toolSettings";
	}
	return "retract";
}

/** Which of `G10`'s three meanings this `G10` line's body has — see `G10Form`. */
export function g10Form(body: string): G10Form {
	return g10FormOf(parseParams(body));
}

export interface ToolTemperatureSetting {
	/** Tool number from `P`, or null when the command addresses the current tool. */
	tool: number | null;
	/** `S` — active temperature per heater, in heater order. Empty when `S` is absent, and a
	 *  non-numeric element (an expression) is dropped — there is no number to read. */
	active: Array<number>;
	/** `R` — standby temperature per heater, in heater order. Same rules as `active`. */
	standby: Array<number>;
	/**
	 * True when `S` or `R` is present at all, whatever its value. This differs from the lists being
	 * non-empty only when a value is not a plain number: RRF 3.01+ accepts an expression in braces
	 * anywhere a number goes (the wiki's G-code dictionary: "instead of a number you may use an
	 * expression enclosed in braces"), e.g. `S{global.printTemp}`. The lists drop it — there is no
	 * number to read — but it still sets the tool's temperatures. A caller asking "are this tool's
	 * temperatures established here?" (predictive pre-heat) needs this; a caller that needs the
	 * numbers themselves (the M143 check, print recovery) uses the lists.
	 */
	setsTemperatures: boolean;
	/** `M568`'s `A`: 0 off, 1 standby, 2 active. Null when absent — and always null for `G10`,
	 *  which has no heater-state parameter. */
	heaterState: number | null;
}

/**
 * The tool-temperature content of one command, or null when the line is not a tool-temperature
 * command at all — anything other than `M568`/`G10`, a `G10` that is not tool settings (a
 * retraction, a workplace offset), or a tool-settings `G10` that sets only offsets. `M568` is always
 * read, even with no temperatures, because its `A` alone changes heater state.
 */
export function readToolTemperatureSetting(code: string | null, body: string): ToolTemperatureSetting | null {
	if (code !== "M568" && code !== "G10") return null;
	const params = parseParams(body);
	const setsTemperatures = findParam(params, "S") !== null || findParam(params, "R") !== null;
	if (code === "G10") {
		if (g10FormOf(params) !== "toolSettings") return null;
		if (!setsTemperatures) return null;
	}
	const p = paramNumber(params, "P");
	return {
		tool: p !== null && p >= 0 ? Math.trunc(p) : null,
		active: paramNumberList(params, "S"),
		standby: paramNumberList(params, "R"),
		setsTemperatures,
		heaterState: code === "M568" ? paramNumber(params, "A") : null,
	};
}
