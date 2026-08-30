import type { CreateSessionOptions, PiSessionHandle } from "@earendil-works/pi-client";
import type {
	Citation,
	LiveSpeechJob,
	LiveSpeechRequest,
	ModelRef,
	ServerEvent,
	ServerSnapshot,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	TranscriptItem,
	TranscriptProgress,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import type { PiUploadClient } from "./uploader.ts";

export interface PiSessionClient {
	readonly snapshot: ServerSnapshot | undefined;
	subscribe(listener: (snapshot: ServerSnapshot) => void): () => void;
	createSession(options?: CreateSessionOptions): Promise<PiSessionHandle>;
	attachSession(sessionId: string): Promise<PiSessionHandle>;
}

/** A file upload that has not yet become an attached attachment. */
export interface UploadItem {
	localId: string;
	name: string;
	/**
	 * - `uploading`: bytes are in flight to the upload endpoint.
	 * - `pending-attach`: upload succeeded but the Debug conversation is not
	 *   attached yet. The chip renders with a remove button; sending the first
	 *   message lazily creates the conversation and binds the pending IDs via
	 *   `attach_upload`.
	 * - `failed`: terminal failure (network, validation, auth).
	 */
	status: "uploading" | "pending-attach" | "failed";
	/** 0-100 upload progress while uploading. */
	progress?: number;
	/** Server-side attachment id once upload succeeds; used by the bind step. */
	attachmentId?: string;
	error?: string;
}

export interface SessionBrowserSnapshot {
	sessions: readonly SessionSummary[];
	activeSessionId: string | undefined;
	activeSession: SessionSnapshot | undefined;
	uploads: readonly UploadItem[];
	loading: boolean;
	submitting: boolean;
	error: string | undefined;
}

export interface SessionPromptPayload {
	attachmentIds?: string[];
	/**
	 * Phase 2 live朗读 opt-in. Only carried on idle-session prompts (`prompt`);
	 * `steer` deliberately ignores it per the V5 frozen contract. The server is
	 * the only legitimate source of any {@link LiveSpeechJob} echoed back; the
	 * controller simply threads the option through and surfaces the returned
	 * job via {@link SessionBrowserStore.send}'s promise resolution.
	 */
	speech?: LiveSpeechRequest;
}

export interface SessionSendResult {
	session: SessionSnapshot;
	/** Present only when the prompt carried `speech` and the server issued a job. */
	liveSpeech?: LiveSpeechJob;
}

export interface SessionBrowserStore {
	getSnapshot(): SessionBrowserSnapshot;
	subscribe(listener: () => void): () => void;
	createSession(model?: ModelRef): Promise<void>;
	/** Creates a memory-only session for admin debugging. */
	createDebugSession(model?: ModelRef): Promise<void>;
	/** Attaches a server-prepared, revision-bound admin debug session. */
	openDebugSession(sessionId: string): Promise<void>;
	openDefaultSession(): Promise<void>;
	selectSession(sessionId: string): Promise<void>;
	send(text: string, options?: SessionPromptPayload): Promise<SessionSendResult>;
	abort(): Promise<void>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
	uploadFiles(files: File[]): Promise<void>;
	removeAttachment(attachmentId: string): Promise<void>;
	dismissUpload(localId: string): void;
	/** Dismiss a surfaced session error without retrying anything. */
	clearError(): void;
}

export class SessionController implements SessionBrowserStore {
	static readonly STREAM_FLUSH_INTERVAL_MS = 90;
	readonly #client: PiSessionClient;
	readonly #uploads: PiUploadClient;
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribeClient: () => void;
	#activeHandle: PiSessionHandle | undefined;
	#unsubscribeActive: (() => void) | undefined;
	#unsubscribeActiveEvents: (() => void) | undefined;
	#operation = 0;
	#uploadSequence = 0;
	#pendingProgress: Extract<TranscriptProgress, { type: "assistant_delta" }>[] = [];
	#progressTimer: ReturnType<typeof setTimeout> | undefined;
	/** Assistant error ids already auto-aborted; guards duplicate terminal events. */
	#autoAbortedMessageIds = new Set<string>();
	/**
	 * Citations per Turn (`turnId -> citations`), sourced from the Debug read
	 * path's realtime `citation_snapshot` event. Kept authoritative at the
	 * controller so a later `session_snapshot` broadcast (whose server items
	 * never carry citations) does not drop a merged block.
	 */
	#citationsByTurn = new Map<string, readonly Citation[]>();
	#snapshot: SessionBrowserSnapshot;

	constructor(client: PiSessionClient, uploads: PiUploadClient) {
		this.#client = client;
		this.#uploads = uploads;
		this.#snapshot = {
			sessions: client.snapshot?.sessions ?? [],
			activeSessionId: undefined,
			activeSession: undefined,
			uploads: [],
			loading: true,
			submitting: false,
			error: undefined,
		};
		this.#unsubscribeClient = client.subscribe((snapshot) => {
			this.#setSnapshot({ ...this.#snapshot, sessions: snapshot.sessions });
		});
	}

	get activeHandle(): PiSessionHandle | undefined {
		return this.#activeHandle;
	}

	getSnapshot = (): SessionBrowserSnapshot => this.#snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	/** Attach the most recently updated session, creating one only for a new workspace. */
	async openDefaultSession(): Promise<void> {
		if (this.#activeHandle?.active) return;
		const latest = [...this.#snapshot.sessions].sort((left, right) => right.updatedAt - left.updatedAt)[0];
		await this.#activate(() => (latest ? this.#client.attachSession(latest.id) : this.#client.createSession()));
	}

	async createSession(model?: ModelRef): Promise<void> {
		await this.#activate(() => this.#client.createSession(model === undefined ? undefined : { model }));
	}

	async createDebugSession(model?: ModelRef): Promise<void> {
		await this.#activate(() =>
			this.#client.createSession({
				ephemeral: true,
				...(model === undefined ? {} : { model }),
			}),
		);
	}

	async openDebugSession(sessionId: string): Promise<void> {
		await this.#activate(() => this.#client.attachSession(sessionId));
	}

	async selectSession(sessionId: string): Promise<void> {
		if (this.#activeHandle?.id === sessionId && this.#activeHandle.active) return;
		await this.#activate(() => this.#client.attachSession(sessionId));
	}

	/**
	 * Phase 2E: release the active handle and reset the snapshot to an
	 * unattached state WITHOUT disposing the controller. Used by the Admin
	 * Debug "New Conversation" button: clear the current binding, keep the
	 * WS connection alive, and let the next send lazily create + attach a
	 * brand-new conversation. The upload state (pending-attach chips) is
	 * preserved so a file selected before clicking "New" can still ride the
	 * first send — that is the same lazy-attach behaviour the controller
	 * already documents.
	 *
	 * Bumps `#operation` so any in-flight prompt that outlives this release
	 * cannot write back into the empty snapshot (mirrors the
	 * `#runSessionAction` operation-generation guard).
	 */
	async resetActive(): Promise<void> {
		this.#operation += 1;
		this.#clearPendingProgress();
		this.#autoAbortedMessageIds.clear();
		this.#citationsByTurn.clear();
		const previous = this.#activeHandle;
		this.#unsubscribeActive?.();
		this.#unsubscribeActive = undefined;
		this.#unsubscribeActiveEvents?.();
		this.#unsubscribeActiveEvents = undefined;
		this.#activeHandle = undefined;
		// Keep the controller's other surface intact: `sessions` (the live
		// list of summaries), `loading`, the upload chips, and the
		// listeners set all stay; only `activeSession*` is cleared.
		this.#setSnapshot({
			...this.#snapshot,
			activeSessionId: undefined,
			activeSession: undefined,
			submitting: false,
		});
		await previous?.dispose();
	}

	async send(text: string, options?: SessionPromptPayload): Promise<SessionSendResult> {
		const message = text.trim();
		if (!message) throw new Error("消息不能为空");
		const handle = this.#requireActiveHandle();
		if (this.#snapshot.submitting) throw new Error("正在提交上一项操作");
		const attachmentIds = options?.attachmentIds;
		const speech = options?.speech;
		const promptOptions = {
			...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
			...(speech ? { speech } : {}),
		};
		const hasPromptOptions = Object.keys(promptOptions).length > 0;
		const shouldPrompt = this.#snapshot.activeSession?.phase === "idle";
		const optimisticId = `local-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const activeSession = this.#snapshot.activeSession;
		const priorPhase = activeSession?.phase ?? "idle";
		if (activeSession) {
			const optimisticMessage: UserTranscriptItem = {
				id: optimisticId,
				role: "user",
				content: [{ type: "text", text: message }],
				timestamp: Date.now(),
			};
			this.#setSnapshot({
				...this.#snapshot,
				activeSession: {
					...activeSession,
					phase: "turn",
					transcript: [...activeSession.transcript, optimisticMessage],
				},
			});
		}
		let promptResult: { session: SessionSnapshot; command?: string; liveSpeech?: LiveSpeechJob };
		try {
			promptResult = await this.#runSessionAction(handle, () =>
				shouldPrompt
					? hasPromptOptions
						? handle.prompt(message, promptOptions)
						: handle.prompt(message)
					: hasPromptOptions
						? handle.steer(message, promptOptions)
						: handle.steer(message),
			);
		} catch (error) {
			if (this.#activeHandle === handle && this.#snapshot.activeSession?.id === activeSession?.id) {
				const current = this.#snapshot.activeSession;
				if (current) {
					this.#setSnapshot({
						...this.#snapshot,
						activeSession: {
							...current,
							// On failure, revert the optimistic phase so the
							// composer does not stay locked in "turn" (red Stop,
							// disabled input) after a failed prompt.
							phase: priorPhase,
							transcript: current.transcript.filter((item) => item.id !== optimisticId),
						},
					});
				}
			}
			throw error;
		}
		// Surface any live朗读 job the server issued so the V9 web layer can
		// subscribe via the connection-scoped handle map.
		return {
			session: promptResult.session,
			...(promptResult.command === "prompt" && promptResult.liveSpeech
				? { liveSpeech: promptResult.liveSpeech }
				: {}),
		};
	}

	async abort(): Promise<void> {
		const handle = this.#requireActiveHandle();
		if (this.#snapshot.activeSession?.phase === "idle") return;
		await this.#runSessionAction(handle, async () => ({ session: await handle.abort() }));
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		const handle = this.#requireActiveHandle();
		await this.#runSessionAction(handle, async () => ({ session: await handle.setThinking(thinkingLevel) }));
	}

	async uploadFiles(files: File[]): Promise<void> {
		if (files.length === 0) return;
		const handle = this.#requireActiveHandle();
		if (this.#snapshot.submitting) throw new Error("正在提交上一项操作");
		const items = files.map(
			(file): UploadItem => ({
				localId: `upload-${++this.#uploadSequence}`,
				name: file.name,
				status: "uploading",
				progress: 0,
			}),
		);
		this.#setSnapshot({ ...this.#snapshot, uploads: [...this.#snapshot.uploads, ...items] });
		await Promise.all(
			files.map(async (file, index) => {
				const item = items[index];
				if (!item) return;
				try {
					const attachment = await this.#uploads.uploadFile(file, (fraction) => {
						this.#updateUpload(item.localId, { progress: Math.round(fraction * 100) });
					});
					const session = await handle.attachUpload(attachment.id, "session");
					this.dismissUpload(item.localId);
					this.#applySessionUpdate(session);
				} catch (error) {
					this.#updateUpload(item.localId, {
						status: "failed",
						error: error instanceof Error ? error.message : "上传失败",
					});
				}
			}),
		);
	}

	async removeAttachment(attachmentId: string): Promise<void> {
		const handle = this.#requireActiveHandle();
		const session = await handle.removeAttachment(attachmentId);
		this.#applySessionUpdate(session);
	}

	dismissUpload(localId: string): void {
		this.#setSnapshot({
			...this.#snapshot,
			uploads: this.#snapshot.uploads.filter((item) => item.localId !== localId),
		});
	}

	/**
	 * Append an upload chip entry. Used by subclasses that surface pre-uploaded
	 * attachments (e.g. the lazy Debug controller renders a `pending-attach`
	 * chip while the DebugConversation is still un-attached).
	 */
	addUpload(item: UploadItem): void {
		this.#setSnapshot({ ...this.#snapshot, uploads: [...this.#snapshot.uploads, item] });
	}

	/** Patch a previously-added upload chip (e.g. progress, status change). */
	updateUpload(localId: string, patch: Partial<UploadItem>): void {
		this.#updateUpload(localId, patch);
	}

	clearError(): void {
		if (this.#snapshot.error === undefined) return;
		this.#setSnapshot({ ...this.#snapshot, error: undefined });
	}

	#updateUpload(localId: string, patch: Partial<UploadItem>): void {
		this.#setSnapshot({
			...this.#snapshot,
			uploads: this.#snapshot.uploads.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
		});
	}

	#applySessionUpdate(session: SessionSnapshot): void {
		if (this.#activeHandle?.id !== session.id) return;
		const merged = this.#withCitations(session);
		this.#setSnapshot({
			...this.#snapshot,
			sessions: upsertSession(this.#snapshot.sessions, merged),
			activeSession: merged,
		});
	}

	async dispose(): Promise<void> {
		this.#operation += 1;
		this.#clearPendingProgress();
		this.#citationsByTurn.clear();
		this.#unsubscribeClient();
		this.#listeners.clear();
		const handle = this.#activeHandle;
		this.#unsubscribeActive?.();
		this.#unsubscribeActive = undefined;
		this.#unsubscribeActiveEvents?.();
		this.#unsubscribeActiveEvents = undefined;
		this.#activeHandle = undefined;
		await handle?.dispose();
	}

	async #activate(acquire: () => Promise<PiSessionHandle>): Promise<void> {
		const operation = ++this.#operation;
		this.#clearPendingProgress();
		this.#citationsByTurn.clear();
		this.#setSnapshot({ ...this.#snapshot, loading: true, error: undefined });
		try {
			const previous = this.#activeHandle;
			this.#activeHandle = undefined;
			this.#unsubscribeActive?.();
			this.#unsubscribeActive = undefined;
			this.#unsubscribeActiveEvents?.();
			this.#unsubscribeActiveEvents = undefined;
			await previous?.dispose();
			const handle = await acquire();
			if (operation !== this.#operation) {
				await handle.dispose();
				return;
			}
			this.#activeHandle = handle;
			const summary = handle.snapshot;
			const sessions = summary ? upsertSession(this.#snapshot.sessions, summary) : this.#snapshot.sessions;
			this.#setSnapshot({
				sessions,
				activeSessionId: handle.id,
				activeSession: summary,
				uploads: [],
				loading: false,
				submitting: false,
				error: undefined,
			});
			this.#unsubscribeActive = handle.subscribe((session) => {
				if (this.#activeHandle !== handle) return;
				this.#clearPendingProgress();
				const merged = this.#withCitations(session);
				this.#setSnapshot({
					...this.#snapshot,
					sessions: upsertSession(this.#snapshot.sessions, merged),
					activeSession: merged,
				});
			});
			this.#unsubscribeActiveEvents = handle.onEvent((event) => {
				if (this.#activeHandle !== handle) return;
				if (event.type === "session_progress") {
					this.#applyProgress(event);
					return;
				}
				// Debug read path: the Turn's full citations arrive via the
				// internal Pi Session `citation_snapshot` event. Bound strictly by
				// `turnId` and merged once that Turn's assistant message exists
				// (or kept pending and merged as soon as it streams in) — never
				// attached to a "latest message".
				if (event.type === "citation_snapshot") {
					this.#citationsByTurn.set(event.turnId, [...event.citations]);
					this.#applyCitations();
				}
			});
		} catch (error) {
			if (operation !== this.#operation) return;
			this.#setSnapshot({
				...this.#snapshot,
				activeSessionId: undefined,
				activeSession: undefined,
				loading: false,
				// Activation is finished (failed): the composer must not stay
				// locked in "submitting" on top of the error state.
				submitting: false,
				error: error instanceof Error ? error.message : "会话操作失败",
			});
			throw error;
		}
	}

	async #runSessionAction(
		handle: PiSessionHandle,
		action: () => Promise<{ session: SessionSnapshot; [key: string]: unknown }>,
	): Promise<{ session: SessionSnapshot; command?: string; liveSpeech?: LiveSpeechJob }> {
		// Capture the controller operation generation: `#activate` (session
		// switch) and `dispose` both bump `#operation`, so a prompt that
		// outlives its session must never write `submitting` / `error` back
		// into the snapshot of the *new* session — that is how a stuck
		// `submitting: true` (Send button silently disabled) used to happen
		// when the admin debug page re-bound a fresh session mid-flight.
		const operation = this.#operation;
		this.#setSnapshot({ ...this.#snapshot, submitting: true, error: undefined });
		try {
			const result = await action();
			if (this.#operation !== operation) {
				return { session: result.session };
			}
			this.#setSnapshot({
				...this.#snapshot,
				sessions: upsertSession(this.#snapshot.sessions, result.session),
				activeSession: result.session,
				submitting: false,
			});
			return result;
		} catch (error) {
			if (this.#operation === operation) {
				this.#setSnapshot({
					...this.#snapshot,
					submitting: false,
					error: error instanceof Error ? error.message : "会话操作失败",
				});
			}
			throw error;
		}
	}

	#requireActiveHandle(): PiSessionHandle {
		if (!this.#activeHandle) throw new Error("请先选择一个会话");
		return this.#activeHandle;
	}

	#applyProgress(event: Extract<ServerEvent, { type: "session_progress" }>): void {
		const activeSession = this.#snapshot.activeSession;
		if (!activeSession || activeSession.id !== event.sessionId) return;
		if (event.progress.type === "assistant_delta") {
			this.#pendingProgress.push(event.progress);
			this.#scheduleProgressFlush();
			return;
		}
		this.#flushPendingProgress();
		const flushedSession = this.#snapshot.activeSession;
		if (!flushedSession || flushedSession.id !== event.sessionId) return;
		const session = this.#withCitations(applyTranscriptProgress(flushedSession, event.progress));
		if (session === flushedSession) return;
		this.#setSnapshot({
			...this.#snapshot,
			sessions: upsertSession(this.#snapshot.sessions, session),
			activeSession: session,
		});
		const progress = event.progress;
		if (
			progress.type === "item_finished" &&
			progress.item.role === "assistant" &&
			progress.item.status === "error" &&
			!this.#autoAbortedMessageIds.has(progress.item.id)
		) {
			this.#autoAbortedMessageIds.add(progress.item.id);
			// An assistant error is a terminal Turn outcome. Abort is idempotent
			// and releases a provider/post-run path that may still be hanging after
			// a timeout; the UI has already moved to idle via applyTranscriptProgress.
			void this.#activeHandle?.abort().catch(() => {});
		}
	}

	#flushPendingProgress(): void {
		if (this.#progressTimer !== undefined) clearTimeout(this.#progressTimer);
		this.#progressTimer = undefined;
		if (this.#pendingProgress.length === 0) return;
		const pending = this.#pendingProgress;
		this.#pendingProgress = [];
		const activeSession = this.#snapshot.activeSession;
		if (!activeSession) return;
		const session = this.#withCitations(pending.reduce(applyTranscriptProgress, activeSession));
		if (session === activeSession) return;
		this.#setSnapshot({
			...this.#snapshot,
			sessions: upsertSession(this.#snapshot.sessions, session),
			activeSession: session,
		});
	}

	/**
	 * Re-merge any Turn-bound citations into the active transcript. Idempotent:
	 * a Turn with no `citation_snapshot` has no map entry and inherits nothing.
	 */
	#applyCitations(): void {
		if (this.#citationsByTurn.size === 0) return;
		const activeSession = this.#snapshot.activeSession;
		if (!activeSession) return;
		const merged = this.#withCitations(activeSession);
		if (merged === activeSession) return;
		this.#setSnapshot({
			...this.#snapshot,
			sessions: upsertSession(this.#snapshot.sessions, merged),
			activeSession: merged,
		});
	}

	/** Bind an arbitrary session snapshot to the controller's live citations. */
	#withCitations(session: SessionSnapshot): SessionSnapshot {
		return this.#citationsByTurn.size === 0 ? session : mergeCitations(session, this.#citationsByTurn);
	}

	#clearPendingProgress(): void {
		if (this.#progressTimer !== undefined) clearTimeout(this.#progressTimer);
		this.#progressTimer = undefined;
		this.#pendingProgress = [];
	}

	#scheduleProgressFlush(): void {
		if (this.#progressTimer !== undefined) return;
		this.#progressTimer = setTimeout(() => {
			this.#progressTimer = undefined;
			this.#flushPendingProgress();
		}, SessionController.STREAM_FLUSH_INTERVAL_MS);
	}

	/**
	 * Mark the workspace "ready with no session" for the admin blank slate
	 * (a bound Agent whose DebugConversation has not been lazily created yet).
	 * This clears the initial bootstrapping loading flag WITHOUT attaching any
	 * session, so the Composer becomes interactive and the first Send lazily
	 * creates the conversation. No-op once a session is live.
	 */
	clearBootstrapping(): void {
		if (this.#activeHandle !== undefined) return;
		this.#setSnapshot({
			...this.#snapshot,
			activeSessionId: undefined,
			activeSession: undefined,
			uploads: [],
			loading: false,
			submitting: false,
			error: undefined,
		});
	}

	#setSnapshot(snapshot: SessionBrowserSnapshot): void {
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) listener();
	}
}

