import type { PiSessionHandle } from "@earendil-works/pi-client";
import type {
	LiveSpeechJob,
	LiveSpeechRequest,
	ServerEvent,
	ServerSnapshot,
	SessionSnapshot,
	SessionSummary,
	TranscriptItem,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type { PiUploadClient } from "./uploader.ts";

export interface PiSessionClient {
	readonly snapshot: ServerSnapshot | undefined;
	subscribe(listener: (snapshot: ServerSnapshot) => void): () => void;
	createSession(): Promise<PiSessionHandle>;
	attachSession(sessionId: string): Promise<PiSessionHandle>;
}

/** A file upload that has not yet become an attached attachment. */
export interface UploadItem {
	localId: string;
	name: string;
	status: "uploading" | "failed";
	/** 0-100 upload progress while uploading. */
	progress?: number;
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
	createSession(): Promise<void>;
	selectSession(sessionId: string): Promise<void>;
	send(text: string, options?: SessionPromptPayload): Promise<SessionSendResult>;
	abort(): Promise<void>;
	uploadFiles(files: File[]): Promise<void>;
	removeAttachment(attachmentId: string): Promise<void>;
	dismissUpload(localId: string): void;
}

export class SessionController implements SessionBrowserStore {
	readonly #client: PiSessionClient;
	readonly #uploads: PiUploadClient;
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribeClient: () => void;
	#activeHandle: PiSessionHandle | undefined;
	#unsubscribeActive: (() => void) | undefined;
	#unsubscribeActiveEvents: (() => void) | undefined;
	#operation = 0;
	#uploadSequence = 0;
	#snapshot: SessionBrowserSnapshot;

	constructor(client: PiSessionClient, uploads: PiUploadClient) {
		this.#client = client;
		this.#uploads = uploads;
		this.#snapshot = {
			sessions: client.snapshot?.sessions ?? [],
			activeSessionId: undefined,
			activeSession: undefined,
			uploads: [],
			loading: false,
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

	async createSession(): Promise<void> {
		await this.#activate(() => this.#client.createSession());
	}

	async selectSession(sessionId: string): Promise<void> {
		if (this.#activeHandle?.id === sessionId && this.#activeHandle.active) return;
		await this.#activate(() => this.#client.attachSession(sessionId));
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
		const promptResult = await this.#runSessionAction(handle, () =>
			this.#snapshot.activeSession?.phase === "idle"
				? hasPromptOptions
					? handle.prompt(message, promptOptions)
					: handle.prompt(message)
				: hasPromptOptions
					? handle.steer(message, promptOptions)
					: handle.steer(message),
		);
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

	#updateUpload(localId: string, patch: Partial<UploadItem>): void {
		this.#setSnapshot({
			...this.#snapshot,
			uploads: this.#snapshot.uploads.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
		});
	}

	#applySessionUpdate(session: SessionSnapshot): void {
		if (this.#activeHandle?.id !== session.id) return;
		this.#setSnapshot({
			...this.#snapshot,
			sessions: upsertSession(this.#snapshot.sessions, session),
			activeSession: session,
		});
	}

	async dispose(): Promise<void> {
		this.#operation += 1;
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
				this.#setSnapshot({
					...this.#snapshot,
					sessions: upsertSession(this.#snapshot.sessions, session),
					activeSession: session,
				});
			});
			this.#unsubscribeActiveEvents = handle.onEvent((event) => {
				if (this.#activeHandle !== handle || event.type !== "session_progress") return;
				this.#applyProgress(event);
			});
		} catch (error) {
			if (operation !== this.#operation) return;
			this.#setSnapshot({
				...this.#snapshot,
				activeSessionId: undefined,
				activeSession: undefined,
				loading: false,
				error: error instanceof Error ? error.message : "会话操作失败",
			});
			throw error;
		}
	}

	async #runSessionAction(
		handle: PiSessionHandle,
		action: () => Promise<{ session: SessionSnapshot; [key: string]: unknown }>,
	): Promise<{ session: SessionSnapshot; command?: string; liveSpeech?: LiveSpeechJob }> {
		this.#setSnapshot({ ...this.#snapshot, submitting: true, error: undefined });
		try {
			const result = await action();
			if (this.#activeHandle !== handle) {
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
			if (this.#activeHandle === handle) {
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
		const session = applyTranscriptProgress(activeSession, event.progress);
		if (session === activeSession) return;
		this.#setSnapshot({
			...this.#snapshot,
			sessions: upsertSession(this.#snapshot.sessions, session),
			activeSession: session,
		});
	}

	#setSnapshot(snapshot: SessionBrowserSnapshot): void {
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) listener();
	}
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
	return {
		...session,
		phase: "turn",
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
