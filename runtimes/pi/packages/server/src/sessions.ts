import { randomUUID } from "node:crypto";
import type {
	Command,
	EventEnvelope,
	SessionSnapshot,
	SessionSummary,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type { ByteConnection, ConnectionState } from "./connection.ts";
import { PiServerError } from "./errors.ts";
import { SessionEventLog } from "./event-log.ts";
import type { CreateSessionOptions, PiSessionBackend, PiSessionRuntime, PiSessionRuntimeEvent } from "./types.ts";

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
				const session = await this.runOperation(connection, live, () =>
					live.runtime.prompt({ text: command.text }),
				);
				return { command: "prompt" as const, session };
			}
			case "steer": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.steer({ text: command.text }));
				return { command: "steer" as const, session };
			}
			case "abort": {
				const live = this.requireAttached(connection, command.sessionId);
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
		}
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
	): Promise<SessionSnapshot> {
		live.operationCount += 1;
		live.currentTurnId = randomUUID();
		live.transientSnapshot = live.runtime.snapshot();
		try {
			await operation();
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
		return {
			...snapshot,
			phase: live.runtime.getPhase(),
			attached: live.connections.size > 0,
			locked: true,
			lastSequence: live.log.lastSequence,
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
