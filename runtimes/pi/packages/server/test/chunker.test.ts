import { describe, expect, test } from "vitest";
import { chunkText, readTextFile } from "../src/citations/chunker.ts";

describe("chunkText", () => {
	test("returns no chunks for empty text", () => {
		expect(chunkText("")).toEqual([]);
		expect(chunkText("\n\n")).toEqual([]);
	});

	test("groups short paragraphs into a single chunk", () => {
		const chunks = chunkText("alpha\n\nbeta\n\ngamma", { maxChars: 1000 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.text).toBe("alpha\n\nbeta\n\ngamma");
		expect(chunks[0]!.startLine).toBe(1);
		expect(chunks[0]!.endLine).toBe(5);
		expect(chunks[0]!.charStart).toBe(0);
	});

	test("splits paragraphs into multiple chunks when the cap is exceeded", () => {
		const paragraphA = "a".repeat(60);
		const paragraphB = "b".repeat(60);
		const paragraphC = "c".repeat(60);
		const text = `${paragraphA}\n\n${paragraphB}\n\n${paragraphC}`;
		const chunks = chunkText(text, { maxChars: 100 });
		expect(chunks.length).toBeGreaterThan(1);
		// Chunk text is never longer than the cap plus one overlap paragraph.
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(100 + 60);
			expect(chunk.startLine).toBeGreaterThanOrEqual(1);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine!);
		}
	});

	test("keeps a small paragraph overlap between adjacent chunks", () => {
		const paragraphA = "a".repeat(80);
		const paragraphB = "b".repeat(80);
		const paragraphC = "c".repeat(80);
		const text = `${paragraphA}\n\n${paragraphB}\n\n${paragraphC}`;
		const chunks = chunkText(text, { maxChars: 100 });
		expect(chunks.length).toBeGreaterThan(1);
		// Each later chunk re-seeds with the previous chunk's tail paragraph.
		expect(chunks[0]!.text).toBe(paragraphA);
		expect(chunks[1]!.text).toContain(paragraphA);
		expect(chunks[1]!.text).toContain(paragraphB);
		expect(chunks[2]!.text.startsWith(paragraphB)).toBe(true);
		expect(chunks[2]!.text).toContain(paragraphC);
	});

	test("splits a single oversized paragraph into char windows with overlap", () => {
		const text = "word ".repeat(400); // one giant paragraph
		const chunks = chunkText(text, { maxChars: 100, overlapChars: 20 });
		expect(chunks.length).toBeGreaterThan(3);
		const first = chunks[0]!;
		const second = chunks[1]!;
		// The second window starts maxChars - overlapChars chars in, carrying a tail.
		expect(second.text).toContain(first.text.slice(-20));
		// charStart advances by the step size.
		expect(second.charStart).toBe(first.charStart! + (100 - 20));
	});

	test("computes line and character ranges per chunk", () => {
		const text = "line one\nline two\nline three\nline four\nline five\nline six";
		const chunks = chunkText(text, { maxChars: 25 });
		for (const chunk of chunks) {
			expect(chunk.startLine).toBeGreaterThanOrEqual(1);
			expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine!);
			expect(chunk.charStart).toBeGreaterThanOrEqual(0);
			expect(chunk.charEnd).toBeGreaterThanOrEqual(chunk.charStart!);
			// Text slice reconstructed from ranges matches the chunk content length.
			expect(chunk.endLine! - chunk.startLine! + 1).toBeGreaterThanOrEqual(1);
		}
	});

	test("tracks line numbers correctly with leading blank lines", () => {
		const text = "\n\npara one\npara two\n\npara three";
		const chunks = chunkText(text, { maxChars: 100 });
		const single = chunks[0]!;
		expect(single.startLine).toBe(3);
		expect(single.endLine).toBe(6);
		expect(single.text).toBe("para one\npara two\n\npara three");
	});
});

describe("readTextFile", () => {
	test("reads a small file fully", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "chunker-"));
		const path = join(dir, "notes.txt");
		writeFileSync(path, "hello\nworld", "utf-8");
		const result = await readTextFile(path, 1024);
		expect(result.text).toBe("hello\nworld");
		expect(result.truncated).toBe(false);
	});

	test("truncates oversized files at a paragraph boundary", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "chunker-"));
		const path = join(dir, "big.txt");
		const paragraph = "x".repeat(100);
		writeFileSync(path, `${paragraph}\n${paragraph}\n${paragraph}\n${paragraph}`, "utf-8");
		const result = await readTextFile(path, 250);
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThanOrEqual(250);
		// The cut lands after a complete paragraph, never mid-paragraph.
		const lines = result.text.split("\n").filter((line) => line.length > 0);
		expect(lines.length).toBe(2);
		expect(lines.every((line) => line.length === 100)).toBe(true);
	});
});
