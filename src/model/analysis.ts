/**
 * Single-pass file analysis: what is actually in this G-code.
 *
 * Drives the inspector and the preflight checks from one read, using the same push-per-line shape
 * as the pipeline so the chunked reader can feed either (or both) without knowing the difference.
 */

import { arcMoveLength } from "./gcode/arcFit";
import { bareMacroName, detectDialect, type DialectReport } from "./gcode/dialect";
import { normaliseFeature, type Feature } from "./gcode/features";
import { emptyMetadata, type SlicerMetadata } from "./gcode/metadata";
import { advance, createState, type MachineState } from "./gcode/state";
import { TimeEstimator, type MachineLimits } from "./gcode/timeModel";
import { findParam, paramNumber, parseParams, tokenise, unquoteString } from "./gcode/tokenise";

export interface Extents {
	minX: number; maxX: number;
	minY: number; maxY: number;
	minZ: number; maxZ: number;
}

export interface FeatureStats {
	feature: Feature;
	/** Seconds spent on moves recorded under this feature. Always 0 when no machine limits were
	 *  supplied — time needs the move-time model; filament does not. */
	seconds: number;
	/** mm of filament extruded under this feature (positive extrusion only, never net of retraction). */
	filamentMm: number;
	/** Moves recorded under this feature (a move contributes to exactly one feature: the one active
	 *  when it happens). */
	moves: number;
}

export interface LayerStats {
	layer: number;
	seconds: number;
	filamentMm: number;
}

export interface ObjectStats {
	/** The M486 label, exactly as last set by `M486 S<n> A"..."` or `M486 S<n>`. */
	object: string;
	seconds: number;
	filamentMm: number;
}

export interface RetractionStats {
	tool: number;
	count: number;
	/** Total retracted distance in mm — the magnitude of every negative E delta, summed. A proxy for
	 *  oozing and for wear, not a defect report on its own. */
	totalMm: number;
}

