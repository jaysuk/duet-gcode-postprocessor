/**
 * Compares two files' own `FileAnalysis` — the facts that actually distinguish one file from
 * another (time, filament, temperatures, limits), not a line-by-line text diff of their G-code.
 * Pure and deterministic, the same shape as `summariseFile`: build the row list, let a component
 * render it.
 */

import type { FileAnalysis } from "./analysis";
import { formatBytes, formatDuration } from "./io/plan";

export interface ComparisonRow {
	label: string;
	a: string;
	b: string;
	/** False when `a` and `b` render to different text — the UI's cue for what to highlight. Always
	 *  true for a row that is only ever informational (never computed from a value that could differ
	 *  meaningfully, e.g. neither file's own path) — no such rows exist below, but the field is on
	 *  every row rather than optional so a caller never has to null-check it. */
	same: boolean;
}

function row(label: string, a: string, b: string): ComparisonRow {
	return { label, a, b, same: a === b };
}

function durationOrDash(seconds: number | null): string {
	return seconds === null ? "—" : formatDuration(seconds);
}

function metresOrDash(mm: number | null): string {
	return mm === null ? "—" : `${(mm / 1000).toFixed(2)} m`;
}

function tempOrDash(c: number | null): string {
	return c === null ? "—" : `${c} °C`;
}

function slicerLabel(a: FileAnalysis): string {
	return a.meta.slicer === "unknown" ? "not recognised" : `${a.meta.slicer} ${a.meta.slicerVersion ?? ""}`.trim();
}

function toolsLabel(a: FileAnalysis): string {
	return a.tools.length === 0 ? "none" : a.tools.map((t) => `T${t}`).join(", ");
}

/** The machine-estimate row needs its source named, the same way `FileInspector`'s own "Print time
 *  (this machine)" stat does — a bare number with no source is not comparable across two files that
 *  might each have got theirs a different way (one from `M73`, one modelled). */
function machineTimeLabel(a: FileAnalysis): string {
	if (a.estimatedSeconds === null) return "—";
	const duration = formatDuration(a.estimatedSeconds);
	switch (a.timeSource) {
		case "m73": return `${duration} (from M73)`;
		case "model": return `${duration} (modelled)`;
		default: return duration;
	}
}

export function compareAnalyses(a: FileAnalysis, b: FileAnalysis): Array<ComparisonRow> {
	return [
		row("Slicer", slicerLabel(a), slicerLabel(b)),
		row("Size", formatBytes(a.bytes), formatBytes(b.bytes)),
		row("Lines", a.lines.toLocaleString(), b.lines.toLocaleString()),
		row("Layers", a.layers.toLocaleString(), b.layers.toLocaleString()),
		row("Print time (slicer)", durationOrDash(a.meta.printTimeSeconds), durationOrDash(b.meta.printTimeSeconds)),
		row("Print time (this machine)", machineTimeLabel(a), machineTimeLabel(b)),
		row("Filament", metresOrDash(a.meta.filamentMm), metresOrDash(b.meta.filamentMm)),
		row("Tools used", toolsLabel(a), toolsLabel(b)),
		row("Hot end", tempOrDash(a.maxToolTemp), tempOrDash(b.maxToolTemp)),
		row("Bed", tempOrDash(a.maxBedTemp), tempOrDash(b.maxBedTemp)),
		row("Max feedrate", a.maxFeedrate === null ? "—" : `${a.maxFeedrate} mm/min`,
			b.maxFeedrate === null ? "—" : `${b.maxFeedrate} mm/min`),
		row("Extrusion mode", a.usesRelativeE ? "relative (M83)" : "absolute (M82)",
			b.usesRelativeE ? "relative (M83)" : "absolute (M82)"),
		row("Moves over this machine's limits", a.clampedMoveCount.toLocaleString(), b.clampedMoveCount.toLocaleString()),
		row("Objects (M486)", a.objects.length.toLocaleString(), b.objects.length.toLocaleString()),
	];
}
