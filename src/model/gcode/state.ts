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

import { paramNumber, parseParams, unquoteString, type Tokenised } from "./tokenise";

export interface MachineState {
	/** 1-based line number in the source file. */
	lineNo: number;
	/** 0-based layer index; -1 before the first layer marker. */
	layer: number;
	/** Last commanded Z, or null before any Z move. */
	z: number | null;
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
		z: null,
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
 * Advance the state by one source line. Call exactly once per line, before running the steps.
 *
 * `token` must be the tokenised **original** line: state tracking describes the source file, so a
 * step that rewrites a line does not retroactively change what layer the next line is on.
 */
export function advance(state: MachineState, token: Tokenised): void {
	state.lineNo++;
	state.layerChanged = false;

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

function applyG(state: MachineState, token: Tokenised): void {
	switch (token.number) {
		case 0:
		case 1: {
			const params = parseParams(token.body);
			const z = paramNumber(params, "Z");
			const f = paramNumber(params, "F");
			if (f !== null) state.feedrate = f;
			if (z !== null) {
				const newZ = state.relativeMoves && state.z !== null ? state.z + z : z;
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
			break;
		}
		case 90:
			state.relativeMoves = false;
			break;
		case 91:
			state.relativeMoves = true;
			break;
		case 92: {
			const z = paramNumber(parseParams(token.body), "Z");
			if (z !== null) state.z = z;
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
