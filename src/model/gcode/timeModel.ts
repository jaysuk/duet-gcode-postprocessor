/**
 * A move-time estimate using *this machine's* limits, rather than the slicer's guess about
 * whatever printer it thought it was targeting — the whole reason DWC's remaining-time figure can
 * be wildly wrong on a Duet with different acceleration, jerk and speed limits than the profile
 * assumed.
 *
 * Deliberately not a full lookahead planner (RRF's own motion planner does that, exactly, for the
 * move it is about to make — reproducing it here would mean reimplementing the firmware). Two
 * approximations stand in for it, both stated up front rather than discovered later:
 *
 * 1. **Junction speed is approximated by the axis jerk**, not by a full stop and not by the full
 *    nominal speed. Assuming a stop at every corner would over-estimate badly on a file made of
 *    many short segments (nearly every real print); assuming no slowdown at all would under-estimate
 *    just as badly. Jerk is what actually limits a real instantaneous direction change, so it is the
 *    least-wrong single number to use without a real planner.
 * 2. **An entry or exit speed above this move's own nominal (commanded) speed is clamped down to
 *    it** before the trapezoid is computed. In reality a corner entered faster than the following
 *    segment's own feedrate would spend part of the move decelerating from that higher speed, which
 *    this slightly under-estimates — but it keeps the result to one robust, always-non-negative
 *    closed form instead of a multi-case solver for a scenario a jerk-based entry speed rarely
 *    produces in practice.
 *
 * The bar for this model is stated in the task it was built for: better than the slicer's estimate
 * for *this* machine, not firmware-exact.
 */

import { paramNumber, parseParams, type Tokenised } from "./tokenise";
import type { MachineState } from "./state";

export interface MachineLimits {
	/** Per-axis maximum speed, mm/s (M203, converted from the object model's native units — see
	 *  the unit note below; the object model already reports these in mm/s). */
	maxSpeed: Record<string, number>;
	/** Per-axis maximum acceleration, mm/s² (M201). */
	maxAccel: Record<string, number>;
	/** Per-axis instantaneous speed change (jerk), mm/s (M566). */
	jerk: Record<string, number>;
	/** M204 printing acceleration, mm/s². Null when not set. */
	printAccel: number | null;
	/** M204 travel acceleration, mm/s². Null when not set. */
	travelAccel: number | null;
}

/**
 * Time in seconds for one move. Pure, and the one place all the unit and edge-case handling lives.
 *
 * **Unit trap:** G-code `F` is mm/**min**. Every input here — `nominalSpeed`, `entrySpeed`,
 * `exitSpeed`, and the axis limits in {@link MachineLimits} — is mm/**s**, matching the object
 * model's own convention. Convert `F` once, at the call site (divide by 60), never inside this
 * function. A missed factor of 60 here produces an estimate that looks plausible for exactly one
 * class of file and is nonsense everywhere else.
 */
export function moveTime(input: {
	distance: number;
	nominalSpeed: number;
	accel: number;
	entrySpeed: number;
	exitSpeed: number;
}): number {
	const d = input.distance;
	if (!(d > 0)) return 0;

	const vn = Math.max(0, input.nominalSpeed);
	if (vn <= 0) return 0; // a move commanded at zero speed never finishes; nothing sensible to return

	if (!(input.accel > 0)) return d / vn;

	const accel = input.accel;
	// Approximation 2 (see module comment): never ask the move to enter or leave faster than its
	// own commanded speed
	const v0 = Math.max(0, Math.min(input.entrySpeed, vn));
	const v1 = Math.max(0, Math.min(input.exitSpeed, vn));

	const dAccel = (vn * vn - v0 * v0) / (2 * accel);
	const dDecel = (vn * vn - v1 * v1) / (2 * accel);

	if (dAccel + dDecel <= d) {
		// Full trapezoid: accelerate to vn, cruise, decelerate to v1
		const tAccel = (vn - v0) / accel;
		const tDecel = (vn - v1) / accel;
		const dCruise = d - dAccel - dDecel;
		const tCruise = dCruise / vn;
		return tAccel + tCruise + tDecel;
	}

	// Triangular: too short to ever reach vn. Peak speed such that accelerating from v0 and
	// decelerating to v1 exactly covers the distance.
	const vPeak = Math.sqrt(Math.max(0, (2 * accel * d + v0 * v0 + v1 * v1) / 2));
	const tAccel = (vPeak - v0) / accel;
	const tDecel = (vPeak - v1) / accel;
	return tAccel + tDecel;
}

function axisLetters(x: number | null, y: number | null): Array<string> {
	const letters: Array<string> = [];
	if (x !== null) letters.push("X");
	if (y !== null) letters.push("Y");
	return letters;
}

