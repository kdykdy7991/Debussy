import { randomUUID } from "node:crypto";
import type {
	Attachment,
	AttachmentScope,
	Citation,
	Command,
	EventEnvelope,
	ServerEvent,
	SessionSnapshot,
	SessionSummary,
	Source,
	TranscriptItem,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type { CitationService } from "./citations/service.ts";
import type { ByteConnection, ConnectionState } from "./connection.ts";
import { PiServerError } from "./errors.ts";
import { SessionEventLog } from "./event-log.ts";
import type {
	CreateSessionOptions,
	PiSessionBackend,
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	ResolvedAttachmentInput,
	RetrievalInput,
} from "./types.ts";
import type { AttachmentStore } from "./uploads/store.ts";
import type { LiveSpeechManager, LiveSpeechPrepareResult } from "./voice/live/live-speech-manager.ts";

interface LiveSession {
	id: string;
	runtime: PiSessionRuntime;
	connections: Set<ConnectionState>;
	unsubscribe: () => void;
	operationCount: number;
	ready: boolean;
	terminal: boolean;
	disposing?: Promise<void>;
	/** Bounded per-session replay buffer; survives runtime disposal until expired. */
	log: SessionEventLog;
	/** Stable id for progress events belonging to the current agent turn. */
	currentTurnId?: string;
	/** Runtime snapshot enriched with the in-flight turn for newly attached clients. */
	transientSnapshot?: SessionSnapshot;
	/** Citations for the most recent turn; surfaced in snapshots and restored on reopen. */
	citations?: Citation[];
}

interface LiveSessionManagerOptions {
	backend: PiSessionBackend;
	isClosing: () => boolean;
	sendMessage: (connection: ConnectionState, message: EventEnvelope) => Promise<boolean>;
	closeConnection: (connection: ByteConnection) => Promise<void>;
	disconnect: (connection: ConnectionState) => Promise<void>;
	broadcastServerSnapshot: () => void;
	reportError: (error: unknown) => void;
	sessionEventLogMaxEvents: number;
	sessionEventLogRetentionMs: number;
	/** Upload/attachment store backing `attach_upload` / `remove_attachment`. */
	attachments?: AttachmentStore;
	/** Citation index + retrieval service backing P2 source/citation flows. */
	citations?: CitationService;
	/** Phase 2 live speech coordinator; when absent, live jobs are unavailable. */
	liveSpeech?: LiveSpeechManager;
}

function toSummary(snapshot: SessionSnapshot): SessionSummary {
	return {
		id: snapshot.id,
		name: snapshot.name,
		cwd: snapshot.cwd,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
		phase: snapshot.phase,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		attached: snapshot.attached,
		locked: snapshot.locked,
	};
}

export class LiveSessionManager {
	private readonly options: LiveSessionManagerOptions;
	private readonly liveSessions = new Map<string, LiveSession>();
	private readonly openingSessions = new Map<string, Promise<LiveSession>>();
	private readonly eventLogs = new Map<string, SessionEventLog>();
	private readonly eventLogSweepTimer: ReturnType<typeof setInterval>;

	constructor(options: LiveSessionManagerOptions) {
		this.options = options;
		// Broadcast source status changes (pending → ready/failed/removed) to the
		// owning session's connections as soon as the store records them.
		if (options.citations) {
			options.citations.onSourceChange = (source) => this.broadcastSourceChange(source);
		}
		// Expire event logs for sessions that were disposed long ago so an idle
		// server does not accumulate unbounded per-session replay buffers.
		const sweepIntervalMs = Math.max(Math.floor(options.sessionEventLogRetentionMs / 2), 1_000);
		this.eventLogSweepTimer = setInterval(() => this.sweepEventLogs(), sweepIntervalMs);
		this.eventLogSweepTimer.unref();
	}

	async executeCommand(connection: ConnectionState, command: Command) {
		switch (command.command) {
			case "list":
				return { command: "list" as const, sessions: await this.listSummaries(connection) };
			case "create": {
				const id = randomUUID();
				const options: CreateSessionOptions = {
					id,
					cwd: command.cwd,
					name: command.name,
					model: command.model,
					thinkingLevel: command.thinkingLevel,
				};
				const live = await this.acquire(id, () => this.options.backend.createSession(options));
				await this.attach(connection, live);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "create" as const, session };
			}
			case "attach": {
				const live = await this.acquire(command.sessionId, () =>
					this.options.backend.openSession(command.sessionId),
				);
				await this.attach(connection, live);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "attach" as const, session };
			}
			case "detach": {
				const live = this.liveSessions.get(command.sessionId);
				if (connection.sessionIds.has(command.sessionId)) {
					connection.sessionIds.delete(command.sessionId);
					// Detaching the owning connection cancels its live speech.
					this.options.liveSpeech?.abortConnectionSessionJobs(connection, command.sessionId);
					if (live) {
						live.connections.delete(connection);
						if (live.connections.size > 0 && !live.terminal && !live.disposing) {
							await this.broadcastSnapshot(live);
						}
						await this.maybeDispose(live);
					}
					this.options.broadcastServerSnapshot();
				}
				return { command: "detach" as const, sessionId: command.sessionId };
			}
			case "resume": {
				const live = await this.acquire(command.sessionId, () =>
					this.options.backend.openSession(command.sessionId),
				);
				await this.attach(connection, live);
				const { replayedThrough, resetRequired } = await live.log.replay(command.afterSequence, (event) =>
					this.options.sendMessage(connection, { type: "event", event }),
				);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "resume" as const, session, replayedThrough, resetRequired };
			}
			case "prompt": {
				const live = this.requireAttached(connection, command.sessionId);
				const turnId = randomUUID();
				const { attachments, retrieval } = await this.preparePromptInputs(
					live,
					command.attachmentIds,
					command.text,
					turnId,
				);
				// Phase 2 live朗读: create the job and register the runtime
				// listener BEFORE `runtime.prompt()` so no first delta is lost.
				// `prepare` is synchronous; prompt failure rolls the job back
				// atomically (the client never receives a job handle).
				let prepared: LiveSpeechPrepareResult | undefined;
				if (command.speech) {
					prepared = this.options.liveSpeech?.prepare({
						connection,
						runtime: live.runtime,
						sessionId: live.id,
						speech: command.speech,
						turnId,
					});
				}
				try {
					const session = await this.runOperation(
						connection,
						live,
						() => {
							const prompt = live.runtime.prompt({
								text: command.text,
								attachmentIds: command.attachmentIds,
								attachments,
								retrieval,
							});
							prepared?.announce();
							return prompt;
						},
						{ turnId, citations: retrieval?.citations ?? [] },
					);
					return {
						command: "prompt" as const,
						session,
						...(prepared ? { liveSpeech: prepared.job } : {}),
					};
				} catch (error) {
					prepared?.rollback();
					throw error;
				}
			}
			case "steer": {
				const live = this.requireAttached(connection, command.sessionId);
				const turnId = randomUUID();
				const { attachments, retrieval } = await this.preparePromptInputs(
					live,
					command.attachmentIds,
					command.text,
					turnId,
				);
				// Steer cancels the old turn's live speech; v1 does not auto-restart.
				this.options.liveSpeech?.abortSessionJobs(live.id, "agent_steer", "Agent turn was steered");
				const session = await this.runOperation(
					connection,
					live,
					() =>
						live.runtime.steer({
							text: command.text,
							attachmentIds: command.attachmentIds,
							attachments,
							retrieval,
						}),
					{ turnId, citations: retrieval?.citations ?? [] },
				);
				return { command: "steer" as const, session };
			}
			case "attach_upload": {
				const live = this.requireAttached(connection, command.sessionId);
				await this.attachUpload(live, command.uploadId, command.scope);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "attach_upload" as const, session };
			}
			case "remove_attachment": {
				const live = this.requireAttached(connection, command.sessionId);
				await this.removeAttachment(live, command.attachmentId);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "remove_attachment" as const, session };
			}
			case "abort": {
				const live = this.requireAttached(connection, command.sessionId);
				// Aborting the Agent also cancels the turn's live speech.
				this.options.liveSpeech?.abortSessionJobs(live.id, "agent_abort", "Agent turn was aborted");
				const session = await this.runOperation(connection, live, () => live.runtime.abort());
				return { command: "abort" as const, session };
			}
			case "set_model": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.setModel(command.model));
				return { command: "set_model" as const, session };
			}
			case "set_thinking": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () =>
					live.runtime.setThinking(command.thinkingLevel),
				);
				return { command: "set_thinking" as const, session };
			}
			case "cancel_live_speech": {
				const manager = this.options.liveSpeech;
				if (!manager) {
					throw new PiServerError("invalid_state", "Live speech is not available on this server build");
				}
				return manager.executeCancel(connection, command);
			}
			default:
				// Phase 1 SpeechManager commands are routed by PiServer and never
				// reach session command execution.
				throw new PiServerError("invalid_request", `Unhandled command: ${command.command}`);
		}
	}

	/**
	 * Resolve the transcript item backing a speech request. The connection must
	 * be attached to the session, the session must be live, and the message must
	 * exist in its authoritative snapshot. Role/status/speakability validation
	 * stays in the speech layer; this method only performs ownership + lookup.
	 */
	resolveMessageForSpeech(connection: ConnectionState, sessionId: string, messageId: string): TranscriptItem {
		if (!connection.sessionIds.has(sessionId)) {
			throw new PiServerError("invalid_request", `Connection is not attached to session ${sessionId}`);
		}
		const live = this.liveSessions.get(sessionId);
		if (!live || live.terminal || live.disposing) {
			throw new PiServerError("not_found", `Session is not live: ${sessionId}`);
		}
		const snapshot = live.transientSnapshot ?? live.runtime.snapshot();
		const item = snapshot.transcript.find((candidate) => candidate.id === messageId);
		if (!item) throw new PiServerError("not_found", `Message is not in the session transcript: ${messageId}`);
		return item;
	}

	async disconnect(connection: ConnectionState): Promise<void> {
		const sessions = [...connection.sessionIds]
			.map((id) => this.liveSessions.get(id))
			.filter((live): live is LiveSession => live !== undefined);
		connection.sessionIds.clear();
		for (const live of sessions) live.connections.delete(connection);
		const results = await Promise.allSettled(sessions.map((live) => this.maybeDispose(live)));
		for (const result of results) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
	}

	async listSummaries(connection?: ConnectionState): Promise<SessionSummary[]> {
		const stored = await this.options.backend.listSessions();
		const liveSnapshots = await Promise.all(
			[...this.liveSessions.values()]
				.filter((live) => !live.disposing)
				.map(async (live) => [live.id, await this.normalizedSnapshot(live)] as const),
		);
		const liveById = new Map(liveSnapshots);
		const summaries = stored.map((summary) => {
			const snapshot = liveById.get(summary.id);
			if (!snapshot) return { ...summary, attached: false };
			liveById.delete(summary.id);
			return { ...toSummary(snapshot), attached: connection?.sessionIds.has(summary.id) ?? false };
		});
		for (const snapshot of liveById.values()) {
			summaries.push({ ...toSummary(snapshot), attached: connection?.sessionIds.has(snapshot.id) ?? false });
		}
		return summaries;
	}

	async close(): Promise<void> {
		clearInterval(this.eventLogSweepTimer);
		this.eventLogs.clear();
		const openingResults = await Promise.allSettled([...this.openingSessions.values()]);
		for (const result of openingResults) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
		const sessions = [...this.liveSessions.values()];
		this.liveSessions.clear();
		await Promise.all(
			sessions.map(async (live) => {
				if (live.disposing) {
					await live.disposing;
					return;
				}
				live.unsubscribe();
				await live.runtime.dispose();
			}),
		);
	}

	private async runOperation(
		connection: ConnectionState,
		live: LiveSession,
		operation: () => Promise<void>,
		options: { turnId?: string; citations?: readonly Citation[] } = {},
	): Promise<SessionSnapshot> {
		live.operationCount += 1;
		live.currentTurnId = options.turnId ?? randomUUID();
		// A retrieval turn replaces the previous turn's citations; other
		// operations (abort/setModel/setThinking) leave them untouched.
		if (options.citations !== undefined) live.citations = undefined;
		live.transientSnapshot = live.runtime.snapshot();
		try {
			await operation();
			if (options.citations !== undefined) {
				const citations = [...options.citations];
				live.citations = citations;
				await this.options.citations?.persistCitations(live.id, live.currentTurnId, citations);
				if (citations.length > 0) {
					this.broadcastEvent(live, {
						type: "citation_snapshot",
						sessionId: live.id,
						turnId: live.currentTurnId,
						citations,
					});
				}
			}
			live.transientSnapshot = live.runtime.snapshot();
			return this.forConnection(await this.broadcastSnapshot(live), connection);
		} finally {
			live.currentTurnId = undefined;
			live.operationCount -= 1;
			this.scheduleMaybeDispose(live);
		}
	}

	private async acquire(id: string, acquireRuntime: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		for (;;) {
			const existing = this.liveSessions.get(id);
			if (existing) {
				if (existing.terminal) throw new PiServerError("session_locked", `Session runtime is terminating: ${id}`);
				if (existing.disposing) {
					await existing.disposing;
					continue;
				}
				return existing;
			}
			const opening = this.openingSessions.get(id);
			if (opening) return opening;
			const pending = this.create(id, acquireRuntime);
			this.openingSessions.set(id, pending);
			try {
				return await pending;
			} finally {
				if (this.openingSessions.get(id) === pending) this.openingSessions.delete(id);
			}
		}
	}

	private async create(id: string, acquireRuntime: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		const runtime = await acquireRuntime();
		if (this.options.isClosing()) {
			await runtime.dispose();
			throw new Error("PiServer closed while acquiring a session runtime");
		}
		let live: LiveSession | undefined;
		try {
			const snapshot = await runtime.snapshot();
			if (snapshot.id !== id) {
				throw new PiServerError(
					"invalid_request",
					`Backend returned session ${snapshot.id} for server-assigned session ${id}`,
				);
			}
			live = {
				id,
				runtime,
				connections: new Set(),
				unsubscribe: () => {},
				operationCount: 0,
				ready: false,
				terminal: false,
				log: this.eventLogFor(id),
			};
			// Restore the last turn's citations so reconnect/restart history shows them.
			live.citations = (await this.options.citations?.loadLatestCitations(id)) ?? [];
			live.unsubscribe = runtime.subscribe((event) => this.handleRuntimeEvent(live!, event));
			this.liveSessions.set(id, live);
			live.ready = true;
			return live;
		} catch (error) {
			if (live) live.unsubscribe();
			try {
				await runtime.dispose();
			} catch (disposeError) {
				this.options.reportError(disposeError);
			}
			throw error;
		}
	}

	private handleRuntimeEvent(live: LiveSession, event: PiSessionRuntimeEvent): void {
		if (event.type === "error") {
			void this.terminate(live, event.error).catch((error: unknown) => this.options.reportError(error));
			return;
		}
		if (event.type === "progress") {
			const turnId = live.currentTurnId ?? randomUUID();
			live.currentTurnId = turnId;
			const progress = live.log.append({
				type: "session_progress",
				sessionId: live.id,
				turnId,
				progress: event.progress,
			});
			live.transientSnapshot = applyProgress(live.transientSnapshot ?? live.runtime.snapshot(), event.progress);
			const envelope: EventEnvelope = { type: "event", event: progress };
			for (const connection of live.connections) void this.options.sendMessage(connection, envelope);
		} else {
			live.transientSnapshot = mergeRuntimeSnapshot(live.transientSnapshot, live.runtime.snapshot());
			void this.broadcastSnapshot(live).catch((error: unknown) => this.options.reportError(error));
		}
		this.scheduleMaybeDispose(live);
	}

	private async terminate(live: LiveSession, error: PiServerError): Promise<void> {
		if (live.terminal) return;
		live.terminal = true;
		this.options.reportError(error);
		this.options.liveSpeech?.abortSessionJobs(live.id, "agent_abort", "Session terminated");
		live.unsubscribe();
		const connections = [...live.connections];
		await Promise.all(connections.map((connection) => this.options.closeConnection(connection.connection)));
		await Promise.all(connections.map((connection) => this.options.disconnect(connection)));
		await this.maybeDispose(live);
	}

	private async normalizedSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = live.transientSnapshot ?? live.runtime.snapshot();
		if (snapshot.id !== live.id) {
			throw new PiServerError("invalid_request", `Runtime session ID changed from ${live.id} to ${snapshot.id}`);
		}
		const attachments = this.options.attachments?.listBySession(live.id);
		const sources = this.options.citations?.listSourcesBySession(live.id);
		const citations = live.citations && live.citations.length > 0 ? live.citations : undefined;
		return {
			...snapshot,
			phase: live.runtime.getPhase(),
			attached: live.connections.size > 0,
			locked: true,
			lastSequence: live.log.lastSequence,
			...(attachments && attachments.length > 0 ? { attachments } : {}),
			...(sources && sources.length > 0 ? { sources } : {}),
			...(citations ? { citations } : {}),
		};
	}

	private forConnection(snapshot: SessionSnapshot, connection: ConnectionState): SessionSnapshot {
		return { ...snapshot, attached: connection.sessionIds.has(snapshot.id) };
	}

	private async broadcastSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = await this.normalizedSnapshot(live);
		const envelope: EventEnvelope = { type: "event", event: { type: "session_snapshot", snapshot } };
		for (const connection of live.connections) void this.options.sendMessage(connection, envelope);
		return snapshot;
	}

	private async attach(connection: ConnectionState, live: LiveSession): Promise<void> {
		if (connection.disconnected || connection.stage !== "ready" || connection.connection.closed) {
			await this.maybeDispose(live);
			throw new PiServerError("invalid_request", "Connection closed while attaching to a session");
		}
		connection.sessionIds.add(live.id);
		live.connections.add(connection);
	}

	private requireAttached(connection: ConnectionState, sessionId: string): LiveSession {
		if (!connection.sessionIds.has(sessionId)) {
			throw new PiServerError("invalid_request", `Connection is not attached to session ${sessionId}`);
		}
		const live = this.liveSessions.get(sessionId);
		if (!live || live.terminal || live.disposing) {
			throw new PiServerError("not_found", `Session is not live: ${sessionId}`);
		}
		return live;
	}

	private scheduleMaybeDispose(live: LiveSession): void {
		void this.maybeDispose(live).catch((error: unknown) => this.options.reportError(error));
	}

	private async maybeDispose(live: LiveSession): Promise<void> {
		if (
			this.options.isClosing() ||
			!live.ready ||
			live.disposing ||
			live.connections.size > 0 ||
			live.operationCount > 0 ||
			(!live.terminal && live.runtime.getPhase() !== "idle")
		) {
			return live.disposing;
		}
		// Session disposal removes any live speech it still owns.
		this.options.liveSpeech?.abortSessionJobs(live.id, "session_removed", "Session disposed");
		live.unsubscribe();
		live.disposing = (async () => {
			try {
				await live.runtime.dispose();
			} finally {
				if (this.liveSessions.get(live.id) === live) this.liveSessions.delete(live.id);
			}
		})();
		await live.disposing;
		if (!this.options.isClosing()) this.options.broadcastServerSnapshot();
	}

	/**
	 * Get or create the replay log for a session. A log that already exists
	 * (because an earlier runtime was disposed but its events are still within
	 * the retention window) is adopted as-is so sequences stay contiguous across
	 * reopens.
	 */
	private eventLogFor(id: string): SessionEventLog {
		this.sweepEventLogs();
		let log = this.eventLogs.get(id);
		if (!log) {
			log = new SessionEventLog({
				maxEvents: this.options.sessionEventLogMaxEvents,
				retentionMs: this.options.sessionEventLogRetentionMs,
			});
			this.eventLogs.set(id, log);
		}
		return log;
	}

	/** Drop logs whose sessions are no longer live and have been idle too long. */
	private sweepEventLogs(): void {
		if (this.eventLogs.size === 0) return;
		const cutoff = Date.now() - this.options.sessionEventLogRetentionMs;
		for (const [id, log] of this.eventLogs) {
			if (this.liveSessions.has(id)) continue;
			if (log.lastActivityAtMs < cutoff) this.eventLogs.delete(id);
		}
	}

	/** Bind a ready upload to a session; idempotent when already bound to the same session. */
	private async attachUpload(live: LiveSession, uploadId: string, scope: AttachmentScope): Promise<Attachment> {
		const store = this.requireAttachmentStore();
		const record = store.get(uploadId);
		if (!record) throw new PiServerError("not_found", `Unknown upload: ${uploadId}`);
		const attachment = record.attachment;
		if (attachment.status !== "ready") {
			throw new PiServerError("invalid_state", `Upload is not ready (status: ${attachment.status})`, {
				status: attachment.status,
			});
		}
		if (attachment.sessionId !== undefined && attachment.sessionId !== live.id) {
			throw new PiServerError("conflict", `Upload is attached to another session: ${attachment.sessionId}`);
		}
		const bound = await store.bind(uploadId, live.id, scope);
		if (!bound) throw new PiServerError("not_found", `Unknown upload: ${uploadId}`);
		this.broadcastEvent(live, { type: "attachment_snapshot", attachment: bound.attachment });
		// Start indexing text attachments in the background so their Source is
		// ready (or failed) by the time a prompt references them.
		if (this.options.citations && isTextMediaType(bound.attachment.mediaType)) {
			void this.options.citations.ensureSource(bound.attachment).catch((error: unknown) => {
				this.options.reportError(error);
			});
		}
		return bound.attachment;
	}

	/** Unbind an attachment from its session and mark it removed (metadata kept for history). */
	private async removeAttachment(live: LiveSession, attachmentId: string): Promise<void> {
		const store = this.requireAttachmentStore();
		const record = store.get(attachmentId);
		if (!record || record.attachment.sessionId !== live.id) {
			throw new PiServerError("not_found", `Attachment is not attached to this session: ${attachmentId}`);
		}
		await store.markRemoved(attachmentId);
		await this.options.citations?.markSourceRemoved(attachmentId);
		this.broadcastEvent(live, { type: "attachment_removed", sessionId: live.id, attachmentId });
	}

	/**
	 * Resolve prompt attachment refs and run P2 retrieval over ready text
	 * sources. Attachments without an indexable Source stay in the P1
	 * full-injection set; ready sources contribute retrieval context. Sources
	 * still indexing or failed reject the prompt with `invalid_state` so the
	 * client is never silently served an empty context.
	 */
	private async preparePromptInputs(
		live: LiveSession,
		attachmentIds: string[] | undefined,
		query: string,
		turnId: string,
	): Promise<{ attachments: ResolvedAttachmentInput[]; retrieval: RetrievalInput | undefined }> {
		if (!attachmentIds || attachmentIds.length === 0) return { attachments: [], retrieval: undefined };
		const store = this.requireAttachmentStore();
		const citationService = this.options.citations;
		const resolved: ResolvedAttachmentInput[] = [];
		const sourceIds: string[] = [];
		for (const id of attachmentIds) {
			const record = store.get(id);
			if (!record || record.attachment.sessionId !== live.id) {
				throw new PiServerError("invalid_request", `Attachment is not attached to this session: ${id}`);
			}
			if (record.attachment.status !== "ready") {
				throw new PiServerError("invalid_state", `Attachment is not ready: ${id} (${record.attachment.status})`);
			}
			const input: ResolvedAttachmentInput = {
				id,
				name: record.attachment.name,
				mediaType: record.attachment.mediaType,
				path: store.filePath(id),
			};
			const source = citationService ? citationService.getSourceByAttachment(id) : undefined;
			if (!source || source.status === "removed") {
				// Non-text attachment (no indexable source): P1 full-injection fallback.
				resolved.push(input);
				continue;
			}
			if (source.status === "pending") {
				throw new PiServerError("invalid_state", `File is still processing: ${record.attachment.name}`, {
					attachmentId: id,
					sourceStatus: source.status,
				});
			}
			if (source.status === "failed") {
				throw new PiServerError(
					"invalid_state",
					`File failed to index: ${record.attachment.name}${source.error ? ` (${source.error.message})` : ""}`,
					{ attachmentId: id, sourceStatus: source.status },
				);
			}
			sourceIds.push(source.id);
			resolved.push(input);
		}

		if (citationService && sourceIds.length > 0) {
			const result = await citationService.retrieve({ sessionId: live.id, sourceIds, query, turnId });
			if (result.citations.length > 0) {
				const covered = new Set(result.coveredAttachmentIds);
				// Files whose excerpts were retrieved inject context only; the rest
				// fall back to P1 full injection.
				return {
					attachments: resolved.filter((input) => !covered.has(input.id)),
					retrieval: { context: result.context, reference: result.reference, citations: result.citations },
				};
			}
		}
		return { attachments: resolved, retrieval: undefined };
	}

	private requireAttachmentStore(): AttachmentStore {
		if (!this.options.attachments) {
			throw new PiServerError("invalid_request", "Attachments are not configured on this server");
		}
		return this.options.attachments;
	}

	private broadcastEvent(live: LiveSession, event: ServerEvent): void {
		const envelope: EventEnvelope = { type: "event", event };
		for (const connection of live.connections) void this.options.sendMessage(connection, envelope);
	}

	/** Broadcast a Source status change to the session that owns it. */
	private broadcastSourceChange(source: Source): void {
		const live = this.liveSessions.get(source.sessionId);
		if (!live) return;
		this.broadcastEvent(live, { type: "source_snapshot", source });
	}
}

