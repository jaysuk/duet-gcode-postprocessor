/**
 * How long a heater takes to move from one temperature to another, using RepRapFirmware's own
 * first-order-plus-dead-time (FOPDT) heater model — the numbers it measured during `M303`/`M307`
 * auto-tuning, not a generic guess.
 *
 * **Verified against RRF source and the wiki before writing this** (per the task's own stop point —
 * both assumptions below turned out correct, so nothing here is a guess):
 *
 * 1. **`coolingRate`/`coolingExp` are normalised per 100°C above ambient**, not per 1°C. Confirmed in
 *    `HeaterModel::GetBasicCoolingRate` (RepRapFirmware/src/Heating, via CANlib/src/HeaterModel.cpp):
 *    `temperatureRise *= 0.01;` before raising it to `coolingRateExponent` and multiplying by
 *    `basicCoolingRate`. The wiki's M307 section states the identical formula:
 *    `K = (temperature change / time) / ((heater temp - ambient temp) / 100)^E`.
 *    (Duet3D/wiki-content, User_manual/Reference/Gcodes.md, "M307: Set or report heating process
 *    parameters", RRF 3.4 tab.) Getting this wrong would be a factor of 100^coolingExp error — not
 *    subtle, but exactly the kind of error that looks plausible until you plug in real numbers.
 * 2. **`M568 P<n> A2` sets the tool's heaters to their active temperature without selecting the
 *    tool**, and does not wait for them to arrive. Confirmed in `GCodes::SetOrReportOffsets`
 *    (RepRapFirmware/src/GCodes/GCodes.cpp, shared by G10 and M568): the `A` parameter dispatches to
 *    `tool->HeatersToOff()` / `HeatersToActiveOrStandby(false)` / `HeatersToActiveOrStandby(true)`
 *    for `A0`/`A1`/`A2`, entirely independent of `GetMovementState(gb).currentTool`, which is read
 *    only for the (irrelevant here) spindle-RPM branch. The wiki's M568 section states the same:
 *    "0 = off, 1 = standby temperature(s), 2 = active temperature(s)" and "do not wait for the
 *    heaters to reach temp before proceeding."
 *
 * The model here is deliberately RRF's own, not a generic Newton's-law-of-cooling approximation:
 * `dT/dt = heatingRate·pwm − coolingRate·(T/100)^coolingExp`, integrated forward from the standby
 * temperature to the active temperature at full PWM (pwm = 1, no part-cooling-fan term — a tool
 * sitting at standby ahead of a tool change is not printing). A closed form exists only for
 * `coolingExp = 1`; for the general case this is integrated numerically with a fixed 0.1 s step,
 * which trivially survives a firmware change to how `coolingExp` is tuned.
 */

/** A heater's tuned FOPDT model, in the object model's own units (°C/s, s, dimensionless). */
export interface HeaterModel {
	/** °C/s at full PWM with no cooling. */
	heatingRate: number;
	/** Seconds between a PWM change and the sensor noticing it. */
	deadTime: number;
	/** °C/s of cooling at 100°C above ambient. */
	coolingRate: number;
	/** Exponent of the cooling-rate curve. */
	coolingExp: number;
}

/**
 * One heater a tool drives, with the temperatures to move between and its tuned model. Narrowed from
 * the object model in `dwc/machineSnapshot.ts` (`toolHeaterConfigs`) — defined here, not there, since
 * `model/` must not depend on `dwc/`.
 */
export interface ToolHeaterConfig {
	/** Index into `heat.heaters[]`. */
	heaterIndex: number;
	active: number;
	standby: number;
	/** Null when the heater has no usable `M307`-tuned model — must not be guessed at. */
	model: HeaterModel | null;
}

export interface ToolConfig {
	toolNumber: number;
	heaters: Array<ToolHeaterConfig>;
}

/** Returned by {@link heatUpSeconds} when integration is capped rather than a genuine estimate. */
export const HEATUP_CAP_SECONDS = 3600;

const INTEGRATION_STEP_SECONDS = 0.1;
const DEFAULT_SAFETY_FACTOR = 1.15;

/**
 * Seconds to heat from `from` to `to`, both in °C, using `model` at full power. Pure.
 *
 * - `to <= from` is 0 — nothing to do.
 * - A missing or non-positive `heatingRate` (an untuned heater) returns `null` rather than guessing.
 * - A target at or above the model's achievable steady state never converges; the integration is
 *   capped at {@link HEATUP_CAP_SECONDS} of simulated heating time and that exact value is returned
 *   (before dead time or the safety factor), so a caller can detect the cap with `=== HEATUP_CAP_SECONDS`
 *   and warn that the tool may never actually reach temperature — a real thing worth telling someone.
 */
export function heatUpSeconds(input: {
	from: number;
	to: number;
	model: HeaterModel;
	ambient: number;
	/** Multiplier applied to the result after dead time is added. Default 1.15. */
	safetyFactor?: number;
}): number | null {
	if (input.to <= input.from) return 0;

	const { heatingRate, coolingRate, coolingExp, deadTime } = input.model;
	if (!(heatingRate > 0)) return null;

	const target = input.to - input.ambient;
	let t = input.from - input.ambient;
	let elapsed = 0;
	const maxSteps = Math.ceil(HEATUP_CAP_SECONDS / INTEGRATION_STEP_SECONDS);

	for (let step = 0; step < maxSteps; step++) {
		if (t >= target) break;
		const cooling = coolingRate > 0
			? coolingRate * Math.pow(Math.max(0, t) / 100, coolingExp)
			: 0;
		const rate = heatingRate - cooling;
		if (rate <= 0) {
			// Cannot make further progress (cooling has caught up with heating) — this is the
			// "will never reach target" case, not a slow-but-eventual one
			return HEATUP_CAP_SECONDS;
		}
		t += rate * INTEGRATION_STEP_SECONDS;
		elapsed += INTEGRATION_STEP_SECONDS;
	}

	if (t < target) return HEATUP_CAP_SECONDS;

	const safetyFactor = input.safetyFactor ?? DEFAULT_SAFETY_FACTOR;
	return (elapsed + deadTime) * safetyFactor;
}
