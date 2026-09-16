/**
 * Bridge this plugin's own chunked-`Blob`-reading convention onto `dwc-gcode-editor`'s
 * `buildDocFromChunks`, which wants an `AsyncIterable<string>` of decoded text chunks — not lines
 * (that module does its own line-splitting internally, matching `transfer.ts`'s own reasoning:
 * never decode a whole file into one JS string). Deliberately does not reuse `transfer.ts`'s own
 * `forEachLine` (a per-line callback) since `buildDocFromChunks` wants raw chunk text, not lines.
 */

import { READ_CHUNK_BYTES } from "../constants";

/** Yields `blob`'s content as decoded text chunks, in order, `chunkBytes` at a time (default: this
 *  plugin's own `READ_CHUNK_BYTES`, the same size `forEachLine` uses). A multi-byte UTF-8 character
 *  straddling a slice boundary is handled correctly via `TextDecoder`'s own `stream: true` option -
 *  the same technique `forEachLine` already relies on. */
export async function* blobToTextChunks(blob: Blob, chunkBytes: number = READ_CHUNK_BYTES): AsyncGenerator<string> {
	const decoder = new TextDecoder("utf-8");
	let offset = 0;
	while (offset < blob.size) {
		const end = Math.min(offset + chunkBytes, blob.size);
		const lastChunk = end >= blob.size;
		yield decoder.decode(await blob.slice(offset, end).arrayBuffer(), { stream: !lastChunk });
		offset = end;
	}
}
