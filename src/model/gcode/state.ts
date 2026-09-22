/**
 * Running machine state derived from the G-code stream.
 *
 * Every step in a recipe wants to know "which layer is this, what Z, which tool, is E relative" —
 * so it is computed once per line here and shared, rather than each step re-deriving it. That is
 * what keeps a ten-step recipe to one pass and one tokenise per line.
 *
 * Layer detection prefers the slicer's own marker comment, because the geometric fallback (a
 * positive Z-only move) misfires on Z-hop, on vase mode, and on any print with a raft or a
 * z-lift-on-retract. The marker set below covers PrusaSlicer/SuperSlicer/Orca/Bambu
 * (`;LAYER_CHANGE`), Cura (`;LAYER:n`), Simplify3D (`; layer 3, Z = 0.6`) and ideaMaker
 * (`;LAYER:n`). The fallback only runs when no marker has ever been seen in the file.
 */

import { paramNumber, parseParams, unquoteString, type Tokenised } from "dwc-gcode-core";

export interface MachineState {
	/** 1-based line number in the source file. */
	lineNo: number;
	/** 0-based layer index; -1 before the first layer marker. */
	layer: number;
	/** Last commanded X, or null before any X move. */
	x: number | null;
	/** Last commanded Y, or null before any Y move. */
	y: number | null;
	/** Last commanded Z, or null before any Z move. */
	z: number | null;
	/** Running extruder position for the active tool, or null before any extrusion. An E move in
	 *  relative mode (M83) accumulates onto this the same way a relative X/Y/Z move accumulates onto
	 *  {@link x}/{@link y}/{@link z} under G91 - see {@link relativeE}. */
	e: number | null;
	/** Active tool number; -1 when none has been selected. */
	tool: number;
	/** Last commanded feedrate (mm/min), or null. */
	feedrate: number | null;
	/** True after G91 (relative axis moves), false after G90. */
	relativeMoves: boolean;
	/** True after M83 (relative extrusion), false after M82. */
	relativeE: boolean;
	/** Current object label from M486, or null. */
	object: string | null;
	/** Current feature type from the slicer's `;TYPE:` comment, or null. */
	featureType: string | null;
	/** True on the line where the layer index changed. */
	layerChanged: boolean;
	/** True once a layer-change marker comment has been seen (disables the geometric fallback). */
	sawLayerMarker: boolean;
	/**
	 * Whether a Z-only rise may be counted as a layer change. Turned off by the caller when the
	 * pre-scan has already found real markers in the file: a Prusa/Orca start block moves Z before
	 * its first marker, and guessing there would fire every layer-anchored step one extra time
	 * before the print has started.
	 */
	geometricFallback: boolean;
}

/** Matches `;LAYER_CHANGE`, `;AFTER_LAYER_CHANGE`, `;BEFORE_LAYER_CHANGE`. */
const RE_LAYER_CHANGE = /^\s*(?:AFTER_|BEFORE_)?LAYER_CHANGE\s*$/i;
/** Matches Cura/ideaMaker `;LAYER:12`. */
const RE_LAYER_INDEX = /^\s*LAYER:\s*(-?\d+)\s*$/i;
/** Matches Simplify3D `; layer 3, Z = 0.6`. */
const RE_S3D_LAYER = /^\s*layer\s+(\d+)\s*,/i;
/** Matches the slicer feature comment `;TYPE:Perimeter`. */
const RE_TYPE = /^\s*TYPE:\s*(.+?)\s*$/i;

export function createState(options: { geometricFallback?: boolean } = {}): MachineState {
	return {
		geometricFallback: options.geometricFallback !== false,
		lineNo: 0,
		layer: -1,
		x: null,
		y: null,
		z: null,
		e: null,
		tool: -1,
		feedrate: null,
		relativeMoves: false,
		relativeE: false,
		object: null,
		featureType: null,
		layerChanged: false,
		sawLayerMarker: false,
	};
}

