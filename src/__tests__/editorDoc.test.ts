import { describe, expect, it } from "vitest";
import { buildDocFromChunks } from "dwc-gcode-editor";
import { blobToTextChunks } from "../model/gcode/editorDoc";

describe("blobToTextChunks", () => {
	it("reconstructs the blob's content across multiple small chunks", async () => {
		const text = "G28\nG1 X10 Y10\nG1 X20 Y20\nM400\n";
		const blob = new Blob([text]);
		const doc = await buildDocFromChunks(blobToTextChunks(blob, 5));
		expect(doc.toString()).toBe(text);
	});

	it("matches a single-chunk read of the same content", async () => {
		const text = "G28\nG1 X10\n";
		const blob = new Blob([text]);
		const small = await buildDocFromChunks(blobToTextChunks(blob, 3));
		const large = await buildDocFromChunks(blobToTextChunks(blob, 1_000_000));
		expect(small.toString()).toBe(large.toString());
		expect(small.toString()).toBe(text);
	});

	it("handles a multi-byte UTF-8 character split across a chunk boundary", async () => {
		// "µ" is 2 bytes in UTF-8 (0xC2 0xB5) - force the boundary to fall between them
		const text = "; µ comment\nG28\n";
		const blob = new Blob([text]);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const splitAt = bytes.indexOf(0xb5); // land the chunk boundary mid-character
		const doc = await buildDocFromChunks(blobToTextChunks(blob, splitAt));
		expect(doc.toString()).toBe(text);
	});

	it("handles an empty blob", async () => {
		const doc = await buildDocFromChunks(blobToTextChunks(new Blob([""])));
		expect(doc.toString()).toBe("");
	});

	it("yields no chunks at all for an empty blob", async () => {
		const chunks: Array<string> = [];
		for await (const c of blobToTextChunks(new Blob([""]))) chunks.push(c);
		expect(chunks).toEqual([]);
	});
});
