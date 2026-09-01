/**
 * A one-paragraph, plain-English description of a file, built entirely from `FileAnalysis` — for a
 * user who wants "what is this file" without reading a table of numbers. Pure and deterministic:
 * the same analysis always produces the same sentence, so it is exactly as testable as anything
 * else in `model/`.
 *
 * Says nothing about a fact `FileAnalysis` does not have (an unrecognised slicer, a missing extent,
 * an unknown flow figure are all simply left out of the sentence, not guessed at or defaulted).
 */

import type { FileAnalysis } from "./analysis";

function formatDurationWords(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	if (h === 0) return `${m} minute${m === 1 ? "" : "s"}`;
	if (m === 0) return `${h} hour${h === 1 ? "" : "s"}`;
	return `${h} hour${h === 1 ? "" : "s"} ${m} minute${m === 1 ? "" : "s"}`;
}

/** Builds the sentence's clauses in a fixed order, joined with commas — the order is chosen to read
 *  naturally, not to reflect any priority among the facts themselves. */
export function summariseFile(a: FileAnalysis): string {
	const clauses: Array<string> = [];

	const slicerName = a.meta.slicer === "unknown" ? null : a.meta.slicer;
	clauses.push(
		slicerName === null
			? "sliced by an unrecognised slicer"
			: `sliced by ${slicerName}${a.meta.slicerVersion !== null ? ` ${a.meta.slicerVersion}` : ""}`,
	);

	if (a.layers > 0) {
		const height = a.extents !== null ? ` (${a.extents.maxZ.toFixed(1)}mm tall)` : "";
		clauses.push(`${a.layers.toLocaleString()} layer${a.layers === 1 ? "" : "s"}${height}`);
	}

	if (a.tools.length > 0) {
		clauses.push(`using tool${a.tools.length === 1 ? "" : "s"} ${a.tools.map((t) => `T${t}`).join(", ")}`);
	}

	if (a.estimatedSeconds !== null) {
		const source = a.timeSource === "m73" ? "the slicer's own estimate" : "this machine's own limits";
		clauses.push(`estimated to take ${formatDurationWords(a.estimatedSeconds)} (from ${source})`);
	}

	if (a.meta.filamentMm !== null) {
		clauses.push(`uses ${(a.meta.filamentMm / 1000).toFixed(1)}m of filament`);
	}

	if (a.peakFlowMm3PerSec !== null) {
		clauses.push(`a peak flow of ${a.peakFlowMm3PerSec.toFixed(1)} mm³/s`);
	}

	if (a.objects.length > 0) {
		clauses.push(`${a.objects.length} labelled object${a.objects.length === 1 ? "" : "s"}`);
	}

	if (clauses.length === 0) return "Nothing identifiable was found in this file.";

	const sentence = clauses.join(", ");
	return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}