/**
 * Reset the bookkeeping that belongs to one *physical* source line — the line counter and the
 * layer-changed flag — before applying its command(s). Call exactly once per physical line,
 * regardless of how many commands it holds (`splitCommands.ts`: RRF allows several — `G90 G1 X10` is
 * two), then call {@link applyToken} once per command. `layerChanged` is deliberately not reset
 * again between those `applyToken` calls: whichever command on the line carries the layer marker
 * must not have its flag clobbered by a later command on the same line that carries none.
 */
export function beginLine(state: MachineState): void {
	state.lineNo++;
	state.layerChanged = false;
}

/**
 * Apply one already-tokenised command's effect to the state. `beginLine` must already have been
 * called once for the physical line this command came from. `token` must be the tokenised
 * **original** text: state tracking describes the source file, so a step that rewrites a command
 * does not retroactively change what layer a later command is on.
 */
export function applyToken(state: MachineState, token: Tokenised): void {
	if (token.comment !== null) {
		applyComment(state, token.comment);
	}
	if (token.code === null) return;

	switch (token.letter) {
		case "T": {
			// A bare T-1 unloads; T without a number was already rejected by the tokeniser
			if (token.number !== null) state.tool = token.number;
			break;
		}
		case "G": {
			applyG(state, token);
			break;
		}
		case "M": {
			applyM(state, token);
			break;
		}
	}
}

/**
 * Advance the state by one source line holding exactly one command — `beginLine` + `applyToken` in
 * one call. Kept for the many callers (and tests) that only ever see a single-command line; a caller
 * that must handle a line with several commands (see `splitCommands.ts`) calls `beginLine` once and
 * `applyToken` once per command instead — see `pipeline.ts`'s `line()` for the reference shape.
 */
export function advance(state: MachineState, token: Tokenised): void {
	beginLine(state);
	applyToken(state, token);
}

function applyComment(state: MachineState, comment: string): void {
	if (RE_LAYER_CHANGE.test(comment)) {
		// The first marker of any kind is authoritative and discards whatever the geometric
		// fallback counted: real slicer start G-code contains a Z move (a purge line, the
		// first-layer approach) before the first marker, and counting it puts every layer out by
		// one. Note Prusa's BEFORE_LAYER_CHANGE arrives before the bare marker, so the reset has to
		// happen here rather than inside the bare-marker branch below
		if (!state.sawLayerMarker) {
			state.layer = -1;
			state.sawLayerMarker = true;
		}
		// Prusa/Orca emit BEFORE_LAYER_CHANGE and AFTER_LAYER_CHANGE around one bare LAYER_CHANGE.
		// Counting all three would treble the layer count, so only the bare marker increments.
		if (/^\s*LAYER_CHANGE\s*$/i.test(comment)) {
			state.layer++;
			state.layerChanged = true;
		}
		return;
	}
	const indexed = RE_LAYER_INDEX.exec(comment);
	if (indexed !== null) {
		const n = Number(indexed[1]);
		if (Number.isFinite(n)) {
			state.layer = n;
			state.layerChanged = true;
			state.sawLayerMarker = true;
		}
		return;
	}
	const s3d = RE_S3D_LAYER.exec(comment);
	if (s3d !== null) {
		const n = Number(s3d[1]);
		if (Number.isFinite(n)) {
			// Simplify3D numbers layers from 1; normalise to the 0-based index everything else uses
			state.layer = n - 1;
			state.layerChanged = true;
			state.sawLayerMarker = true;
		}
		return;
	}
	const type = RE_TYPE.exec(comment);
	if (type !== null) {
		state.featureType = type[1];
	}
}

/** Absolute-or-relative axis update, matching how G91 already applies to Z above: a relative move
 *  accumulates onto the running position, an absolute one replaces it outright. Shared by X/Y (no
 *  layer-detection side effect) and, via {@link applyExtrusion}, E under M83. */
