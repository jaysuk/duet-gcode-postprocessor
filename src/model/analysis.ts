/**
 * Single-pass file analysis: what is actually in this G-code.
 *
 * Drives the inspector and the preflight checks from one read, using the same push-per-line shape
 * as the pipeline so the chunked reader can feed either (or both) without knowing the difference.
 */

import { emptyMetadata, type SlicerMetadata } from "./gcode/metadata";
import { bareMacroName, detectDialect, type DialectReport } from "./gcode/dialect";
import { advance, createState, type MachineState } from "./gcode/state";
import { paramNumber, parseParams, tokenise } from "./gcode/tokenise";

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
	/** Fan indices referenced by M106 P. */
	fans: Array<number>;
	/** Object labels seen in M486. */
	objects: Array<string>;
	/** Highest feedrate commanded (mm/min). */
	maxFeedrate: number | null;
	/** True when the file uses relative extrusion at any point. */
	usesRelativeE: boolean;
	/** True when a homing command appears anywhere. */
	homes: boolean;
	dialect: DialectReport;
	meta: SlicerMetadata;
}

export class Analyser {
	private readonly state: MachineState;
	private readonly counts = new Map<string, number>();
	private readonly toolSet = new Set<number>();
	private readonly fanSet = new Set<number>();
	private readonly objectSet = new Set<string>();

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
	private x: number | null = null;
	private y: number | null = null;

	constructor(private readonly meta: SlicerMetadata = emptyMetadata()) {
		this.state = createState({ geometricFallback: !meta.hasLayerMarkers });
	}

	line(raw: string): void {
		this.lines++;
		this.bytes += raw.length + 1;

		const token = tokenise(raw);
		advance(this.state, token);
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
				break;
			}
			case "M140":
			case "M190": {
				const s = paramNumber(parseParams(body), "S");
				if (s !== null && (this.maxBedTemp === null || s > this.maxBedTemp)) this.maxBedTemp = s;
				break;
			}
			case "M141":
			case "M191": {
				const s = paramNumber(parseParams(body), "S");
				if (s !== null && (this.maxChamberTemp === null || s > this.maxChamberTemp)) this.maxChamberTemp = s;
				break;
			}
			case "M106": {
				const p = paramNumber(parseParams(body), "P");
				this.fanSet.add(p ?? 0);
				break;
			}
			case "M486": {
				if (this.state.object !== null) this.objectSet.add(this.state.object);
				break;
			}
		}
	}

	result(): FileAnalysis {
		const hasExtents = Number.isFinite(this.minX) || Number.isFinite(this.minZ);
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
			objects: [...this.objectSet],
			maxFeedrate: this.maxFeedrate,
			usesRelativeE: this.usesRelativeE,
			homes: this.homes,
			dialect: detectDialect(this.counts),
			meta: this.meta,
		};
	}
}

/** Convenience for tests and small files. */
export function analyseText(text: string, meta?: SlicerMetadata): FileAnalysis {
	const analyser = new Analyser(meta);
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