function mergeCitations(
	session: SessionSnapshot,
	citationsByTurn: ReadonlyMap<string, readonly Citation[]>,
): SessionSnapshot {
	if (citationsByTurn.size === 0) return session;
	let changed = false;
	const transcript = session.transcript.map((item) => {
		if (item.role !== "assistant") return item;
		const turnId = assistantTurnId(item.id);
		const citations = turnId !== null ? citationsByTurn.get(turnId) : undefined;
		if (citations === undefined) return item;
		changed = true;
		return { ...item, citations: [...citations] };
	});
	return changed ? { ...session, transcript } : session;
}

function assistantTurnId(id: string): string | null {
	return id.startsWith("ast:") ? id.slice("ast:".length) : null;
}

function applyTranscriptProgress(session: SessionSnapshot, progress: TranscriptProgress): SessionSnapshot {
	if (progress.type === "assistant_delta") {
		let changed = false;
		const transcript = session.transcript.map((item) => {
			if (item.id !== progress.messageId || item.role !== "assistant") return item;
			const part = item.content[progress.contentIndex];
			if (progress.kind === "text" && part?.type === "text") {
				changed = true;
				const content = [...item.content];
				content[progress.contentIndex] = { ...part, text: part.text + progress.delta };
				return { ...item, content };
			}
			if (progress.kind === "thinking" && part?.type === "thinking") {
				changed = true;
				const content = [...item.content];
				content[progress.contentIndex] = { ...part, thinking: part.thinking + progress.delta };
				return { ...item, content };
			}
			if (progress.contentIndex === item.content.length && progress.kind !== "toolCall") {
				changed = true;
				const content = [...item.content];
				content.push(
					progress.kind === "text"
						? { type: "text", text: progress.delta }
						: { type: "thinking", thinking: progress.delta },
				);
				return { ...item, content };
			}
			return item;
		});
		return changed ? { ...session, phase: "turn", transcript } : session;
	}
	const terminalAssistant =
		progress.type === "item_finished" &&
		progress.item.role === "assistant" &&
		(progress.item.status === "error" || progress.item.status === "aborted");
	return {
		...session,
		phase: terminalAssistant ? "idle" : "turn",
		transcript: upsertTranscriptItem(session.transcript, progress.item),
	};
}

function upsertTranscriptItem(transcript: readonly TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
	const index = transcript.findIndex((candidate) => candidate.id === item.id);
	if (index === -1) return [...transcript, item];
	const next = [...transcript];
	next[index] = item;
	return next;
}

function upsertSession(sessions: readonly SessionSummary[], session: SessionSummary): readonly SessionSummary[] {
	const next = sessions.filter((candidate) => candidate.id !== session.id);
	return [session, ...next].sort((left, right) => right.updatedAt - left.updatedAt);
}