function applyAxisPosition(current: number | null, commanded: number, relative: boolean): number {
	return relative && current !== null ? current + commanded : commanded;
}

function applyExtrusion(state: MachineState, e: number | null): void {
	if (e !== null) state.e = applyAxisPosition(state.e, e, state.relativeE);
}

function applyG(state: MachineState, token: Tokenised): void {
	switch (token.number) {
		case 0:
		case 1: {
			const params = parseParams(token.body);
			const x = paramNumber(params, "X");
			const y = paramNumber(params, "Y");
			const z = paramNumber(params, "Z");
			const e = paramNumber(params, "E");
			const f = paramNumber(params, "F");
			if (f !== null) state.feedrate = f;
			if (x !== null) state.x = applyAxisPosition(state.x, x, state.relativeMoves);
			if (y !== null) state.y = applyAxisPosition(state.y, y, state.relativeMoves);
			if (z !== null) {
				const newZ = applyAxisPosition(state.z, z, state.relativeMoves);
				// Geometric fallback: only for files with no layer marker at all, and only on a
				// Z-only rise (a move that also travels in XY is a ramp, not a layer change)
				if (state.geometricFallback && !state.sawLayerMarker && newZ > (state.z ?? -Infinity)) {
					const hasXY = params.some((p) => p.letter === "X" || p.letter === "Y");
					if (!hasXY) {
						state.layer++;
						state.layerChanged = true;
					}
				}
				state.z = newZ;
			}
			applyExtrusion(state, e);
			break;
		}
		// Arc moves (G2 clockwise / G3 counter-clockwise): X/Y/Z/E name the same destination
		// coordinates a G1 would (RRF's own DoArcMove, Hardware-independent of I/J/R, reads them via
		// the same per-axis parameter path a straight move does). Deliberately NOT given the G0/G1
		// case's geometric layer-fallback: that heuristic is specifically about a plain Z-only rise
		// during printing, and arcs combined with a layer change are not a pattern worth guessing at
		// without a real example to verify against.
		case 2:
		case 3: {
			const params = parseParams(token.body);
			const x = paramNumber(params, "X");
			const y = paramNumber(params, "Y");
			const z = paramNumber(params, "Z");
			const e = paramNumber(params, "E");
			const f = paramNumber(params, "F");
			if (f !== null) state.feedrate = f;
			if (x !== null) state.x = applyAxisPosition(state.x, x, state.relativeMoves);
			if (y !== null) state.y = applyAxisPosition(state.y, y, state.relativeMoves);
			if (z !== null) state.z = applyAxisPosition(state.z, z, state.relativeMoves);
			applyExtrusion(state, e);
			break;
		}
		case 90:
			state.relativeMoves = false;
			break;
		case 91:
			state.relativeMoves = true;
			break;
		case 92: {
			const params = parseParams(token.body);
			const x = paramNumber(params, "X");
			const y = paramNumber(params, "Y");
			const z = paramNumber(params, "Z");
			const e = paramNumber(params, "E");
			// G92 sets the CURRENT position without moving there - always absolute, regardless of
			// G90/G91, since it's redefining what "here" means rather than commanding a move.
			if (x !== null) state.x = x;
			if (y !== null) state.y = y;
			if (z !== null) state.z = z;
			if (e !== null) state.e = e;
			break;
		}
	}
}

function applyM(state: MachineState, token: Tokenised): void {
	switch (token.number) {
		case 82:
			state.relativeE = false;
			break;
		case 83:
			state.relativeE = true;
			break;
		case 486: {
			const params = parseParams(token.body);
			const s = paramNumber(params, "S");
			if (s !== null) {
				state.object = s < 0 ? null : String(s);
			}
			// RRF/Orca also carry a human label: M486 S3 A"handle"
			for (const p of params) {
				if (p.letter === "A") {
					state.object = unquoteString(p.value);
					break;
				}
			}
			break;
		}
	}
}
