/**
 * Reconstructs machine state at an arbitrary cut point in a file, for `steps/restartFrom.ts` — the
 * facts needed to generate a preamble that gets a resumed print back to a state matching where it
 * actually stopped, without re-running the slicer's own start block over a part that already exists
 * on the bed.
 *
 * `recoveryPlan` is a pure fold over a plain list of already-extracted events, deliberately: every
 * fact here is "the last one before the cut wins", and expressing that as a reducer over one uniform
 * event stream — rather than five or six separate pieces of bespoke tracking — is what makes each
 * field's precedence independently testable with a synthetic list, no G-code or pipeline involved.
 * `steps/restartFrom.ts`'s own collector turns real G-code into this event stream; it is the only
 * thing that needs to know about tokens, params or `LineContext`.
 *
 * **Two things this deliberately does not attempt** (see the task's own stop point,
 * `docs/tasks/11-print-recovery.md`): it does not decide whether re-homing Z is safe — that depends
 * on whether this machine's Z axis probes the bed (unsafe with a part already on it) or homes to a
 * fixed endstop (safe either way), which cannot be told apart from the object model alone, so the
 * step this feeds leaves it off unless the user explicitly opts in. And it does no first-layer
 * adhesion trickery of its own — no re-purge, no extra brim — because there is no single right answer
 * and guessing wastes filament at best; the preamble restores state accurately and nothing more.
 */

export type RecoveryEvent =
	| { kind: "tool"; tool: number }
	| { kind: "bedTemp"; temp: number }
	| { kind: "toolTemp"; tool: number; temp: number }
	| { kind: "fan"; index: number; speed: number }
	| { kind: "extrusionMode"; relative: boolean }
	| { kind: "moveMode"; relative: boolean }
	/** `index: null` is `M486 S-1` — no object active. A non-null index always replaces both fields
	 *  together, matching how a real file re-declares `M486 S<n> A"name"` in full each time that
	 *  object becomes current again, not just the first time. */
	| { kind: "object"; index: number | null; name: string | null }
	/** Any axis left `null` here was not mentioned by the line this event came from — the same
	 *  "leave the running value alone" convention `MachineState` itself uses. */
	| { kind: "position"; x: number | null; y: number | null; z: number | null }
	/** Always the resolved *absolute* value, regardless of what extrusion mode was active when the
	 *  originating line was read — `steps/restartFrom.ts`'s collector does that resolution, so this
	 *  reducer never needs to know which mode was in force at the time. */
	| { kind: "absoluteE"; value: number };

export interface RecoveryState {
	/** -1 when no tool was ever selected before the cut. */
	tool: number;
	/** G90/G91 in force at the cut. */
	relativeMoves: boolean;
	/** M82/M83 in force at the cut. */
	relativeE: boolean;
	/** Absolute E position at the cut. Null when E was never used before the cut — nothing to
	 *  restore, and emitting `G92 E0` would be a fabricated fact, not a recovered one. */
	absoluteE: number | null;
	/** Last commanded bed temperature. Null when the bed was never addressed before the cut. */
	bedTemp: number | null;
	/** Tool number -> last commanded active temperature. A tool never mentioned before the cut has
	 *  no entry — it must not be heated in the preamble on the strength of a guess. */
	toolTemps: ReadonlyMap<number, number>;
	/** Last commanded fan state. Null when no fan command appeared before the cut. */
	fan: { index: number; speed: number } | null;
	/** Active `M486` object at the cut, or null. `name` is null when the M486 that made it current
	 *  carried no `A` parameter — the index is still correct and still worth restoring even without
	 *  a friendly name. */
	object: { index: number; name: string | null } | null;
	x: number | null;
	y: number | null;
	z: number | null;
}

export function emptyRecoveryState(): RecoveryState {
	return {
		tool: -1,
		relativeMoves: false,
		relativeE: false,
		absoluteE: null,
		bedTemp: null,
		toolTemps: new Map(),
		fan: null,
		object: null,
		x: null,
		y: null,
		z: null,
	};
}

/** Folds a stream of events, in source order, into the state at the moment the stream ends — every
 *  field is "whichever event of that kind was seen last", which is exactly what "state at the cut"
 *  means. Pure: no I/O, no G-code parsing, no knowledge of where the events came from. */
export function recoveryPlan(events: ReadonlyArray<RecoveryEvent>): RecoveryState {
	const state = emptyRecoveryState();
	const toolTemps = new Map<number, number>();

	for (const event of events) {
		switch (event.kind) {
			case "tool":
				state.tool = event.tool;
				break;
			case "bedTemp":
				state.bedTemp = event.temp;
				break;
			case "toolTemp":
				toolTemps.set(event.tool, event.temp);
				break;
			case "fan":
				state.fan = { index: event.index, speed: event.speed };
				break;
			case "extrusionMode":
				state.relativeE = event.relative;
				break;
			case "moveMode":
				state.relativeMoves = event.relative;
				break;
			case "object":
				state.object = event.index === null ? null : { index: event.index, name: event.name };
				break;
			case "position":
				if (event.x !== null) state.x = event.x;
				if (event.y !== null) state.y = event.y;
				if (event.z !== null) state.z = event.z;
				break;
			case "absoluteE":
				state.absoluteE = event.value;
				break;
		}
	}

	state.toolTemps = toolTemps;
	return state;
}