/** Media types that P2 indexes as text Sources; anything else stays P1-injected. */
function isTextMediaType(mediaType: string): boolean {
	return (
		mediaType.startsWith("text/") ||
		mediaType === "application/json" ||
		mediaType === "application/xml" ||
		mediaType === "application/x-yaml" ||
		mediaType === "application/yaml"
	);
}

function mergeRuntimeSnapshot(current: SessionSnapshot | undefined, runtime: SessionSnapshot): SessionSnapshot {
	if (!current) return runtime;
	const transcript = [...runtime.transcript];
	for (const item of current.transcript) {
		if (transcript.some((candidate) => candidate.id === item.id)) continue;
		if (
			(item.role === "assistant" && item.status === "streaming") ||
			(item.role === "tool" && item.status === "running")
		) {
			transcript.push(item);
		}
	}
	return { ...runtime, phase: current.phase === "turn" ? "turn" : runtime.phase, transcript };
}

function applyProgress(snapshot: SessionSnapshot, progress: TranscriptProgress): SessionSnapshot {
	if (progress.type === "assistant_delta") {
		const transcript = snapshot.transcript.map((item) => {
			if (item.id !== progress.messageId || item.role !== "assistant") return item;
			const part = item.content[progress.contentIndex];
			if (progress.kind === "text" && part?.type === "text") {
				const content = [...item.content];
				content[progress.contentIndex] = { ...part, text: part.text + progress.delta };
				return { ...item, content };
			}
			if (progress.kind === "thinking" && part?.type === "thinking") {
				const content = [...item.content];
				content[progress.contentIndex] = { ...part, thinking: part.thinking + progress.delta };
				return { ...item, content };
			}
			return item;
		});
		return { ...snapshot, phase: "turn", transcript };
	}
	const item = progress.item;
	const index = snapshot.transcript.findIndex((candidate) => candidate.id === item.id);
	if (index === -1) return { ...snapshot, phase: "turn", transcript: [...snapshot.transcript, item] };
	const transcript = [...snapshot.transcript];
	transcript[index] = item;
	return { ...snapshot, phase: "turn", transcript };
}
