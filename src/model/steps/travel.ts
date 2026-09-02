/**
 * Shared travel-move detection for the Z-hop (`zHop.ts`) and ooze-control (`oozeControl.ts`) steps.
 * Both key off "a travel move longer than a threshold" — implementing that detection twice is
 * exactly how the two would end up quietly disagreeing about what a travel actually is.
 *
 * Position tracking mirrors `arcWeld.ts`'s own running state (absolute X/Y/Z/E, updated regardless
 * of G90/G91/M82/M83 — the mode only decides what gets *emitted*, never how position is tracked).
 * Not imported from there: `applyAxis` is private to that file, and duplicating six lines of
 * arithmetic is cheaper than coupling two otherwise-unrelated steps to arc-welding.
 */

import { findParam, paramNumber, parseParams, type Tokenised } from "../gcode/tokenise";
import type { LineContext } from "./types";

export interface TravelState {
	x: number;
	y: number;
	z: number;
	e: number;
}

export function createTravelState(): TravelState {
	return { x: 0, y: 0, z: 0, e: 0 };
}

function applyAxis(
	params: ReturnType<typeof parseParams>, letter: string, current: number, relative: boolean,
): number | null {
	const value = paramNumber(params, letter);
	if (value === null) return null;
	return relative ? current + value : value;
}

export interface LineMoveInfo {
	/** A G0/G1 with genuine XY displacement and no positive E delta — the task's own definition of
	 *  "a travel". Zero or negative E (a travel combined with a retraction on the same line) still
	 *  counts: only a *positive* delta means this line is genuinely extruding while it moves. */
	isTravel: boolean;
	/** A G0/G1 with no XY displacement and a negative E delta — a bare retraction on its own line. */
	isRetraction: boolean;
	/** A G0/G1 with no XY displacement and a positive Z delta — a bare Z lift, the shape a slicer's
	 *  own Z-hop takes when it emits one explicitly rather than relying on firmware retraction. */
	isZOnlyRise: boolean;
	/** XY-plane distance moved by this line; only meaningful when `isTravel` is true. */
	distance: number;
	/** This line's resulting absolute Z (its own move if it had one, otherwise unchanged). */
	z: number;
	/** Signed absolute-E delta for this line. */
	deltaE: number;
}

/**
 * Update `state` for one line and classify it. Returns `null` for anything that is not a G0/G1 move
 * at all (comments, other commands) — `state` is still the source of truth for absolute position
 * either way, since only G0/G1 ever change X/Y/E and Z is tracked from `ctx.z` directly.
 *
 * Must be called for every line the recipe hands this step, in order, even ones this function
 * returns `null` for — skipping a line would desync `state` from the file's real position.
 */
export function advanceTravelState(state: TravelState, ctx: LineContext, token: Tokenised): LineMoveInfo | null {
	const isG0G1 = token.letter === "G" && (token.code === "G0" || token.code === "G1");
	if (!isG0G1) return null;

	const params = parseParams(token.body);
	const prevX = state.x;
	const prevY = state.y;
	const prevZ = state.z;
	const prevE = state.e;

	const nextX = applyAxis(params, "X", state.x, ctx.relativeMoves);
	const nextY = applyAxis(params, "Y", state.y, ctx.relativeMoves);
	const nextE = applyAxis(params, "E", state.e, ctx.relativeE);
	if (nextX !== null) state.x = nextX;
	if (nextY !== null) state.y = nextY;
	if (ctx.z !== null) state.z = ctx.z;
	if (nextE !== null) state.e = nextE;

	const dx = nextX !== null ? state.x - prevX : 0;
	const dy = nextY !== null ? state.y - prevY : 0;
	const dz = state.z - prevZ;
	const deltaE = nextE !== null ? state.e - prevE : 0;
	const distance = Math.hypot(dx, dy);

	return {
		isTravel: distance > 0 && deltaE <= 0,
		isRetraction: distance === 0 && deltaE < 0,
		isZOnlyRise: distance === 0 && dz > 0 && deltaE === 0,
		distance,
		z: state.z,
		deltaE,
	};
}

/**
 * True for a *bare* `G10`/`G11` — RepRapFirmware's firmware retract/unretract, which (per
 * `Duet3D/wiki-content`: "RepRapFirmware recognizes G10 as a command to set tool offsets and/or
 * temperatures if the P parameter is present, and as a retraction command if it is absent") already
 * performs the configured retraction *and* any Z-hop from `M207`'s own Z parameter. `G10 P...` is a
 * completely different command (tool offsets/temperatures) and must not be mistaken for this.
 *
 * A file using G10/G11 anywhere has its own retraction and hop convention already, driven by
 * whatever `M207` is configured to on the real machine — invisible from the file's own text, and
 * not this plugin's to guess at. Both `zHop` and `oozeControl` treat seeing this even once as "this
 * file already handles it", for the rest of the file, rather than assuming M207's Z is zero.
 */
export function isFirmwareRetractOrUnretract(token: Tokenised): boolean {
	if (token.code === "G11") return true;
	if (token.code === "G10") return findParam(parseParams(token.body), "P") === null;
	return false;
}
