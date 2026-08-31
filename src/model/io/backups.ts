/**
 * The backup index: what turns "a file exists in the backups folder" into "a backup that can be
 * restored to where it came from". Without it, given `benchy.20260830-112233.gcode` there is no way
 * to know which of the user's folders it was backed up from — so restoring is impossible and the
 * backup is only half a safety feature.
 *
 * Parsing is deliberately tolerant. This file lives on an SD card that can be pulled mid-write, so a
 * missing, empty, truncated or malformed index is treated as "no backups yet" rather than an error —
 * that is normal wear for this storage medium, not something the user did wrong. A single corrupted
 * entry is dropped rather than discarding every backup's record along with it.
 */

export interface BackupEntry {
	/** File name within BACKUP_DIR — not a full path. */
	file: string;
	/** Full path the backup was taken from — what Restore writes back to. */
	originalPath: string;
	/** ISO timestamp. */
	at: string;
	/** Size in bytes at the time of backup. */
	bytes: number;
	/** Recipe that was about to be applied, for the UI. */
	recipe: string;
}

function isValidEntry(value: unknown): value is BackupEntry {
	if (typeof value !== "object" || value === null) return false;
	const e = value as Record<string, unknown>;
	return typeof e.file === "string" && e.file !== ""
		&& typeof e.originalPath === "string" && e.originalPath !== ""
		&& typeof e.at === "string" && e.at !== ""
		&& typeof e.bytes === "number" && Number.isFinite(e.bytes)
		&& typeof e.recipe === "string";
}

/**
 * Parse the index. Never throws: a missing, empty, truncated or malformed file all resolve to no
 * backups known, rather than surfacing a parse error for something outside the user's control.
 */
export function parseIndex(json: string): Array<BackupEntry> {
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
export function addEntry(index: Array<BackupEntry>, entry: BackupEntry): Array<BackupEntry> {
	return [entry, ...index];
}

/**
 * Split an index (assumed newest-first) into what to keep and what to drop once there are more
 * than `max` entries. The caller deletes the dropped entries' files — but only after successfully
 * writing back the `keep` list, so a failed write never loses a backup's only record.
 */
export function pruneIndex(
	index: Array<BackupEntry>,
	max: number,
): { keep: Array<BackupEntry>; drop: Array<BackupEntry> } {
	return { keep: index.slice(0, max), drop: index.slice(max) };
}

export function serialiseIndex(index: Array<BackupEntry>): string {
	return JSON.stringify(index, null, "\t");
}