export interface FileAnalysis {
	lines: number;
	bytes: number;
	/** Command -> occurrences, e.g. "G1" -> 412_339. */
	commandCounts: Map<string, number>;
	/** Layer count as counted from layer-change markers (or the geometric fallback). */
	layers: number;
	/** Motion extents, or null when the file contains no coordinates. */
	extents: Extents | null;
	/** Tool numbers selected anywhere in the file. */
	tools: Array<number>;
	/** Highest tool temperature commanded (M104/M109 S). */
	maxToolTemp: number | null;
	/** Highest bed temperature commanded (M140/M190 S). */
	maxBedTemp: number | null;
	/** Highest chamber temperature commanded (M141/M191 S). */
	maxChamberTemp: number | null;
	/** Fan indices referenced by M106 P or M107 P. */
	fans: Array<number>;
	/**
	 * Distinct fan settings seen, most frequent first. RRF accepts a fan speed written as 0-255
	 * (`S255`) or as a fraction 0-1 (`S1.0`) — whichever the file used is recorded verbatim, never
	 * normalised into the other scale, since guessing wrong turns "half speed" into "off". A caller
	 * can tell which convention a file uses by checking whether any recorded speed exceeds 1.
	 */
	fanSettings: Array<{
		/** Fan index from M106 P, or 0 when the command omits it. */
		fan: number;
		/** Speed exactly as written in S (0 for M107). */
		speed: number;
		count: number;
		/** Features this setting was seen under, most frequent first. */
		features: Array<{ feature: Feature; count: number }>;
	}>;
	/** Object labels seen in M486. */
	objects: Array<string>;
	/**
	 * Macro paths referenced by `M98 P"..."`, de-duplicated, in first-seen order. An `M98` whose `P`
	 * is an expression (`{...}`) is not resolvable statically and is not included.
	 */
	macroRefs: Array<{ path: string; count: number; firstLine: number }>;
	/** Highest feedrate commanded (mm/min). */
	maxFeedrate: number | null;
	/** True when the file uses relative extrusion at any point. */
	usesRelativeE: boolean;
	/** True when a homing command appears anywhere. */
	homes: boolean;
	/** Line number of the first extruding G0/G1 move, or null. A retraction does not count. */
	firstExtrusionLine: number | null;
	/** Line number of the first command that waits for a hot end (M109 or M116), or null. */
	firstHeatWaitLine: number | null;
	/** True if the file ever turns a heater off (S<=0), sets a tool to standby/off via M568, or ends via M0/M2. */
	heatersAddressed: boolean;
	/** True if the file ever turns the part fan off (M107, or M106 with S<=0). */
	fanAddressed: boolean;
	/** True if the file ever disables motors (M18 or M84). */
	motorsAddressed: boolean;
	/**
	 * Where the print-time estimate came from. `"m73"` when the slicer's own `M73 P R` markers were
	 * found (read from the first one — far more accurate than any model, since the slicer knew the
	 * real geometry); `"model"` when this machine's own move-time model was used instead, which
	 * needs `limits` to have been supplied to the constructor; `"none"` when neither was possible.
	 */
	timeSource: "m73" | "model" | "none";
	/** Estimated total print time in seconds, or null when `timeSource` is `"none"`. */
	estimatedSeconds: number | null;
	dialect: DialectReport;
	meta: SlicerMetadata;
	/** mm³/s of filament demanded, at the worst move in the file. Null when the file does not
	 *  extrude, or when the filament diameter is unknown and cannot be assumed. */
	peakFlowMm3PerSec: number | null;
	/** 1-based source line of that move, for a report that can be acted on. Null iff the flow figure
	 *  itself is null. */
	peakFlowLine: number | null;
	/** The slicer's own stated ceiling, when it states one. Null otherwise — never invented. */
	statedMaxFlowMm3PerSec: number | null;
	/** Seconds this machine will actually take, its limits applied. Null when no machine limits were
	 *  supplied (the constructor's `limits` argument was omitted). */
	clampedSeconds: number | null;
	/** Seconds the file's own commanded feedrates would take with this machine's speed *ceiling*
	 *  skipped, but its real acceleration and jerk still applied — see `TimeEstimator.unclampedSeconds`
	 *  for why this is not simply "no limits at all" (task 10 finding E). Null under the same
	 *  condition as `clampedSeconds` — it comes from the same pass. */
	unclampedSeconds: number | null;
	/** Moves whose commanded feedrate exceeded this machine's limit for the axes involved. 0 when no
	 *  machine limits were supplied. */
	clampedMoveCount: number;
	/** Time and filament per feature, most time-consuming first (then most filament, to break a tie
	 *  when no machine limits were supplied and every `seconds` is 0). */
	featureStats: Array<FeatureStats>;
	/** Time and filament for the busiest layers, most time-consuming first, capped at
	 *  {@link MAX_REPORTED_LAYERS} entries — a report, not a full per-layer dump. Every layer appears
	 *  when the file has fewer layers than the cap. */
	slowestLayers: Array<LayerStats>;
	/** Time and filament per `M486` object, most time-consuming first. Empty when the file never uses
	 *  `M486`. */
	objectStats: Array<ObjectStats>;
	/** Retraction count and total distance per tool, sorted by tool number. Moves before any tool is
	 *  selected are not attributed to tool 0 — they are excluded entirely, matching `tools`' own
	 *  convention of never counting the unselected `-1` state as a real tool. */
	retractionStats: Array<RetractionStats>;
}

/** Cap on `slowestLayers` — a 5,000-layer file must not put 5,000 rows in the UI. */
export const MAX_REPORTED_LAYERS = 50;

export class Analyser {
	private readonly state: MachineState;
	private readonly counts = new Map<string, number>();
	private readonly toolSet = new Set<number>();
	private readonly fanSet = new Set<number>();
	private readonly fanSettingsMap = new Map<string, {
		fan: number; speed: number; count: number; featureCounts: Map<Feature, number>;
	}>();
	private readonly objectSet = new Set<string>();
	private readonly macroRefsMap = new Map<string, { path: string; count: number; firstLine: number }>();
	private readonly featureStatsMap = new Map<Feature, { seconds: number; filamentMm: number; moves: number }>();
	private readonly layerStatsMap = new Map<number, { seconds: number; filamentMm: number }>();
	private readonly objectStatsMap = new Map<string, { seconds: number; filamentMm: number }>();
	private readonly retractionStatsMap = new Map<number, { count: number; totalMm: number }>();

