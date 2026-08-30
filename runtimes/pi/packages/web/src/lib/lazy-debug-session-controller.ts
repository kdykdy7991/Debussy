/**
 * Thin `SessionController` used by the Agent Debug page so its conversation can
 * follow strict lazy-create semantics: opening Debug never creates a
 * DebugConversation — the page stays in an empty (unattached) state until the
 * FIRST real user message, at which point a `beforeSend` bootstrap creates +
 * attaches the conversation and then the message is sent.
 *
 * Attachment flow (Phase 2C):
 *  - select file → HTTP upload succeeds → uploadId is stored as a pending
 *    attachment (status `pending-attach`) on the Controller. The chip
 *    surfaces immediately and the Conversation is NOT created.
 *  - send → ensureRef ensures the DebugConversation + WS session → pending
 *    attachments are bound via `attach_upload` → the prompt carries the
 *    freshly-bound attachment IDs to the model.
 *  - dismiss a pending chip → no Conversation is created; the pending
 *    attachment is simply dropped.
 *
 * This is deliberately a focused override on `uploadFiles` / `send` /
 * `dismissUpload`, not a rewrite of SessionController and not a new Chat
 * controller. The injected `ensureRef` is a mutable hook the page fills
 * with a `() => Promise<void>` that is only invoked when an attached
 * conversation is actually missing; it is idempotent (a no-op once
 * attached).
 */

import type { PiSessionClient, SessionPromptPayload, SessionSendResult } from "./session-controller.ts";
import { SessionController, type UploadItem } from "./session-controller.ts";
import type { PiUploadClient } from "./uploader.ts";

/** A mutable hook to the current "ensure attached" bootstrap. */
export interface EnsureAttachedRef {
	readonly current: (() => Promise<void>) | null;
}

/**
 * {@link EnsureAttachedRef} that can be handed to a runtime created inside a
 * React effect; the page assigns `ref.current` on every render so the closure
 * always sees the current agent selection.
 */
export class MutableEnsureAttachedRef implements EnsureAttachedRef {
	current: (() => Promise<void>) | null = null;
}

interface PendingAttachment {
	readonly localId: string;
	readonly attachmentId: string;
	readonly name: string;
}

export class LazyDebugSessionController extends SessionController {
	readonly ensureRef: EnsureAttachedRef;
	#pending: PendingAttachment[] = [];
	readonly #uploads: PiUploadClient;

	constructor(client: PiSessionClient, uploads: PiUploadClient, ensureRef: EnsureAttachedRef) {
		super(client, uploads);
		this.ensureRef = ensureRef;
		this.#uploads = uploads;
	}

	override async uploadFiles(files: File[]): Promise<void> {
		if (files.length === 0) return;
		if (this.getSnapshot().submitting) throw new Error("正在提交上一项操作");
		// Fast path: DebugConversation already attached — mirror parent.
		if (this.activeHandle !== undefined) {
			await super.uploadFiles(files);
			return;
		}
		// Lazy path: upload bytes immediately, surface `pending-attach` chip.
		// No Conversation is created here.
		const items: UploadItem[] = files.map((file) => {
			const localId = `upload-${Math.random().toString(36).slice(2, 10)}`;
			return { localId, name: file.name, status: "uploading", progress: 0 };
		});
		for (const item of items) this.addUpload(item);
		await Promise.all(
			files.map(async (file, index) => {
				const item = items[index];
				if (item === undefined) return;
				try {
					const attachment = await this.#uploads.uploadFile(file, (fraction) => {
						this.updateUpload(item.localId, { progress: Math.round(fraction * 100) });
					});
					this.#pending.push({ localId: item.localId, attachmentId: attachment.id, name: item.name });
					this.updateUpload(item.localId, {
						status: "pending-attach",
						progress: undefined,
						attachmentId: attachment.id,
					});
				} catch (error) {
					this.updateUpload(item.localId, {
						status: "failed",
						progress: undefined,
						error: error instanceof Error ? error.message : "上传失败",
					});
				}
			}),
		);
	}

	override async send(text: string, options?: SessionPromptPayload): Promise<SessionSendResult> {
		const ensure = this.ensureRef.current;
		if (ensure !== null) await ensure();
		// ensureRef has now resolved `activeHandle`; bind every pending
		// attachment and surface the resulting IDs to the model prompt.
		const flushedIds = await this.#flushPending();
		const mergedOptions: SessionPromptPayload | undefined =
			flushedIds.length > 0
				? { ...(options ?? {}), attachmentIds: [...(options?.attachmentIds ?? []), ...flushedIds] }
				: options;
		return super.send(text, mergedOptions);
	}

	override dismissUpload(localId: string): void {
		const idx = this.#pending.findIndex((p) => p.localId === localId);
		if (idx >= 0) this.#pending.splice(idx, 1);
		super.dismissUpload(localId);
	}

	/** Pending attachments waiting to be bound to a freshly attached session. */
	getPendingAttachments(): readonly PendingAttachment[] {
		return [...this.#pending];
	}

	async #flushPending(): Promise<string[]> {
		const handle = this.activeHandle;
		if (handle === undefined || this.#pending.length === 0) return [];
		const snapshot = this.#pending.slice();
		const bound: string[] = [];
		for (const pending of snapshot) {
			try {
				await handle.attachUpload(pending.attachmentId, "session");
				bound.push(pending.attachmentId);
			} catch (error) {
				// Pending bind failed: mark chip as failed so the user can
				// dismiss it. The store-side upload remains and may still be
				// usable for retries; legacy v1 records cannot pass ownership
				// checks and surface as `not_found`.
				this.updateUpload(pending.localId, {
					status: "failed",
					error: error instanceof Error ? error.message : "绑定失败",
				});
			}
		}
		// Drop the successfully bound pending records; failed binds stay so
		// the user can dismiss them explicitly (they are not auto-removed).
		this.#pending = this.#pending.filter((p) => !snapshot.includes(p) || !bound.includes(p.attachmentId));
		return bound;
	}
}
