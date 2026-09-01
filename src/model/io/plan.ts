/**
 * Where the output goes, and whether it is safe to put it there.
 *
 * Pure on purpose: the rules that stop this plugin destroying a good print file are the ones most
 * worth testing, and they should not need a machine, a store or a mocked connector to exercise.
 */

import { BACKUP_DIR, LARGE_FILE_WARN_BYTES } from "../constants";
import type { Recipe, Stamp } from "../recipe";

export type OutputMode = "inPlace" | "alongside" | "folder";

export interface OutputPlanInput {
	sourcePath: string;
	mode: OutputMode;
	/** Suffix inserted before the extension for "alongside". Default ".pp". */
	suffix?: string;
	/** Destination directory for "folder". */
	folder?: string;
	/** Used to make the backup name unique. */
	now?: Date;
}

export interface OutputPlan {
	targetPath: string;
	/** Upload here first, then move onto the target — an interrupted upload never eats the original. */
	tempPath: string;
	/** Where the original is copied before an in-place overwrite, or null when not overwriting. */
	backupPath: string | null;
	overwritesSource: boolean;
	/**
	 * Components `backupPath` was built from, so the transfer layer can try successive suffixed
	 * names (see {@link backupCandidatePath}) if this exact one collides with a backup already taken
	 * in the same second from a different folder. Null when not overwriting.
	 */
	backupNaming: { stem: string; ts: string; ext: string } | null;
}

export function dirName(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

export function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

export function splitExtension(name: string): { stem: string; ext: string } {
	const index = name.lastIndexOf(".");
	return index <= 0 ? { stem: name, ext: "" } : { stem: name.slice(0, index), ext: name.slice(index) };
}

/** Work out the target, temp and backup paths for a run. */
export function planOutput(input: OutputPlanInput): OutputPlan {
	const dir = dirName(input.sourcePath);
	const name = baseName(input.sourcePath);
	const { stem, ext } = splitExtension(name);
	const now = input.now ?? new Date();

	let targetPath: string;
	switch (input.mode) {
		case "inPlace":
			targetPath = input.sourcePath;
			break;
		case "alongside": {
			const suffix = input.suffix === undefined || input.suffix === "" ? ".pp" : input.suffix;
			targetPath = `${dir}/${stem}${suffix}${ext}`;
			break;
		}
		case "folder": {
			const folder = (input.folder ?? dir).replace(/\/+$/, "");
			targetPath = `${folder}/${name}`;
			break;
		}
	}

	const overwritesSource = targetPath === input.sourcePath;
	const backupNaming = overwritesSource ? { stem, ts: timestamp(now), ext } : null;
	return {
		targetPath,
		// Deliberately NOT under WORK_DIR: this has to be on the same volume and in the same
		// directory as the target so the temp-then-move at write time is a rename, not a copy. It
		// only exists for the seconds the upload takes.
		tempPath: `${targetPath}.pp.tmp`,
		backupPath: backupNaming === null ? null : backupCandidatePath(backupNaming.stem, backupNaming.ts, backupNaming.ext, 0),
		overwritesSource,
		backupNaming,
	};
}

function timestamp(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Backup filename for the nth naming attempt. Attempt 0 is the plain `<stem>.<timestamp><ext>`;
 * later attempts append `-2`, `-3`, … so two files with the same stem, backed up from different
 * folders in the same second, do not silently overwrite one another's backup — see
 * `resolveUniqueBackupPath` in `io/transfer.ts`, which is what actually tries them in order.
 */
export function backupCandidatePath(stem: string, ts: string, ext: string, attempt: number): string {
	const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
	return `${BACKUP_DIR}/${stem}.${ts}${suffix}${ext}`;
}

// #region Safety

export type SafetyLevel = "block" | "warn";

export interface SafetyIssue {
	level: SafetyLevel;
	code: string;
	message: string;
}

export interface SafetyInput {
	sourcePath: string;
	plan: OutputPlan;
	/** `job.file.fileName` from the object model, or null when nothing is printing. */
	jobFileName: string | null;
	/** Machine status string from the object model, lower-cased. */
	status: string | null;
	/** Size of the source file in bytes, or null when unknown. */
	sizeBytes: number | null;
	/** An existing stamp for this exact recipe, from the file's head. */
	existingStamp: Stamp | null;
	/** True when the target already exists and is not the source. */
	targetExists: boolean;
	recipe: Recipe;
}

/** Object-model `state.status` values meaning the machine is doing something time-sensitive with the
 *  SD card or the motion system — shared with `io/simulate.ts`, which must not start a simulation
 *  (or believe an old one already finished) while one of these is true. */
export const BUSY_STATES = ["processing", "simulating", "resuming", "pausing"];

/**
 * Everything that could go wrong with writing this file, in one list. `block` issues stop the run;
 * `warn` issues need a confirmation but are legitimate choices.
 */
export function checkSafety(input: SafetyInput): Array<SafetyIssue> {
	const issues: Array<SafetyIssue> = [];
	const status = (input.status ?? "").toLowerCase();

	if (input.jobFileName !== null && samePath(input.jobFileName, input.sourcePath)) {
		issues.push({
			level: "block",
			code: "sourceIsJob",
			message: "This file is the current print job. Processing it now would rewrite the file the printer is reading.",
		});
	}
	if (input.jobFileName !== null && samePath(input.jobFileName, input.plan.targetPath)) {
		issues.push({
			level: "block",
			code: "targetIsJob",
			message: "The output would overwrite the file the printer is currently reading.",
		});
	}
	if (BUSY_STATES.includes(status) && input.plan.overwritesSource) {
		issues.push({
			level: "warn",
			code: "machineBusy",
			message: `The machine is ${status}. Writing to the SD card during a print can starve the print of data.`,
		});
	}
	if (input.existingStamp !== null) {
		issues.push({
			level: "warn",
			code: "alreadyProcessed",
			message: `This file already carries a stamp for the recipe "${input.existingStamp.recipe}" (applied ${input.existingStamp.at}). Running it again would apply the same changes twice.`,
		});
	}
	if (input.targetExists && !input.plan.overwritesSource) {
		issues.push({
			level: "warn",
			code: "targetExists",
			message: `${input.plan.targetPath} already exists and will be replaced.`,
		});
	}
	if (input.sizeBytes !== null && input.sizeBytes > LARGE_FILE_WARN_BYTES) {
		issues.push({
			level: "warn",
			code: "largeFile",
			message: `This file is ${formatBytes(input.sizeBytes)}. Processing runs in the browser and will take a while; leave the tab open.`,
		});
	}
	if (input.plan.overwritesSource && input.plan.backupPath === null) {
		issues.push({
			level: "block",
			code: "noBackup",
			message: "Refusing to overwrite the original without a backup path.",
		});
	}
	return issues;
}

export function blocking(issues: Array<SafetyIssue>): Array<SafetyIssue> {
	return issues.filter((i) => i.level === "block");
}

/** SD paths differ only in their volume prefix conventions; compare them leniently. */
export function samePath(a: string, b: string): boolean {
	return normalisePath(a) === normalisePath(b);
}

export function normalisePath(path: string): string {
	return path.replace(/^0:/, "").replace(/\/+/g, "/").toLowerCase();
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// #endregion