	private lines = 0;
	private bytes = 0;
	private maxLayer = -1;
	private minX = Infinity; private maxX = -Infinity;
	private minY = Infinity; private maxY = -Infinity;
	private minZ = Infinity; private maxZ = -Infinity;
	private maxToolTemp: number | null = null;
	private maxBedTemp: number | null = null;
	private maxChamberTemp: number | null = null;
	private maxFeedrate: number | null = null;
	private usesRelativeE = false;
	private homes = false;
	private firstExtrusionLine: number | null = null;
	private firstHeatWaitLine: number | null = null;
	private heatersAddressed = false;
	private fanAddressed = false;
	private motorsAddressed = false;
	private x: number | null = null;
	private y: number | null = null;
	private e: number | null = null;
	/** Last commanded feedrate, mm/s — tracked independently of `MachineState.feedrate` because that
	 *  field is only updated for G0/G1 (see `state.ts`), and flow must also see F on a G2/G3 arc. */
	private lastFeedrateMmPerSec: number | null = null;
	/** mm² cross-section of the filament, from the slicer's stated diameter. Null (and therefore every
	 *  flow figure null) when the diameter is unknown — never assumed. */
	private readonly filamentArea: number | null;
	private peakFlowMm3PerSec: number | null = null;
	private peakFlowLine: number | null = null;
	private readonly timeEstimator: TimeEstimator | null;
	/** True once an M73 with a parseable R has been seen — the file states its own time. */
	private sawM73 = false;
	/** Total minutes from the FIRST such M73 — later ones only narrow toward zero as printing
	 *  progresses, so the first is what states the whole print's length. */
	private firstM73Minutes: number | null = null;

	constructor(private readonly meta: SlicerMetadata = emptyMetadata(), limits?: MachineLimits) {
		this.state = createState({ geometricFallback: !meta.hasLayerMarkers });
		this.timeEstimator = limits !== undefined ? new TimeEstimator(limits) : null;
		this.filamentArea = meta.filamentDiameterMm !== null && meta.filamentDiameterMm > 0
			? Math.PI * (meta.filamentDiameterMm / 2) ** 2
			: null;
	}

	line(raw: string): void {
		this.lines++;
		this.bytes += raw.length + 1;

		const token = tokenise(raw);
		const zBeforeLine = this.state.z;
		advance(this.state, token);
		this.timeEstimator?.line(token, this.state);
		if (this.state.layer > this.maxLayer) this.maxLayer = this.state.layer;
		if (this.state.relativeE) this.usesRelativeE = true;

		if (token.code === null) {
			// Klipper macros are bare words, invisible to command counting but very visible to a
			// user wondering why their file will not run
			const macro = bareMacroName(token.body);
			if (macro !== null) bump(this.counts, macro);
			return;
		}
		const code = token.code.toUpperCase();
		bump(this.counts, code);

		if (token.letter === "T" && token.number !== null && token.number >= 0) {
			this.toolSet.add(token.number);
			return;
		}
		if (token.letter === "G") {
			this.applyG(code, token.body, zBeforeLine);
			return;
		}
		this.applyM(code, token.body);
	}

