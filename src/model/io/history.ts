/**
 * Run history: what ran, on what, when, with what result — D8. Only applied runs are recorded, never
 * dry runs (a preview is cheap and frequent, and the Preview tab already shows the current one).
 *
 * Same shape and the same parsing tolerance as `backups.ts`, deliberately: this lives on the same SD
 * card, can be pulled mid-write the same way, and a missing, empty, truncated or malformed index is
 * "no history yet" rather than an error. A single corrupted entry is dropped rather than discarding
 * every run's record along with it. Read `backups.ts`'s header comment for the reasoning in full; it
 * transfers wholesale.
 *
 * Not the plugin settings bag: recipes live there because they are small and hand-edited, and that
 * bag is written back to the board on every change. History grows on every run and would bloat it.
 */

import { HISTORY_INDEX, MAX_HISTORY } from "../constants";
import { recipeHash, type Recipe } from "../recipe";
import type { FileGateway, ProcessResult } from "./transfer";

/** Where a run was started from — the one fact that answers "did the auto-runner do this?" once
 *  auto-run (D5) exists. */
export type RunOrigin = "page" | "widget" | "auto" | "batch";

export interface HistoryEntry {
	at: string;
	sourcePath: string;
	targetPath: string;
	recipeName: string;
	recipeHash: string;
	linesChanged: number;
	linesAdded: number;
	linesRemoved: number;
	bytesIn: number;
	bytesOut: number;
	durationMs: number;
	backupPath: string | null;
	warnings: Array<string>;
	origin: RunOrigin;
	ok: boolean;
	error?: string;
}

const ORIGINS: ReadonlyArray<RunOrigin> = ["page", "widget", "auto", "batch"];

function isValidEntry(value: unknown): value is HistoryEntry {
	if (typeof value !== "object" || value === null) return false;
	const e = value as Record<string, unknown>;
	return typeof e.at === "string" && e.at !== ""
		&& typeof e.sourcePath === "string" && e.sourcePath !== ""
		&& typeof e.targetPath === "string"
		&& typeof e.recipeName === "string"
		&& typeof e.recipeHash === "string"
		&& typeof e.linesChanged === "number" && Number.isFinite(e.linesChanged)
		&& typeof e.linesAdded === "number" && Number.isFinite(e.linesAdded)
		&& typeof e.linesRemoved === "number" && Number.isFinite(e.linesRemoved)
		&& typeof e.bytesIn === "number" && Number.isFinite(e.bytesIn)
		&& typeof e.bytesOut === "number" && Number.isFinite(e.bytesOut)
		&& typeof e.durationMs === "number" && Number.isFinite(e.durationMs)
		&& (e.backupPath === null || typeof e.backupPath === "string")
		&& Array.isArray(e.warnings) && e.warnings.every((w) => typeof w === "string")
		&& typeof e.origin === "string" && ORIGINS.includes(e.origin as RunOrigin)
		&& typeof e.ok === "boolean";
}

/** Parse the index. Never throws: a missing, empty, truncated or malformed file all resolve to no
 *  history known. */
export function parseHistory(json: string): Array<HistoryEntry> {
	if (json.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isValidEntry);
}

/** Add an entry, newest first. Does not mutate the input. */
export function addRun(history: Array<HistoryEntry>, entry: HistoryEntry): Array<HistoryEntry> {
	return [entry, ...history];
}

/** Split a history (assumed newest-first) into what to keep once there are more than `max`. */
export function pruneHistory(history: Array<HistoryEntry>, max: number): Array<HistoryEntry> {
	return history.slice(0, max);
}

export function serialiseHistory(history: Array<HistoryEntry>): string {
	return JSON.stringify(history, null, "\t");
}

/** Build a history entry from a successful, applied `ProcessResult`. Shared by every caller that
 *  applies a recipe (the page, the widget, auto-run, batch) so the shape stays in one place. */
export function toHistoryEntry(
	result: ProcessResult, recipe: Recipe, sourcePath: string, origin: RunOrigin, now = new Date(),
): HistoryEntry {
	return {
		at: now.toISOString(),
		sourcePath,
		targetPath: result.targetPath,
		recipeName: recipe.name,
		recipeHash: recipeHash(recipe),
		linesChanged: result.stats.linesChanged,
		linesAdded: result.stats.linesAdded,
		linesRemoved: result.stats.linesRemoved,
		bytesIn: result.bytesIn,
		bytesOut: result.bytesOut,
		durationMs: result.durationMs,
		backupPath: result.backupPath,
		warnings: result.stats.warnings,
		origin,
		ok: true,
	};
}

/** Build a history entry for a run that failed with a real error (never for a cancellation — see
 *  the callers' own catch blocks, which must not call this for a `CancelledError`). */
export function toFailedHistoryEntry(
	sourcePath: string, recipe: Recipe, origin: RunOrigin, error: Error, now = new Date(),
): HistoryEntry {
	return {
		at: now.toISOString(),
		sourcePath,
		targetPath: "",
		recipeName: recipe.name,
		recipeHash: recipeHash(recipe),
		linesChanged: 0, linesAdded: 0, linesRemoved: 0,
		bytesIn: 0, bytesOut: 0,
		durationMs: 0,
		backupPath: null,
		warnings: [],
		origin,
		ok: false,
		error: error.message,
	};
}

/**
 * Record one run in the history index. Never throws: a run that already succeeded (or already
 * failed on its own terms) must not additionally fail because the history write did — the same rule
 * `updateBackupIndex` (`io/transfer.ts`) follows, for the same reason.
 */
export async function recordRun(gateway: FileGateway, entry: HistoryEntry): Promise<void> {
	let existingText = "";
	try {
		existingText = await (await gateway.download(HISTORY_INDEX)).text();
	} catch {
		// No index yet — the common case on first use; treat it as empty rather than a failure
	}
	try {
		const history = pruneHistory(addRun(parseHistory(existingText), entry), MAX_HISTORY);
		await gateway.upload(HISTORY_INDEX, new Blob([serialiseHistory(history)], { type: "application/json" }));
	} catch {
		// The run itself already completed (or already failed on its own terms); losing the history
		// write must not turn a successful run into a failed one
	}
}
