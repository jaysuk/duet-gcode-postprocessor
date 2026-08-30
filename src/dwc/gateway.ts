/**
 * The FileGateway implementation over DWC's machine store.
 *
 * Everything DWC-specific about moving bytes on and off the SD card lives here, so `model/io` can
 * be tested against an in-memory fake and never learns what a connector is.
 *
 * Note the `false` arguments throughout: DWC's own transfer dialog and success toasts are
 * suppressed, because this plugin shows one progress bar for the whole operation. Errors are also
 * suppressed at this layer and surfaced by the caller with the context of which step failed.
 */

import { useMachineStore } from "@/stores/machine";

import type { FileGateway } from "../model/io/transfer";
import { baseName, dirName } from "../model/io/plan";

export function createGateway(): FileGateway {
	const machineStore = useMachineStore();

	return {
		async download(path, onProgress) {
			const response = await machineStore.download(
				{ filename: path, type: "blob" },
				false, false, false, false,
				onProgress,
			);
			// Older connectors hand back a string for text-ish content types even when "blob" was
			// asked for; normalise so the caller only ever deals with a Blob
			if (response instanceof Blob) return response;
			return new Blob([String(response)], { type: "text/plain" });
		},

		async upload(path, content, onProgress) {
			await machineStore.upload(
				{ filename: path, content },
				false, false, false, false,
				onProgress,
			);
		},

		async move(from, to, force) {
			await machineStore.move(from, to, force);
		},

		async remove(path) {
			await machineStore.delete(path);
		},

		async makeDirectory(path) {
			try {
				await machineStore.makeDirectory(path);
			} catch {
				// Already exists is the common case and is not an error worth propagating; a real
				// permission or volume problem will surface on the upload that follows
			}
		},

		async sizeOf(path) {
			try {
				const listing = await machineStore.getFileList(dirName(path));
				const name = baseName(path);
				const entry = listing.find((item) => item.name === name && !item.isDirectory);
				if (entry === undefined || entry.size === undefined || entry.size === null) return null;
				// DSF reports sizes as bigint on 64-bit builds; the pipeline only ever compares them
				// against Blob sizes, which are numbers
				return typeof entry.size === "bigint" ? Number(entry.size) : entry.size;
			} catch {
				return null;
			}
		},
	};
}
