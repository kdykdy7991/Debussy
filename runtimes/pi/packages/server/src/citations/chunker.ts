/**
 * Text attachment reader and chunker for P2 citation indexing.
 *
 * Files are read with a byte cap, decoded as UTF-8, and split into chunks that
 * mix paragraph grouping with a fixed character ceiling. Adjacent chunks keep a
 * small overlap so retrieval does not lose matches that straddle a boundary.
 * Every chunk carries its 1-based line range and 0-based character range in the
 * original file so citations can be displayed with precise locations.
 *
 * Two content entry points share the same truncation semantics:
 * `readTextFile` reads from a local file path (internal session flow), while
 * `readTextBuffer` decodes bytes already held in memory (embed conversation
 * flow, where attachments live in object storage).
 */
import { open } from "node:fs/promises";
import type { SourceChunk } from "@earendil-works/pi-protocol";
import { estimateTokens } from "./tokenize.ts";

export interface ChunkingOptions {
	/** Preferred maximum chunk length in characters. Default 1000. */
	maxChars?: number;
	/** Character overlap between char-split sub-chunks. Default 200. */
	overlapChars?: number;
	/** Maximum file bytes indexed; longer files are truncated at a paragraph boundary. Default 2 MiB. */
	maxBytes?: number;
}

export interface ChunkText {
	text: string;
	startLine?: number;
	endLine?: number;
	charStart?: number;
	charEnd?: number;
	tokenEstimate?: number;
}

export interface ReadTextResult {
	text: string;
	truncated: boolean;
	bytesRead: number;
}

const DEFAULT_MAX_CHARS = 1_000;
const DEFAULT_OVERLAP_CHARS = 200;

/** Read a file as UTF-8 text, honoring a byte cap and cutting at a paragraph boundary. */
export async function readTextFile(path: string, maxBytes: number): Promise<ReadTextResult> {
	const handle = await open(path, "r");
	try {
		const size = (await handle.stat()).size;
		const bytesRead = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(bytesRead);
		const { bytesRead: actuallyRead } = await handle.read(buffer, 0, bytesRead, 0);
		return decodeTextBytes(buffer.subarray(0, actuallyRead), size > maxBytes);
	} finally {
		await handle.close();
	}
}

/**
 * Decode in-memory bytes as UTF-8 with the same byte cap and paragraph-boundary
 * truncation as `readTextFile`. Used when attachment bytes already live in
 * memory (object-store-backed embed attachments).
 */
export function readTextBuffer(data: Buffer, maxBytes: number): ReadTextResult {
	const truncated = data.length > maxBytes;
	return decodeTextBytes(data.subarray(0, Math.min(data.length, maxBytes)), truncated);
}

/** Shared decode + truncate step; `truncated` reports whether the source was cut. */
function decodeTextBytes(data: Buffer, truncated: boolean): ReadTextResult {
	let text = data.toString("utf-8");
	if (truncated) {
		// Cut at the last paragraph boundary so we never split mid-sentence.
		const cut = text.lastIndexOf("\n");
		if (cut > data.length * 0.5) text = text.slice(0, cut);
	}
	return { text, truncated, bytesRead: data.length };
}

/**
 * Split text into chunks. Paragraphs (consecutive non-blank lines) are grouped
 * up to `maxChars`; a paragraph longer than the cap is split on character
 * windows with `overlapChars` overlap. Chunks overlap by re-seeding with the
 * previous chunk's last paragraph.
 */
export function chunkText(text: string, options: ChunkingOptions = {}): ChunkText[] {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
	if (!text || maxChars <= 0) return [];

	const units = paragraphUnits(text);
	const chunks: ChunkText[] = [];
	let pending: Unit[] = [];
	let pendingLength = 0;
	let previousLastUnit: Unit | undefined;

	const flush = () => {
		if (pending.length === 0) return;
		const joined = pending.map((unit) => unit.text).join("\n\n");
		const first = pending[0]!;
		const last = pending[pending.length - 1]!;
		chunks.push({
			text: joined,
			startLine: first.startLine,
			endLine: last.endLine,
			charStart: first.charStart,
			charEnd: last.charEnd,
			tokenEstimate: estimateTokens(joined),
		});
		previousLastUnit = last;
		pending = [];
		pendingLength = 0;
	};

	for (const unit of units) {
		if (unit.text.length > maxChars) {
			flush();
			pushCharSplit(chunks, unit, maxChars, overlapChars);
			continue;
		}
		if (pending.length > 0 && pendingLength + unit.text.length > maxChars) {
			flush();
			// Small paragraph-level overlap: reseed with the previous chunk's tail.
			if (previousLastUnit !== undefined && previousLastUnit !== unit) {
				pending.push(previousLastUnit);
				pendingLength += previousLastUnit.text.length;
			}
		}
		pending.push(unit);
		pendingLength += unit.text.length;
	}
	flush();
	return chunks;
}

interface Unit {
	text: string;
	startLine: number;
	endLine: number;
	charStart: number;
	charEnd: number;
}

function paragraphUnits(text: string): Unit[] {
	const lines = text.split("\n");
	const units: Unit[] = [];
	let current: string[] = [];
	let startLine = 0;
	let startChar = 0;
	let charOffset = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const lineStart = charOffset;
		charOffset += line.length + 1;
		if (line.trim().length === 0) {
			if (current.length > 0) {
				units.push(makeUnit(current, startLine, startChar, index));
				current = [];
			}
			continue;
		}
		if (current.length === 0) {
			startLine = index + 1;
			startChar = lineStart;
		}
		current.push(line);
	}
	if (current.length > 0) units.push(makeUnit(current, startLine, startChar, lines.length));
	return units;
}

function makeUnit(lines: readonly string[], startLine: number, startChar: number, endLine: number): Unit {
	const text = lines.join("\n");
	return { text, startLine, endLine, charStart: startChar, charEnd: startChar + text.length - 1 };
}

function pushCharSplit(chunks: ChunkText[], unit: Unit, maxChars: number, overlapChars: number): void {
	const step = Math.max(1, maxChars - overlapChars);
	for (let start = 0; start < unit.text.length; start += step) {
		const end = Math.min(unit.text.length, start + maxChars);
		const window = unit.text.slice(start, end);
		chunks.push({
			text: window,
			startLine: lineAtChar(unit, start),
			endLine: lineAtChar(unit, end),
			charStart: unit.charStart + start,
			charEnd: unit.charStart + end,
			tokenEstimate: estimateTokens(window),
		});
		if (end >= unit.text.length) break;
	}
}

/** 1-based line number of a 0-based offset within a unit's own text. */
function lineAtChar(unit: Unit, offset: number): number {
	let newlines = 0;
	const limit = Math.min(offset, unit.text.length);
	for (let index = 0; index < limit; index++) {
		if (unit.text[index] === "\n") newlines++;
	}
	return unit.startLine + newlines;
}

/** Map a chunk text to a persisted `SourceChunk`, assigning id/sourceId/ordinal. */
export function toSourceChunks(sourceId: string, texts: readonly ChunkText[], idFactory: () => string): SourceChunk[] {
	return texts.map((text, ordinal) => ({
		id: idFactory(),
		sourceId,
		ordinal,
		text: text.text,
		startLine: text.startLine,
		endLine: text.endLine,
		charStart: text.charStart,
		charEnd: text.charEnd,
		tokenEstimate: text.tokenEstimate,
	}));
}
