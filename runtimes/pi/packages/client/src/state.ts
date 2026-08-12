import type {
	Attachment,
	Citation,
	CommandResult,
	ServerEvent,
	ServerSnapshot,
	SessionSnapshot,
	Source,
} from "@earendil-works/pi-protocol";
import { toError } from "./errors.ts";
import type { ListenerErrorHandler, Unsubscribe } from "./types.ts";

export class ClientState {
	readonly #sessionSnapshots = new Map<string, SessionSnapshot>();
	/**
	 * Highest `session_progress` sequence applied per session. Kept across
	 * reconnects so the client can resume from the last acknowledged position and
	 * drop events it has already seen or that a newer snapshot already covers.
	 */
	readonly #sessionSequences = new Map<string, number>();
	readonly #attachedSessionIds = new Set<string>();
	readonly #snapshotListeners = new Set<(snapshot: ServerSnapshot) => void>();
	readonly #eventListeners = new Set<(event: ServerEvent) => void>();
	readonly #sessionSnapshotListeners = new Map<string, Set<(snapshot: SessionSnapshot) => void>>();
	readonly #sessionEventListeners = new Map<string, Set<(event: ServerEvent) => void>>();
	readonly #onListenerError: ListenerErrorHandler | undefined;
	#snapshot: ServerSnapshot | undefined;

	constructor(onListenerError?: ListenerErrorHandler) {
		this.#onListenerError = onListenerError;
	}

	get snapshot(): ServerSnapshot | undefined {
		return this.#snapshot;
	}

	reset(): void {
		this.#snapshot = undefined;
		this.#sessionSnapshots.clear();
		this.#attachedSessionIds.clear();
		// Per-session sequences survive a reconnect so the client can resume.
	}

	/** Last acknowledged progress sequence for a session; 0 when none have been seen. */
	getLastSequence(sessionId: string): number {
		return this.#sessionSequences.get(sessionId) ?? 0;
	}

	clearAttachments(): void {
		this.#attachedSessionIds.clear();
	}

	dispose(): void {
		this.reset();
		this.#snapshotListeners.clear();
		this.#eventListeners.clear();
		this.#sessionSnapshotListeners.clear();
		this.#sessionEventListeners.clear();
	}

	getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		return this.#sessionSnapshots.get(sessionId);
	}

	isSessionAttached(sessionId: string): boolean {
		return this.#attachedSessionIds.has(sessionId);
	}

	forgetSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		const previous = this.#sessionSnapshots.get(sessionId);
		this.#sessionSnapshots.delete(sessionId);
		return previous;
	}

	restoreSessionSnapshot(snapshot: SessionSnapshot): void {
		if (!this.#sessionSnapshots.has(snapshot.id)) this.#sessionSnapshots.set(snapshot.id, snapshot);
	}

	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		this.#snapshotListeners.add(listener);
		return () => this.#snapshotListeners.delete(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	subscribeSession(sessionId: string, listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return addMappedListener(this.#sessionSnapshotListeners, sessionId, listener);
	}

	onSessionEvent(sessionId: string, listener: (event: ServerEvent) => void): Unsubscribe {
		return addMappedListener(this.#sessionEventListeners, sessionId, listener);
	}

	applyResult(result: CommandResult): void {
		if (result.command === "list") return;
		if (result.command === "detach") {
			this.#attachedSessionIds.delete(result.sessionId);
			const snapshot = this.#sessionSnapshots.get(result.sessionId);
			if (snapshot) this.#applySessionSnapshot({ ...snapshot, attached: false }, true);
			return;
		}
		// Speech results carry a job handle, not a session snapshot; job lifecycle
		// is delivered through `speech_job` / `live_speech_job` events and never
		// touches session state.
		if (
			result.command === "start_speech" ||
			result.command === "cancel_speech" ||
			result.command === "cancel_live_speech"
		) {
			return;
		}
		this.#applySessionSnapshot(result.session);
	}

	applyEvent(event: ServerEvent): void {
		if (event.type === "session_progress") {
			const last = this.#sessionSequences.get(event.sessionId) ?? 0;
			// Drop events already applied directly or covered by a newer snapshot.
			if (event.sequence <= last) return;
			this.#sessionSequences.set(event.sessionId, event.sequence);
		}
		if (event.type === "server_snapshot") this.applyServerSnapshot(event.snapshot);
		if (event.type === "session_snapshot") this.#applySessionSnapshot(event.snapshot);
		if (event.type === "session_removed") {
			this.#sessionSnapshots.delete(event.sessionId);
			this.#sessionSequences.delete(event.sessionId);
			this.#attachedSessionIds.delete(event.sessionId);
		}
		if (event.type === "attachment_snapshot") this.#applyAttachmentSnapshot(event.attachment);
		if (event.type === "attachment_removed") this.#applyAttachmentRemoved(event.sessionId, event.attachmentId);
		if (event.type === "source_snapshot") this.#applySourceSnapshot(event.source);
		if (event.type === "citation_snapshot") this.#applyCitationSnapshot(event.sessionId, event.citations);
		this.#notify(this.#eventListeners, event);
		const sessionId = getEventSessionId(event);
		if (sessionId) this.#notify(this.#sessionEventListeners.get(sessionId), event);
	}

	applyServerSnapshot(snapshot: ServerSnapshot): void {
		if (this.#snapshot && snapshot.revision < this.#snapshot.revision) return;
		// A new server instance has no memory of prior sessions or their
		// sequences, so forget what we knew and resume fresh.
		if (this.#snapshot && this.#snapshot.serverId !== snapshot.serverId) this.#sessionSequences.clear();
		this.#snapshot = snapshot;
		this.#attachedSessionIds.clear();
		for (const session of snapshot.sessions) if (session.attached) this.#attachedSessionIds.add(session.id);
		this.#notify(this.#snapshotListeners, snapshot);
	}

	#applySessionSnapshot(snapshot: SessionSnapshot, force = false): void {
		const current = this.#sessionSnapshots.get(snapshot.id);
		if (!force && current && snapshot.revision < current.revision) return;
		this.#sessionSequences.set(snapshot.id, snapshot.lastSequence);
		this.#sessionSnapshots.set(snapshot.id, snapshot);
		if (snapshot.attached) this.#attachedSessionIds.add(snapshot.id);
		else this.#attachedSessionIds.delete(snapshot.id);
		this.#notify(this.#sessionSnapshotListeners.get(snapshot.id), snapshot);
	}

	/** Merge a single authoritative attachment into its session's snapshot. */
	#applyAttachmentSnapshot(attachment: Attachment): void {
		if (!attachment.sessionId) return;
		const session = this.#sessionSnapshots.get(attachment.sessionId);
		if (!session) return;
		const next = [...(session.attachments ?? []).filter((candidate) => candidate.id !== attachment.id), attachment];
		this.#applySessionSnapshot({ ...session, attachments: next });
	}

	/** Drop an attachment from its session's snapshot after removal. */
	#applyAttachmentRemoved(sessionId: string, attachmentId: string): void {
		const session = this.#sessionSnapshots.get(sessionId);
		if (!session) return;
		const next = (session.attachments ?? []).filter((candidate) => candidate.id !== attachmentId);
		if (next.length === (session.attachments?.length ?? 0)) return;
		this.#applySessionSnapshot({ ...session, attachments: next });
	}

	/** Merge a single source status change into its session's snapshot. */
	#applySourceSnapshot(source: Source): void {
		const session = this.#sessionSnapshots.get(source.sessionId);
		if (!session) return;
		const next = [...(session.sources ?? []).filter((candidate) => candidate.id !== source.id), source];
		this.#applySessionSnapshot({ ...session, sources: next });
	}

	/** Replace the current turn's citations; a snapshot omitting the field resets them. */
	#applyCitationSnapshot(sessionId: string, citations: Citation[]): void {
		const session = this.#sessionSnapshots.get(sessionId);
		if (!session) return;
		this.#applySessionSnapshot({ ...session, citations });
	}

	#notify<T>(listeners: Iterable<(value: T) => void> | undefined, value: T): void {
		for (const listener of listeners ?? []) {
			try {
				listener(value);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#reportListenerError(error: unknown): void {
		if (!this.#onListenerError) return;
		try {
			this.#onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect client state.
		}
	}
}

function addMappedListener<T>(
	listenersById: Map<string, Set<(value: T) => void>>,
	id: string,
	listener: (value: T) => void,
): Unsubscribe {
	let listeners = listenersById.get(id);
	if (!listeners) {
		listeners = new Set();
		listenersById.set(id, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) listenersById.delete(id);
	};
}

function getEventSessionId(event: ServerEvent): string | undefined {
	if (event.type === "session_snapshot") return event.snapshot.id;
	if (
		event.type === "session_progress" ||
		event.type === "session_removed" ||
		event.type === "attachment_removed" ||
		event.type === "citation_snapshot"
	) {
		return event.sessionId;
	}
	if (event.type === "attachment_snapshot") return event.attachment.sessionId;
	if (event.type === "source_snapshot") return event.source.sessionId;
	return undefined;
}
