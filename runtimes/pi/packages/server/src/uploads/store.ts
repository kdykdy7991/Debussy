import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, AttachmentScope } from "@earendil-works/pi-protocol";
import { PiServerError } from "../errors.ts";
import type { PrincipalId, TenantId } from "../publishing/domain/ids.ts";
import { ATTACHMENT_RECORD_VERSION, type StoredAttachment } from "./types.ts";

/**
 * Persisted store for uploaded attachments.
 *
 * Layout under `root`:
 *
 *   <root>/<id>.json          attachment metadata record (atomic write)
 *   <root>/<id>/<storageName>  staged file bytes (random storage name)
 *
 * Records are recovered on `init()` so attachment state and session bindings
 * survive a server restart. Unbound or removed attachments carry an
 * `expiresAt` deadline and are cleaned up by `sweepExpired()`.
 */
export class AttachmentStore {
	readonly #root: string;
	readonly #records = new Map<string, StoredAttachment>();

	constructor(root: string) {
		this.#root = root;
	}

	get root(): string {
		return this.#root;
	}

	get size(): number {
		return this.#records.size;
	}

	get(id: string): StoredAttachment | undefined {
		return this.#records.get(id);
	}

	list(): readonly StoredAttachment[] {
		return [...this.#records.values()];
	}

	listBySession(sessionId: string): Attachment[] {
		return this.list()
			.filter((record) => record.attachment.sessionId === sessionId && record.attachment.status !== "removed")
			.map((record) => record.attachment);
	}

	/** Resolve the staged file path for an attachment, or throw when the file is gone. */
	filePath(id: string): string {
		const record = this.#records.get(id);
		if (!record) throw new PiServerError("not_found", `Unknown attachment: ${id}`);
		return join(this.#root, record.attachment.id, record.storageName);
	}

	async init(): Promise<void> {
		await mkdir(this.#root, { recursive: true });
		await this.recover();
	}

	async recover(): Promise<void> {
		const entries = await readdir(this.#root, { withFileTypes: true });
		const loaded: StoredAttachment[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -".json".length);
			try {
				const raw = await readFile(join(this.#root, entry.name), "utf-8");
				const record = JSON.parse(raw) as StoredAttachment;
				// Both v1 (no ownership) and v2 (with ownership) load; v1 records
				// remain on disk but cannot pass ownership checks until the user
				// re-uploads. This keeps recover non-fatal across schema bumps.
				if (
					(record.schemaVersion !== (1 as unknown as typeof ATTACHMENT_RECORD_VERSION) &&
						record.schemaVersion !== ATTACHMENT_RECORD_VERSION) ||
					record.attachment?.id !== id
				) {
					continue;
				}
				loaded.push(record);
				this.#records.set(id, record);
			} catch {
				// Skip corrupt records; the sweep will not resurrect them.
			}
		}
		return void loaded;
	}

	/** Persist a record atomically (temp file + rename). */
	async save(record: StoredAttachment): Promise<void> {
		this.#records.set(record.attachment.id, record);
		const target = join(this.#root, `${record.attachment.id}.json`);
		const tmp = join(this.#root, `.${record.attachment.id}.${randomUUID()}.tmp`);
		await writeFile(tmp, JSON.stringify(record), "utf-8");
		await rename(tmp, target);
	}

	/**
	 * Bind a ready upload to a session and clear its retention deadline.
	 * Refuses to re-target an attachment already bound to a *different*
	 * conversation (cross-conversation attach). Re-binding to the same
	 * session is idempotent.
	 */
	async bind(id: string, sessionId: string, scope: AttachmentScope): Promise<StoredAttachment | undefined> {
		const record = this.#records.get(id);
		if (!record) return undefined;
		if (record.attachment.sessionId !== undefined && record.attachment.sessionId !== sessionId) {
			return undefined;
		}
		record.attachment = { ...record.attachment, sessionId, scope };
		record.expiresAt = undefined;
		await this.save(record);
		return record;
	}

	/** Mark an attachment removed: unbind, keep metadata for history, schedule file cleanup. */
	async markRemoved(id: string): Promise<StoredAttachment | undefined> {
		const record = this.#records.get(id);
		if (!record) return undefined;
		record.attachment = { ...record.attachment, sessionId: undefined, status: "removed", scope: undefined };
		record.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
		await this.save(record);
		return record;
	}

	/** Move a fully received file into the store and persist its record. */
	async adopt(
		attachment: Attachment,
		sourcePath: string,
		owner?: { readonly tenantId: TenantId; readonly principalId: PrincipalId },
	): Promise<StoredAttachment> {
		const id = attachment.id;
		const storageName = randomUUID();
		const dir = join(this.#root, id);
		await mkdir(dir, { recursive: true });
		await rename(sourcePath, join(dir, storageName));
		const record: StoredAttachment = {
			schemaVersion: ATTACHMENT_RECORD_VERSION,
			attachment,
			storageName,
			expiresAt: Date.now() + 24 * 60 * 60 * 1000,
			...(owner !== undefined ? { ownerTenantId: owner.tenantId, ownerPrincipalId: owner.principalId } : {}),
		};
		await this.save(record);
		return record;
	}

	/** Throws when the caller is not the owner of the record. */
	assertOwnership(id: string, caller: { readonly tenantId: TenantId; readonly principalId: PrincipalId }): void {
		const record = this.#records.get(id);
		if (record === undefined) {
			throw new PiServerError("not_found", `Unknown attachment: ${id}`);
		}
		// Legacy v1 records carry no ownership metadata. Treat as foreign:
		// cross-tenant attach hardening means they must be re-uploaded after
		// deploy. The error code mirrors `not_found` so probing is impossible.
		if (record.ownerTenantId === undefined || record.ownerPrincipalId === undefined) {
			throw new PiServerError("not_found", `Unknown attachment: ${id}`);
		}
		if (record.ownerTenantId !== caller.tenantId || record.ownerPrincipalId !== caller.principalId) {
			throw new PiServerError("not_found", `Unknown attachment: ${id}`);
		}
	}

	/** Remove a record and its staged file directory entirely. */
	async remove(id: string): Promise<void> {
		const record = this.#records.get(id);
		if (!record) return;
		this.#records.delete(id);
		await unlink(join(this.#root, `${id}.json`)).catch(() => {});
		await rm(join(this.#root, id), { recursive: true, force: true }).catch(() => {});
	}

	/** Clean up expired unbound/removed attachments. Bound ready attachments are never swept. */
	async sweepExpired(now = Date.now()): Promise<void> {
		const expired: StoredAttachment[] = [];
		for (const record of this.#records.values()) {
			if (record.expiresAt === undefined) continue;
			if (record.expiresAt <= now) expired.push(record);
		}
		for (const record of expired) await this.remove(record.attachment.id);
	}
}