	private applyG(code: string, body: string, zBeforeLine: number | null): void {
		if (code === "G28") { this.homes = true; return; }
		if (code === "G92") {
			// Resets the E datum (almost always to 0) without extruding anything. Without this,
			// this.e keeps whatever a prior G1 left it at, and the next G1's absolute E reads as a
			// huge negative delta against that stale value — recorded as a retraction that never
			// happened. Not merely a retraction-counting nicety: the same stale `this.e` would also
			// corrupt flow/filament tracking below, this just never surfaced there because a wrongly
			// negative deltaE only zeroes out a filament credit rather than reporting a wrong one.
			const e = paramNumber(parseParams(body), "E");
			if (e !== null) this.e = e;
			return;
		}
		if (code !== "G0" && code !== "G1" && code !== "G2" && code !== "G3") return;

		const params = parseParams(body);
		const relative = this.state.relativeMoves;
		const prevX = this.x;
		const prevY = this.y;
		const x = paramNumber(params, "X");
		const y = paramNumber(params, "Y");
		const eParam = paramNumber(params, "E");
		const f = paramNumber(params, "F");
		if (f !== null) {
			if (this.maxFeedrate === null || f > this.maxFeedrate) this.maxFeedrate = f;
			this.lastFeedrateMmPerSec = f / 60; // mm/min -> mm/s, once, at the boundary
		}

		if ((code === "G0" || code === "G1") && this.firstExtrusionLine === null) {
			// Positive in both modes: absolute E starts at 0 so a positive value is genuinely
			// extruding, and in relative mode a retraction is a NEGATIVE E on the very same
			// parameter — "non-zero" alone would wrongly catch that, so positive is what actually
			// distinguishes "extrudes" from "retracts or holds" in either mode
			if (eParam !== null && eParam > 0) this.firstExtrusionLine = this.lines;
		}

		if (x !== null) {
			this.x = relative && prevX !== null ? prevX + x : x;
			if (this.x < this.minX) this.minX = this.x;
			if (this.x > this.maxX) this.maxX = this.x;
		}
		if (y !== null) {
			this.y = relative && prevY !== null ? prevY + y : y;
			if (this.y < this.minY) this.minY = this.y;
			if (this.y > this.maxY) this.maxY = this.y;
		}
		const z = this.state.z;
		if (z !== null) {
			if (z < this.minZ) this.minZ = z;
			if (z > this.maxZ) this.maxZ = z;
		}

		// Same delta convention as `timeModel.ts`: a move's first mention of an axis has no previous
		// position to diff against, so it contributes zero distance on that axis rather than being
		// dropped — rare in practice (the file's very first move), and never the flow peak.
		let deltaE = 0;
		if (eParam !== null) {
			if (this.state.relativeE) {
				deltaE = eParam;
				this.e = (this.e ?? 0) + eParam;
			} else {
				const prevE = this.e ?? 0;
				this.e = eParam;
				deltaE = eParam - prevE;
			}
		}
		// A retraction is a negative delta in either E mode — relative mode writes it directly as a
		// negative E on the line; absolute mode is only visible as this line's E reading lower than
		// the last (which is exactly what `deltaE` already computes above). `G92 E0` never reaches
		// here at all (it is a G92, not G0/G1/G2/G3 — see the `code !== "G0" ...` guard at the top of
		// this method), so resetting the datum can never masquerade as a giant retraction.
		if (deltaE < 0 && this.state.tool >= 0) this.recordRetraction(this.state.tool, -deltaE);
		if (deltaE > 0 && this.filamentArea !== null && this.lastFeedrateMmPerSec !== null && this.lastFeedrateMmPerSec > 0) {
			const dx = x !== null ? this.x! - (prevX ?? 0) : 0;
			const dy = y !== null ? this.y! - (prevY ?? 0) : 0;
			const dz = z !== null && zBeforeLine !== null ? z - zBeforeLine : 0;
			// An arc's own length is not its chord (task 10 finding B) — same fallback rule as
			// timeModel.ts: R-format and a missing/zero I+J are left on the chord rather than guessed.
			let xyLength = Math.hypot(dx, dy);
			if (code === "G2" || code === "G3") {
				const i = paramNumber(params, "I");
				const j = paramNumber(params, "J");
				const r = paramNumber(params, "R");
				if (r === null && i !== null && j !== null && (i !== 0 || j !== 0)) {
					const startX = prevX ?? 0;
					const startY = prevY ?? 0;
					const endX = x !== null ? this.x! : startX;
					const endY = y !== null ? this.y! : startY;
					xyLength = arcMoveLength(startX, startY, endX, endY, i, j, code === "G2");
				}
			}
			const distance = Math.hypot(xyLength, dz);
			if (distance > 0) {
				const flow = (deltaE / distance) * this.lastFeedrateMmPerSec * this.filamentArea;
				if (this.peakFlowMm3PerSec === null || flow > this.peakFlowMm3PerSec) {
					this.peakFlowMm3PerSec = flow;
					this.peakFlowLine = this.lines;
				}
			}
		}

		// Per-feature/layer/object time and filament — independent of whether flow could be computed
		// above (that needs a known filament diameter; this does not). Seconds are 0 without machine
		// limits (no `timeEstimator`), same as everywhere else in this class; filament still counts.
		const moveSeconds = this.timeEstimator?.lastMoveSeconds ?? 0;
		const filamentDelta = Math.max(deltaE, 0);
		if (moveSeconds > 0 || filamentDelta > 0) {
			this.recordFeatureStats(moveSeconds, filamentDelta);
			this.recordLayerStats(moveSeconds, filamentDelta);
			if (this.state.object !== null) this.recordObjectStats(this.state.object, moveSeconds, filamentDelta);
		}
	}

	private recordFeatureStats(seconds: number, filamentMm: number): void {
		const feature = normaliseFeature(this.state.featureType);
		let entry = this.featureStatsMap.get(feature);
		if (entry === undefined) {
			entry = { seconds: 0, filamentMm: 0, moves: 0 };
			this.featureStatsMap.set(feature, entry);
		}
		entry.seconds += seconds;
		entry.filamentMm += filamentMm;
		entry.moves++;
	}

