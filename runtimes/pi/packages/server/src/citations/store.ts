/**
 * Persisted store for P2 citation indexes.
 *
 * Layout under `root`:
 *
 *   <root>/sources/<sourceId>.json   Source record (atomic write)
 *   <root>/chunks/<sourceId>.json    all chunks of one source in a single file
 *   <root>/turns/<sessionId>.json    latest turn's citations for a session
 *
 * Records are recovered on `init()` so Source/Chunk state and the last turn's
 * citations survive a server restart. Source records never store file paths or
 * client-facing attachment bytes — they reference attachments by id.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Citation, Source, SourceChunk } from "@earendil-works/pi-protocol";

export const CITATION_RECORD_VERSION = 1 as const;

export interface StoredSourceRecord {
	schemaVersion: typeof CITATION_RECORD_VERSION;
	source: Source;
}

export interface StoredChunkFile {
	schemaVersion: typeof CITATION_RECORD_VERSION;
	chunks: SourceChunk[];
}

export interface StoredTurnCitations {
	schemaVersion: typeof CITATION_RECORD_VERSION;
	turnId: string;
	citations: Citation[];
}

export class CitationStore {
	readonly #root: string;
	readonly #sources = new Map<string, Source>();
	readonly #chunks = new Map<string, SourceChunk[]>();
	readonly #turnCitations = new Map<string, StoredTurnCitations>();

	constructor(root: string) {
		this.#root = root;
	}

	get root(): string {
		return this.#root;
	}

	async init(): Promise<void> {
		await mkdir(this.#root, { recursive: true });
		await this.recover();
	}

	async recover(): Promise<void> {
		const sourcesDir = join(this.#root, "sources");
		const chunksDir = join(this.#root, "chunks");
		const turnsDir = join(this.#root, "turns");
		await mkdir(sourcesDir, { recursive: true }).catch(() => {});
		await mkdir(chunksDir, { recursive: true }).catch(() => {});
		await mkdir(turnsDir, { recursive: true }).catch(() => {});

		const sourceEntries = await readdir(sourcesDir, { withFileTypes: true }).catch(() => []);
		for (const entry of sourceEntries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -".json".length);
			try {
				const raw = await readFile(join(sourcesDir, entry.name), "utf-8");
				const record = JSON.parse(raw) as StoredSourceRecord;
				if (record.schemaVersion !== CITATION_RECORD_VERSION || record.source?.id !== id) continue;
				this.#sources.set(id, record.source);
			} catch {
				// Skip corrupt records.
			}
		}

		const chunkEntries = await readdir(chunksDir, { withFileTypes: true }).catch(() => []);
		for (const entry of chunkEntries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const sourceId = entry.name.slice(0, -".json".length);
			try {
				const raw = await readFile(join(chunksDir, entry.name), "utf-8");
				const record = JSON.parse(raw) as StoredChunkFile;
				if (record.schemaVersion !== CITATION_RECORD_VERSION || !Array.isArray(record.chunks)) continue;
				this.#chunks.set(sourceId, record.chunks);
			} catch {
				// Skip corrupt records.
			}
		}

		const turnEntries = await readdir(turnsDir, { withFileTypes: true }).catch(() => []);
		for (const entry of turnEntries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const sessionId = entry.name.slice(0, -".json".length);
			try {
				const raw = await readFile(join(turnsDir, entry.name), "utf-8");
				const record = JSON.parse(raw) as StoredTurnCitations;
				if (record.schemaVersion !== CITATION_RECORD_VERSION || !Array.isArray(record.citations)) continue;
				this.#turnCitations.set(sessionId, record);
			} catch {
				// Skip corrupt records.
			}
		}
	}

	getSource(sourceId: string): Source | undefined {
		return this.#sources.get(sourceId);
	}

	/**
	 * Session-scoped source lookup: returns `undefined` unless the source
	 * belongs to the given session/conversation. Conversation-scoped callers
	 * must use this (or `listSourcesBySession`) instead of the bare
	 * `getSource` so a foreign source id can never be resolved (TASK-032
	 * forbids scope-less global lookups for the conversation citation path).
	 */
	getSourceInSession(sessionId: string, sourceId: string): Source | undefined {
		const source = this.#sources.get(sourceId);
		if (source === undefined || source.sessionId !== sessionId) return undefined;
		return source;
	}

	listSourcesBySession(sessionId: string): Source[] {
		return [...this.#sources.values()].filter(
			(source) => source.sessionId === sessionId && source.status !== "removed",
		);
	}

	async saveSource(source: Source): Promise<void> {
		this.#sources.set(source.id, source);
		const record: StoredSourceRecord = { schemaVersion: CITATION_RECORD_VERSION, source };
		await atomicWrite(join(this.#root, "sources", `${source.id}.json`), record);
	}

	async removeSourceRecord(sourceId: string): Promise<void> {
		this.#sources.delete(sourceId);
		this.#chunks.delete(sourceId);
		await rm(join(this.#root, "sources", `${sourceId}.json`), { force: true }).catch(() => {});
		await rm(join(this.#root, "chunks", `${sourceId}.json`), { force: true }).catch(() => {});
	}

	async saveChunks(sourceId: string, chunks: SourceChunk[]): Promise<void> {
		this.#chunks.set(sourceId, chunks);
		const record: StoredChunkFile = { schemaVersion: CITATION_RECORD_VERSION, chunks };
		await atomicWrite(join(this.#root, "chunks", `${sourceId}.json`), record);
	}

	loadChunks(sourceId: string): SourceChunk[] | undefined {
		return this.#chunks.get(sourceId);
	}

	/** Session-scoped chunk lookup (see `getSourceInSession`). */
	loadChunksInSession(sessionId: string, sourceId: string): SourceChunk[] | undefined {
		const source = this.getSourceInSession(sessionId, sourceId);
		if (source === undefined) return undefined;
		return this.#chunks.get(sourceId);
	}

	async saveTurnCitations(sessionId: string, turnId: string, citations: Citation[]): Promise<void> {
		const record: StoredTurnCitations = { schemaVersion: CITATION_RECORD_VERSION, turnId, citations };
		this.#turnCitations.set(sessionId, record);
		await atomicWrite(join(this.#root, "turns", `${sessionId}.json`), record);
	}

	loadTurnCitations(sessionId: string): { turnId: string; citations: Citation[] } | undefined {
		const record = this.#turnCitations.get(sessionId);
		return record ? { turnId: record.turnId, citations: record.citations } : undefined;
	}
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, JSON.stringify(value), "utf-8");
	await rename(tmp, path);
}
