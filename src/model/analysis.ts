/**
 * Single-pass file analysis: what is actually in this G-code.
 *
 * Drives the inspector and the preflight checks from one read, using the same push-per-line shape
 * as the pipeline so the chunked reader can feed either (or both) without knowing the difference.
 */

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
}

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
	private readonly timeEstimator: TimeEstimator | null;
	/** True once an M73 with a parseable R has been seen — the file states its own time. */
	private sawM73 = false;
	/** Total minutes from the FIRST such M73 — later ones only narrow toward zero as printing
	 *  progresses, so the first is what states the whole print's length. */
	private firstM73Minutes: number | null = null;

	constructor(private readonly meta: SlicerMetadata = emptyMetadata(), limits?: MachineLimits) {
		this.state = createState({ geometricFallback: !meta.hasLayerMarkers });
		this.timeEstimator = limits !== undefined ? new TimeEstimator(limits) : null;
	}

	line(raw: string): void {
		this.lines++;
		this.bytes += raw.length + 1;

		const token = tokenise(raw);
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
			this.applyG(code, token.body);
			return;
		}
		this.applyM(code, token.body);
	}

	private applyG(code: string, body: string): void {
		if (code === "G28") { this.homes = true; return; }
		if (code !== "G0" && code !== "G1" && code !== "G2" && code !== "G3") return;

		const params = parseParams(body);
		const relative = this.state.relativeMoves;
		const x = paramNumber(params, "X");
		const y = paramNumber(params, "Y");
		const f = paramNumber(params, "F");
		if (f !== null && (this.maxFeedrate === null || f > this.maxFeedrate)) this.maxFeedrate = f;

		if ((code === "G0" || code === "G1") && this.firstExtrusionLine === null) {
			const e = paramNumber(params, "E");
			// Positive in both modes: absolute E starts at 0 so a positive value is genuinely
			// extruding, and in relative mode a retraction is a NEGATIVE E on the very same
			// parameter — "non-zero" alone would wrongly catch that, so positive is what actually
			// distinguishes "extrudes" from "retracts or holds" in either mode
			if (e !== null && e > 0) this.firstExtrusionLine = this.lines;
		}

		if (x !== null) {
			this.x = relative && this.x !== null ? this.x + x : x;
			if (this.x < this.minX) this.minX = this.x;
			if (this.x > this.maxX) this.maxX = this.x;
		}
		if (y !== null) {
			this.y = relative && this.y !== null ? this.y + y : y;
			if (this.y < this.minY) this.minY = this.y;
			if (this.y > this.maxY) this.maxY = this.y;
		}
		const z = this.state.z;
		if (z !== null) {
			if (z < this.minZ) this.minZ = z;
			if (z > this.maxZ) this.maxZ = z;
		}
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