	private recordLayerStats(seconds: number, filamentMm: number): void {
		const layer = this.state.layer;
		let entry = this.layerStatsMap.get(layer);
		if (entry === undefined) {
			entry = { seconds: 0, filamentMm: 0 };
			this.layerStatsMap.set(layer, entry);
		}
		entry.seconds += seconds;
		entry.filamentMm += filamentMm;
	}

	private recordObjectStats(object: string, seconds: number, filamentMm: number): void {
		let entry = this.objectStatsMap.get(object);
		if (entry === undefined) {
			entry = { seconds: 0, filamentMm: 0 };
			this.objectStatsMap.set(object, entry);
		}
		entry.seconds += seconds;
		entry.filamentMm += filamentMm;
	}

	private recordRetraction(tool: number, mm: number): void {
		let entry = this.retractionStatsMap.get(tool);
		if (entry === undefined) {
			entry = { count: 0, totalMm: 0 };
			this.retractionStatsMap.set(tool, entry);
		}
		entry.count++;
		entry.totalMm += mm;
	}

	private applyM(code: string, body: string): void {
		switch (code) {
			case "M104":
			case "M109": {
				const s = paramNumber(parseParams(body), "S");
				if (s !== null && (this.maxToolTemp === null || s > this.maxToolTemp)) this.maxToolTemp = s;
				if (s !== null && s <= 0) this.heatersAddressed = true;
				// M104 only starts heating; M109 (and M116, handled separately below) is what waits
				if (code === "M109" && this.firstHeatWaitLine === null) this.firstHeatWaitLine = this.lines;
				break;
			}
			case "M116": {
				if (this.firstHeatWaitLine === null) this.firstHeatWaitLine = this.lines;
				break;
			}
			case "M140":
			case "M190": {
				const s = paramNumber(parseParams(body), "S");
				if (s !== null && (this.maxBedTemp === null || s > this.maxBedTemp)) this.maxBedTemp = s;
				if (s !== null && s <= 0) this.heatersAddressed = true;
				break;
			}
			case "M141":
			case "M191": {
				const s = paramNumber(parseParams(body), "S");
				if (s !== null && (this.maxChamberTemp === null || s > this.maxChamberTemp)) this.maxChamberTemp = s;
				break;
			}
			case "M568": {
				// A0 = off, A1 = standby — either is "addressed"; A2 (active) is not
				const a = paramNumber(parseParams(body), "A");
				if (a === 0 || a === 1) this.heatersAddressed = true;
				break;
			}
			case "M0":
			case "M2": {
				this.heatersAddressed = true;
				break;
			}
			case "M106": {
				const params = parseParams(body);
				const fan = paramNumber(params, "P") ?? 0;
				this.fanSet.add(fan);
				const speed = paramNumber(params, "S") ?? 0;
				this.recordFanSetting(fan, speed);
				if (speed <= 0) this.fanAddressed = true;
				break;
			}
			case "M107": {
				const fan = paramNumber(parseParams(body), "P") ?? 0;
				this.fanSet.add(fan);
				this.recordFanSetting(fan, 0);
				this.fanAddressed = true;
				break;
			}
			case "M18":
			case "M84": {
				this.motorsAddressed = true;
				break;
			}
			case "M73": {
				if (!this.sawM73) {
					const r = paramNumber(parseParams(body), "R");
					if (r !== null) {
						this.sawM73 = true;
						this.firstM73Minutes = r;
					}
				}
				break;
			}
			case "M486": {
				if (this.state.object !== null) this.objectSet.add(this.state.object);
				break;
			}
			case "M98": {
				const p = findParam(parseParams(body), "P");
				// An expression P (e.g. {var.macroName}) cannot be resolved without running the
				// file, and guessing at it would be worse than not checking it at all
				if (p !== null && !p.value.startsWith("{")) this.recordMacroRef(unquoteString(p.value));
				break;
			}
		}
	}

	/** Record one M106/M107 line under whichever feature is active when it appears. */
	private recordFanSetting(fan: number, speed: number): void {
		// A plain number pair isn't a safe Map key on its own (0 and -0, or ordering ambiguity), so
		// key on their string form instead — cheap, and never wrong
		const key = `${fan} ${speed}`;
		let entry = this.fanSettingsMap.get(key);
		if (entry === undefined) {
			entry = { fan, speed, count: 0, featureCounts: new Map<Feature, number>() };
			this.fanSettingsMap.set(key, entry);
		}
		entry.count++;
		const feature = normaliseFeature(this.state.featureType);
		entry.featureCounts.set(feature, (entry.featureCounts.get(feature) ?? 0) + 1);
	}

