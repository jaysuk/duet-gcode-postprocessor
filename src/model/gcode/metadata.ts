/**
 * Slicer metadata extraction.
 *
 * Every slicer stamps its settings into the file as comments, in its own dialect, and in its own
 * place — PrusaSlicer/Orca write a `key = value` block at the *end*, Cura writes `;KEY:value` at
 * the top, Simplify3D writes `;   key,value` at the top. The transfer layer pre-scans the head and
 * tail of the file and hands both to `parseMetadata`, so steps and preflight checks can read
 * `meta.values.get("layer_height")` without a full pass.
 */

export type SlicerName =
	| "PrusaSlicer" | "SuperSlicer" | "OrcaSlicer" | "BambuStudio" | "Slic3r"
	| "Cura" | "Simplify3D" | "ideaMaker" | "KISSlicer" | "unknown";

export interface SlicerMetadata {
	slicer: SlicerName;
	slicerVersion: string | null;
	/** Normalised key -> value, lower-cased keys with spaces collapsed to underscores. */
	values: Map<string, string>;
	/** Total layer count when the slicer states it, else null. */
	totalLayers: number | null;
	/** Estimated print time in seconds when stated, else null. */
	printTimeSeconds: number | null;
	/** Filament used in mm when stated, else null. */
	filamentMm: number | null;
	/** Layer height in mm when stated, else null. */
	layerHeight: number | null;
	/** True when the file carries an embedded base64 thumbnail block. */
	hasThumbnail: boolean;
	/**
	 * True when the head or tail contains a slicer layer-change marker. Drives whether the state
	 * machine is allowed to guess layer changes from Z moves — see `createState`.
	 */
	hasLayerMarkers: boolean;
}

export function emptyMetadata(): SlicerMetadata {
	return {
		slicer: "unknown",
		slicerVersion: null,
		values: new Map(),
		totalLayers: null,
		printTimeSeconds: null,
		filamentMm: null,
		layerHeight: null,
		hasThumbnail: false,
		hasLayerMarkers: false,
	};
}

/** Any of the layer-change marker comments the state machine understands. */
const RE_ANY_LAYER_MARKER = /^;\s*(?:(?:AFTER_|BEFORE_)?LAYER_CHANGE\s*$|LAYER:\s*-?\d+\s*$)|^;\s*layer\s+\d+\s*,/im;

const SLICER_PATTERNS: Array<{ re: RegExp; name: SlicerName }> = [
	{ re: /generated\s+by\s+SuperSlicer\s+([\w.+-]+)/i, name: "SuperSlicer" },
	{ re: /generated\s+by\s+OrcaSlicer\s+([\w.+-]+)/i, name: "OrcaSlicer" },
	{ re: /generated\s+by\s+BambuStudio\s+([\w.+-]+)/i, name: "BambuStudio" },
	{ re: /generated\s+by\s+PrusaSlicer\s+([\w.+-]+)/i, name: "PrusaSlicer" },
	{ re: /generated\s+by\s+Slic3r\s+([\w.+-]+)/i, name: "Slic3r" },
	{ re: /Generated\s+with\s+Cura_SteamEngine\s+([\w.+-]+)/i, name: "Cura" },
	{ re: /G-?Code\s+generated\s+by\s+Simplify3D\D*([\w.+-]+)/i, name: "Simplify3D" },
	{ re: /Sliced\s+by\s+ideaMaker\s+([\w.+-]+)/i, name: "ideaMaker" },
	{ re: /KISSlicer\D*([\w.+-]+)/i, name: "KISSlicer" },
];

/** `; key = value` (PrusaSlicer family) */
const RE_EQUALS = /^\s*([A-Za-z][\w .\[\]()%-]*?)\s*=\s*(.*)$/;
/** `;KEY:value` (Cura, ideaMaker) */
const RE_COLON = /^\s*([A-Za-z][\w .\[\]()%-]*?)\s*:\s*(.*)$/;
/** `;   key,value` (Simplify3D) */
const RE_COMMA = /^\s{2,}([A-Za-z][\w .\[\]()%-]*?),(.*)$/;

/**
 * Parse metadata out of the comment lines of a file's head and tail.
 *
 * Only comment lines are considered, so passing a whole file works but is wasteful — pass the
 * pre-scanned head and tail instead.
 */
export function parseMetadata(head: string, tail = ""): SlicerMetadata {
	const meta = emptyMetadata();
	const text = tail && tail !== head ? `${head}\n${tail}` : head;

	for (const pattern of SLICER_PATTERNS) {
		const m = pattern.re.exec(text);
		if (m !== null) {
			meta.slicer = pattern.name;
			meta.slicerVersion = m[1] ?? null;
			break;
		}
	}

	for (const rawLine of text.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line.startsWith(";")) continue;
		const comment = line.slice(1);

		if (/^\s*thumbnail(_[A-Z]+)?\s+begin/i.test(comment)) {
			meta.hasThumbnail = true;
			continue;
		}

		const m = RE_EQUALS.exec(comment) ?? RE_COLON.exec(comment) ?? RE_COMMA.exec(comment);
		if (m === null) continue;
		const key = normaliseKey(m[1]);
		const value = m[2].trim();
		if (key.length === 0 || value.length === 0) continue;
		// First writer wins: the head block is the authoritative "what this print is" summary, and
		// the Prusa footer repeats every setting including ones that would shadow it
		if (!meta.values.has(key)) meta.values.set(key, value);
	}

	meta.hasLayerMarkers = RE_ANY_LAYER_MARKER.test(text);
	meta.totalLayers = firstNumber(meta, ["total_layers_count", "total_layer_count", "layer_count", "layercount"]);
	meta.layerHeight = firstNumber(meta, ["layer_height", "layerheight"]);
	meta.printTimeSeconds = extractPrintTime(meta);
	meta.filamentMm = firstNumber(meta, [
		"filament_used_mm", "filament_used_[mm]", "filament_length", "filament_used",
	]);
	return meta;
}

function normaliseKey(key: string): string {
	return key.trim().toLowerCase().replace(/\s+/g, "_");
}

function firstNumber(meta: SlicerMetadata, keys: Array<string>): number | null {
	for (const key of keys) {
		const raw = meta.values.get(key);
		if (raw === undefined) continue;
		const n = Number(raw.replace(/[^\d.eE+-].*$/, ""));
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function extractPrintTime(meta: SlicerMetadata): number | null {
	// Cura states it in seconds; the Prusa family states it as "2h 13m 5s"
	const seconds = firstNumber(meta, ["time", "print_time", "time_elapsed"]);
	if (seconds !== null && seconds > 0) return seconds;
	for (const key of ["estimated_printing_time_(normal_mode)", "estimated_printing_time", "estimated_print_time"]) {
		const raw = meta.values.get(key);
		if (raw !== undefined) {
			const parsed = parseDuration(raw);
			if (parsed !== null) return parsed;
		}
	}
	return null;
}

/** Parse "2h 13m 5s" / "1d 4h" style durations into seconds. */
export function parseDuration(text: string): number | null {
	const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
	let total = 0;
	let matched = false;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		matched = true;
		const value = Number(m[1]);
		switch (m[2].toLowerCase()) {
			case "d": total += value * 86400; break;
			case "h": total += value * 3600; break;
			case "m": total += value * 60; break;
			case "s": total += value; break;
		}
	}
	return matched ? total : null;
}