/**
 * Accumulates elapsed time across a G-code stream, one line at a time, using the same push shape as
 * `Analyser` so the existing chunked reader can drive either without knowing the difference.
 *
 * XY moves are timed against the combined XY distance and the tighter of the two axes' limits (a
 * diagonal move is limited by whichever axis would be exceeded first). A move with only Z and/or E
 * is timed against Z's or E's own limits instead — RRF does not usually combine Z into the XY
 * calculation, and neither does this.
 */
export class TimeEstimator {
	private seconds = 0;
	private x: number | null = null;
	private y: number | null = null;
	private z: number | null = null;
	private e: number | null = null;
	private lastFeedrate: number | null = null;

	constructor(private readonly limits: MachineLimits) {}

	get elapsed(): number {
		return this.seconds;
	}

	line(token: Tokenised, state: MachineState): void {
		if (token.code === null || (token.letter !== "G")) return;
		if (token.code !== "G0" && token.code !== "G1") return;

		const params = parseParams(token.body);
		const relative = state.relativeMoves;
		const f = paramNumber(params, "F");
		if (f !== null) this.lastFeedrate = f / 60; // mm/min -> mm/s, once, at the boundary

		const nextX = this.applyAxis(params, "X", this.x, relative);
		const nextY = this.applyAxis(params, "Y", this.y, relative);
		const nextZ = this.applyAxis(params, "Z", this.z, relative);
		const nextE = this.applyAxis(params, "E", this.e, state.relativeE);

		// The distance moved on an axis this line touches — falling back to the commanded value
		// itself when there is no previous position to diff against (the axis's first move in the
		// file). Getting this fallback wrong silently drops every "first move" in a file to zero
		// distance, which is exactly the bug this comment is here to stop being reintroduced.
		const delta = (next: number | null, current: number | null): number =>
			next === null ? 0 : (current === null ? next : next - current);

		const dx = delta(nextX, this.x);
		const dy = delta(nextY, this.y);
		const dz = delta(nextZ, this.z);
		const de = delta(nextE, this.e);

		const xyDistance = Math.hypot(dx, dy);
		const zDistance = Math.abs(dz);
		const eDistance = Math.abs(de);
		const nominal = this.lastFeedrate ?? this.limits.maxSpeed.X ?? 0;

		if (xyDistance > 0) {
			const involved = axisLetters(nextX, nextY);
			const maxSpeed = Math.min(...involved.map((a) => this.limits.maxSpeed[a] ?? Infinity));
			const maxAccel = Math.min(...involved.map((a) => this.limits.maxAccel[a] ?? Infinity));
			const jerk = Math.min(...involved.map((a) => this.limits.jerk[a] ?? 0));
			const accel = this.limits.printAccel ?? maxAccel;
			this.seconds += moveTime({
				distance: xyDistance,
				nominalSpeed: Math.min(nominal, Number.isFinite(maxSpeed) ? maxSpeed : nominal),
				accel: Number.isFinite(accel) ? accel : maxAccel,
				entrySpeed: jerk,
				exitSpeed: jerk,
			});
		} else if (zDistance > 0) {
			const maxSpeed = this.limits.maxSpeed.Z ?? nominal;
			const accel = this.limits.printAccel ?? this.limits.maxAccel.Z ?? 0;
			this.seconds += moveTime({
				distance: zDistance,
				nominalSpeed: Math.min(nominal, maxSpeed),
				accel,
				entrySpeed: this.limits.jerk.Z ?? 0,
				exitSpeed: this.limits.jerk.Z ?? 0,
			});
		} else if (eDistance > 0) {
			// An E-only move (a retraction, or a wipe): timed against the extruder's own limits
			const maxSpeed = this.limits.maxSpeed.E ?? nominal;
			const accel = this.limits.maxAccel.E ?? 0;
			this.seconds += moveTime({
				distance: eDistance,
				nominalSpeed: Math.min(nominal, maxSpeed),
				accel,
				entrySpeed: this.limits.jerk.E ?? 0,
				exitSpeed: this.limits.jerk.E ?? 0,
			});
		}

		if (nextX !== null) this.x = nextX;
		if (nextY !== null) this.y = nextY;
		if (nextZ !== null) this.z = nextZ;
		if (nextE !== null) this.e = nextE;
	}

	private applyAxis(
		params: ReturnType<typeof parseParams>,
		letter: string,
		current: number | null,
		relative: boolean,
	): number | null {
		const value = paramNumber(params, letter);
		if (value === null) return null;
		return relative && current !== null ? current + value : value;
	}
}
