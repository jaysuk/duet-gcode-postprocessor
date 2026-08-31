/**
 * Verify every macro a file calls (`M98 P"..."`) actually exists on the SD card.
 *
 * Not part of the pure preflight checks in `model/checks.ts` because it needs a file listing, which
 * is asynchronous and belongs to this DWC-facing layer — `runChecks` stays synchronous and importing
 * a gateway into `model/` would drag DWC into the one layer that is not supposed to know it exists.
 *
 * Catches exactly the failure this plugin's own "Insert G-code" step makes easy to introduce: a
 * typo'd macro path that stops the print, possibly forty minutes in, rather than at the point where
 * it could still be fixed.
 */

import type { CheckResult } from "../model/checks";
import type { FileAnalysis } from "../model/analysis";
import type { FileGateway } from "../model/io/transfer";

/** A relative macro path resolves against the volume root in RepRapFirmware. */
function resolveMacroPath(path: string): string {
	if (/^\d+:\//.test(path)) return path;
	return `0:/${path.replace(/^\/+/, "")}`;
}

/**
 * Check each distinct macro reference against the card. A lookup that fails outright (disconnected,
 * a transient error) is not evidence the macro is missing, so it is skipped rather than reported —
 * a false "missing" would be worse than saying nothing.
 */
export async function checkMacros(
	gateway: FileGateway,
	refs: FileAnalysis["macroRefs"],
): Promise<Array<CheckResult>> {
	const results: Array<CheckResult> = [];

	for (const ref of refs) {
		const resolved = resolveMacroPath(ref.path);
		let size: number | null;
		try {
			size = await gateway.sizeOf(resolved);
		} catch {
			continue;
		}
		if (size !== null) continue;

		const times = ref.count > 1 ? ` (called ${ref.count} times, first at line ${ref.firstLine})` : ` (line ${ref.firstLine})`;
		const target = resolved === ref.path
			? resolved
			: `${resolved} (${ref.path} resolved against the volume root, since it had no volume prefix)`;
		results.push({
			level: "error",
			code: `macro:missing:${ref.path}`,
			title: `Missing macro: ${ref.path}`,
			detail: `This file calls M98 P"${ref.path}"${times}, but ${target} does not exist on the SD card.`,
		});
	}

	return results;
}