	private recordMacroRef(path: string): void {
		let entry = this.macroRefsMap.get(path);
		if (entry === undefined) {
			entry = { path, count: 0, firstLine: this.lines };
			this.macroRefsMap.set(path, entry);
		}
		entry.count++;
	}

	result(): FileAnalysis {
		const hasExtents = Number.isFinite(this.minX) || Number.isFinite(this.minZ);

		const modelSeconds = this.timeEstimator?.elapsed ?? 0;
		const timeSource: FileAnalysis["timeSource"] = this.sawM73
			? "m73"
			: (modelSeconds > 0 ? "model" : "none");
		const estimatedSeconds = this.sawM73
			? (this.firstM73Minutes as number) * 60
			: (timeSource === "model" ? modelSeconds : null);

		return {
			lines: this.lines,
			bytes: this.bytes,
			commandCounts: new Map([...this.counts.entries()].sort((a, b) => b[1] - a[1])),
			layers: this.maxLayer + 1,
			extents: hasExtents
				? {
					minX: finite(this.minX), maxX: finite(this.maxX),
					minY: finite(this.minY), maxY: finite(this.maxY),
					minZ: finite(this.minZ), maxZ: finite(this.maxZ),
				}
				: null,
			tools: [...this.toolSet].sort((a, b) => a - b),
			maxToolTemp: this.maxToolTemp,
			maxBedTemp: this.maxBedTemp,
			maxChamberTemp: this.maxChamberTemp,
			fans: [...this.fanSet].sort((a, b) => a - b),
			fanSettings: [...this.fanSettingsMap.values()]
				.sort((a, b) => b.count - a.count)
				.map((entry) => ({
					fan: entry.fan,
					speed: entry.speed,
					count: entry.count,
					features: [...entry.featureCounts.entries()]
						.sort((a, b) => b[1] - a[1])
						.map(([feature, count]) => ({ feature, count })),
				})),
			objects: [...this.objectSet],
			macroRefs: [...this.macroRefsMap.values()],
			maxFeedrate: this.maxFeedrate,
			usesRelativeE: this.usesRelativeE,
			homes: this.homes,
			firstExtrusionLine: this.firstExtrusionLine,
			firstHeatWaitLine: this.firstHeatWaitLine,
			heatersAddressed: this.heatersAddressed,
			fanAddressed: this.fanAddressed,
			motorsAddressed: this.motorsAddressed,
			timeSource,
			estimatedSeconds,
			dialect: detectDialect(this.counts),
			meta: this.meta,
			peakFlowMm3PerSec: this.peakFlowMm3PerSec,
			peakFlowLine: this.peakFlowLine,
			statedMaxFlowMm3PerSec: this.meta.maxVolumetricSpeedMm3PerSec,
			clampedSeconds: this.timeEstimator?.clampedSeconds ?? null,
			unclampedSeconds: this.timeEstimator?.unclampedSeconds ?? null,
			clampedMoveCount: this.timeEstimator?.clampedMoveCount ?? 0,
			featureStats: [...this.featureStatsMap.entries()]
				.map(([feature, s]) => ({ feature, seconds: s.seconds, filamentMm: s.filamentMm, moves: s.moves }))
				.sort((a, b) => b.seconds - a.seconds || b.filamentMm - a.filamentMm),
			slowestLayers: [...this.layerStatsMap.entries()]
				.map(([layer, s]) => ({ layer, seconds: s.seconds, filamentMm: s.filamentMm }))
				.sort((a, b) => b.seconds - a.seconds || b.filamentMm - a.filamentMm)
				.slice(0, MAX_REPORTED_LAYERS),
			objectStats: [...this.objectStatsMap.entries()]
				.map(([object, s]) => ({ object, seconds: s.seconds, filamentMm: s.filamentMm }))
				.sort((a, b) => b.seconds - a.seconds || b.filamentMm - a.filamentMm),
			retractionStats: [...this.retractionStatsMap.entries()]
				.map(([tool, s]) => ({ tool, count: s.count, totalMm: s.totalMm }))
				.sort((a, b) => a.tool - b.tool),
		};
	}
}

/** Convenience for tests and small files. */
export function analyseText(text: string, meta?: SlicerMetadata, limits?: MachineLimits): FileAnalysis {
	const analyser = new Analyser(meta, limits);
	for (const rawLine of text.split("\n")) {
		analyser.line(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
	}
	return analyser.result();
}

function bump(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function finite(value: number): number {
	return Number.isFinite(value) ? value : 0;
}
