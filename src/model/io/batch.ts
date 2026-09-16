/**
 * Batch processing (D6): one recipe and one output mode, applied over several files in one go —
 * with per-file multi-select coming from `GcodeBrowser`'s selection mode (A2).
 *
 * Serial, not concurrent — one file's whole read-transform-write pass runs on the main thread before
 * the next starts, which is also what keeps a single `signal` meaningful: checked between files as
 * well as inside `processFile` itself, so Cancel aborts the rest of the batch, not just the file in
 * flight.
 *
 * **Does not stop on the first failure.** Stopping halfway through a run of 40 files leaves the user
 * with no idea which ones were done; a per-file outcome plus carrying on is strictly more useful.
 * A file whose own safety check blocks it is `"skipped"`, with the reason recorded — never treated
 * as a `"failed"` file, and never silently dropped.
 *
 * One recipe and one output mode for the whole batch, deliberately: per-file recipe selection (via
 * `model/recipeMatch.ts`) is a separate, later idea, not built here.
 */

import { recordRun, toFailedHistoryEntry, toHistoryEntry } from "./history";
import type { Recipe } from "../recipe";
import { blocking, checkSafety, planOutput, type OutputMode, type SafetyIssue } from "./plan";
import {
	processFile, type AbortSignalLike, type FileGateway, type ProcessOptions, type ProcessResult,
} from "./transfer";

export interface BatchFileOutcome {
	path: string;
	outcome: "done" | "skipped" | "failed";
	result?: ProcessResult;
	error?: string;
	/** Present for "skipped" — the safety issue's own message. */
	reason?: string;
}

export interface RunBatchOptions {
	gateway: FileGateway;
	paths: ReadonlyArray<string>;
	recipe: Recipe;
	mode: OutputMode;
	suffix?: string;
	folder?: string;
	pluginVersion: string;
	rrfVersion?: string | null;
	scriptsTrusted: boolean;
	limits?: ProcessOptions["limits"];
	toolHeaters?: ProcessOptions["toolHeaters"];
	jobFileName: string | null;
	machineStatus: string | null;
	signal?: AbortSignalLike;
	onFileStart?: (path: string, index: number, total: number) => void;
	onFileDone?: (outcome: BatchFileOutcome, index: number, total: number) => void;
	now?: Date;
}

/**
 * True when this batch, run with `mode`, would overwrite more than `cap` files in place — the
 * backup index prunes at that cap (`MAX_BACKUPS`), so a large in-place batch silently drops its own
 * earliest backups as it goes. Pure, so the confirmation dialog can check it before anything runs.
 */
export function exceedsBackupCap(mode: OutputMode, fileCount: number, cap: number): boolean {
	return mode === "inPlace" && fileCount > cap;
}

/**
 * Run the batch. Never throws — a cancel (checked between files, and passed down as `signal` so
 * `processFile` also honours it inside a file already in progress) simply stops the loop early;
 * the caller reads how far it got from the length of the returned array against `paths.length`.
 * An individual file's own failure is recorded as a `"failed"` outcome, never thrown.
 */
export async function runBatch(options: RunBatchOptions): Promise<Array<BatchFileOutcome>> {
	const { gateway, paths, recipe, signal } = options;
	const outcomes: Array<BatchFileOutcome> = [];

	for (let i = 0; i < paths.length; i++) {
		if (signal?.aborted === true) break;
		const path = paths[i];
		options.onFileStart?.(path, i, paths.length);

		const plan = planOutput({
			sourcePath: path, mode: options.mode, suffix: options.suffix, folder: options.folder, now: options.now,
		});

		// Deliberately no download/prescan here. `checkSafety`'s only use for a file's head is the
		// `existingStamp` "already processed" notice, which it returns at warn level — and this loop
		// acts on `blocking()` alone, so that notice changed nothing while costing a second full
		// transfer of every file in the batch. `processFile` prescans the copy it downloads anyway,
		// and hands the stamp back on `ProcessResult.existingStamp`, which is where the outcome
		// below reports it from.
		let sizeBytes: number | null = null;
		try {
			sizeBytes = await gateway.sizeOf(path);
		} catch {
			// An unreadable listing is not evidence of anything; the large-file notice is advisory
		}

		let targetExists = false;
		try {
			targetExists = plan.targetPath !== path && (await gateway.sizeOf(plan.targetPath)) !== null;
		} catch {
			// A failed listing is not evidence either way; leave the warning off, matching the
			// single-file page's own behaviour
		}

		const issues: Array<SafetyIssue> = checkSafety({
			sourcePath: path,
			plan,
			jobFileName: options.jobFileName,
			status: options.machineStatus,
			sizeBytes,
			existingStamp: null,
			targetExists,
			recipe,
		});
		const blockers = blocking(issues);
		if (blockers.length > 0) {
			const outcome: BatchFileOutcome = { path, outcome: "skipped", reason: blockers[0].message };
			outcomes.push(outcome);
			options.onFileDone?.(outcome, i, paths.length);
			continue;
		}

		try {
			const result = await processFile({
				gateway,
				sourcePath: path,
				recipe,
				plan,
				pluginVersion: options.pluginVersion,
				rrfVersion: options.rrfVersion,
				scriptsTrusted: options.scriptsTrusted,
				dryRun: false,
				limits: options.limits,
				toolHeaters: options.toolHeaters,
				signal,
				now: options.now,
			});
			const outcome: BatchFileOutcome = { path, outcome: "done", result };
			outcomes.push(outcome);
			await recordRun(gateway, toHistoryEntry(result, recipe, path, "batch", options.now));
			options.onFileDone?.(outcome, i, paths.length);
		} catch (e) {
			// A cancel mid-file is not a failure of the file — it is the reason the loop is about to
			// stop, so no outcome is recorded for the file that was interrupted
			if ((e as Error).name === "CancelledError") break;
			const outcome: BatchFileOutcome = { path, outcome: "failed", error: (e as Error).message };
			outcomes.push(outcome);
			await recordRun(gateway, toFailedHistoryEntry(path, recipe, "batch", e as Error, options.now));
			options.onFileDone?.(outcome, i, paths.length);
		}
	}

	return outcomes;
}
