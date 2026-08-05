import type { PiSessionHandle } from "@earendil-works/pi-client";
import type { ServerSnapshot, SessionSnapshot, SessionSummary } from "@earendil-works/pi-protocol";

export interface PiSessionClient {
	readonly snapshot: ServerSnapshot | undefined;
	subscribe(listener: (snapshot: ServerSnapshot) => void): () => void;
	createSession(): Promise<PiSessionHandle>;
	attachSession(sessionId: string): Promise<PiSessionHandle>;
}

export interface SessionBrowserSnapshot {
	sessions: readonly SessionSummary[];
	activeSessionId: string | undefined;
	activeSession: SessionSnapshot | undefined;
	loading: boolean;
	submitting: boolean;
	error: string | undefined;
}

export interface SessionBrowserStore {
	getSnapshot(): SessionBrowserSnapshot;
	subscribe(listener: () => void): () => void;
	createSession(): Promise<void>;
	selectSession(sessionId: string): Promise<void>;
	send(text: string): Promise<void>;
	abort(): Promise<void>;
}

export class SessionController implements SessionBrowserStore {
	readonly #client: PiSessionClient;
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribeClient: () => void;
	#activeHandle: PiSessionHandle | undefined;
	#unsubscribeActive: (() => void) | undefined;
	#operation = 0;
	#snapshot: SessionBrowserSnapshot;

	constructor(client: PiSessionClient) {
		this.#client = client;
		this.#snapshot = {
			sessions: client.snapshot?.sessions ?? [],
			activeSessionId: undefined,
			activeSession: undefined,
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

	async send(text: string): Promise<void> {
		const message = text.trim();
		if (!message) throw new Error("消息不能为空");
		const handle = this.#requireActiveHandle();
		if (this.#snapshot.submitting) throw new Error("正在提交上一项操作");
		await this.#runSessionAction(handle, () =>
			this.#snapshot.activeSession?.phase === "idle" ? handle.prompt(message) : handle.steer(message),
		);
	}

	async abort(): Promise<void> {
		const handle = this.#requireActiveHandle();
		if (this.#snapshot.activeSession?.phase === "idle") return;
		if (this.#snapshot.submitting) throw new Error("正在提交上一项操作");
		await this.#runSessionAction(handle, () => handle.abort());
	}

	async dispose(): Promise<void> {
		this.#operation += 1;
		this.#unsubscribeClient();
		this.#listeners.clear();
		const handle = this.#activeHandle;
		this.#unsubscribeActive?.();
		this.#unsubscribeActive = undefined;
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

	async #runSessionAction(handle: PiSessionHandle, action: () => Promise<SessionSnapshot>): Promise<void> {
		this.#setSnapshot({ ...this.#snapshot, submitting: true, error: undefined });
		try {
			const session = await action();
			if (this.#activeHandle !== handle) return;
			this.#setSnapshot({
				...this.#snapshot,
				sessions: upsertSession(this.#snapshot.sessions, session),
				activeSession: session,
				submitting: false,
			});
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

	#setSnapshot(snapshot: SessionBrowserSnapshot): void {
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) listener();
	}
}

function upsertSession(sessions: readonly SessionSummary[], session: SessionSummary): readonly SessionSummary[] {
	const next = sessions.filter((candidate) => candidate.id !== session.id);
	return [session, ...next].sort((left, right) => right.updatedAt - left.updatedAt);
}
