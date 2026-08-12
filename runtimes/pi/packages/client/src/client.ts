import {
	type Command,
	type CommandResult,
	type EventEnvelope,
	encodeClientMessage,
	type LiveSpeechJob,
	ProtocolValidationError,
	type ResponseEnvelope,
	type ResultForCommand,
	type ServerEvent,
	type ServerSnapshot,
	type SessionSummary,
	type SpeechJob,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import {
	PiClientDisposedError,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	PiSessionOwnershipError,
	toError,
} from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import {
	type AcquireSessionOptions,
	type PiSessionHandle,
	SessionHandle,
	type SessionHandleCallbacks,
	type SessionLeaseMode,
} from "./session-handle.ts";
import {
	isLiveSpeechTerminal,
	isSpeechTerminal,
	LiveSpeechJobHandleImpl,
	SpeechJobHandleImpl,
} from "./speech-handle.ts";
import { ClientState } from "./state.ts";
import type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	LiveSpeechJobHandle,
	PiClientOptions,
	SpeechJobHandle,
	StartSpeechOptions,
	Unsubscribe,
} from "./types.ts";

type SessionLeaseState = "active" | "releasing" | "released" | "invalidated";

interface SessionLeaseToken {
	readonly mode: SessionLeaseMode;
}

interface PendingRequest {
	command: Command;
	resolve(result: CommandResult): void;
	reject(error: Error): void;
}

export class PiClient {
	readonly #options: PiClientOptions;
	readonly #connection: Connection;
	readonly #state: ClientState;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #sessionLeaseCounts = new Map<string, number>();
	readonly #exclusiveSessionLeases = new Map<string, SessionLeaseToken>();
	readonly #sessionLeaseGenerations = new Map<string, number>();
	readonly #sessionAttachments = new Map<string, Promise<void>>();
	readonly #sessionDetachments = new Map<string, Promise<void>>();
	readonly #sessionCleanupRequired = new Set<string>();
	readonly #sessionReconciliations = new Map<string, Promise<void>>();
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	readonly #speechHandles = new Map<string, SpeechJobHandleImpl>();
	readonly #liveSpeechHandles = new Map<string, LiveSpeechJobHandleImpl>();
	#requestSequence = 0;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: PiClientOptions) {
		this.#options = options;
		this.#state = new ClientState(options.onListenerError);
		this.#connection = new Connection({
			transportFactory: options.transportFactory,
			maxFrameLength: options.maxFrameLength,
			onHandshake: (snapshot) => this.#state.applyServerSnapshot(snapshot),
			onMessage: (message) => this.#handleMessage(message),
			onStateChange: (change) => this.#handleConnectionStateChange(change),
		});
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get connectionState(): ConnectionState {
		return this.#connection.state;
	}

	get connected(): boolean {
		return this.#connection.state === "connected";
	}

	get snapshot(): ServerSnapshot | undefined {
		return this.#state.snapshot;
	}

	static async connect(options: PiClientOptions): Promise<PiClient> {
		const client = new PiClient(options);
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.dispose();
			throw error;
		}
	}

	connect(): Promise<ServerSnapshot> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (this.#connection.state === "disconnected") this.#state.reset();
		return this.#connection.connect();
	}

	reconnect(): Promise<ServerSnapshot> {
		return this.connect();
	}

	disconnect(reason = "Client disconnected"): void {
		this.#connection.disconnect(reason);
	}

	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		this.#assertNotDisposed();
		return this.#state.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		this.#assertNotDisposed();
		return this.#state.onEvent(listener);
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#assertNotDisposed();
		this.#connectionStateListeners.add(listener);
		return () => this.#connectionStateListeners.delete(listener);
	}

	async listSessions(): Promise<readonly SessionSummary[]> {
		return (await this.#request({ command: "list" })).sessions;
	}

	/**
	 * Starts speech generation for a completed assistant message. The returned
	 * handle receives `speech_job` events for this connection only; the audio
	 * bytes travel over a separate HTTP stream (see {@link openSpeechStream}).
	 */
	async startSpeech(options: StartSpeechOptions): Promise<SpeechJobHandle> {
		this.#assertNotDisposed();
		const result = await this.#request({
			command: "start_speech",
			sessionId: options.sessionId,
			messageId: options.messageId,
			...(options.voiceProfileId !== undefined ? { voiceProfileId: options.voiceProfileId } : {}),
		});
		const handle = new SpeechJobHandleImpl(result.job, {
			cancel: (command) => this.#request(command),
			onListenerError: this.#options.onListenerError,
		});
		this.#speechHandles.set(result.job.id, handle);
		return handle;
	}

	/**
	 * Cancel a Phase 2 live朗读 job. The V5 contract freezes the command; the
	 * V8 server coordinator is the only legitimate emitter. Callers that never
	 * receive a `LiveSpeechJob` should have nothing to cancel.
	 */
	async cancelLiveSpeech(jobId: string): Promise<void> {
		this.#assertNotDisposed();
		await this.#request({ command: "cancel_live_speech", jobId });
	}

	/**
	 * Register a live朗读 job handle. The V5 contract freezes the type but does
	 * not yet ship a creator — V8 will be the first server-issued source. This
	 * helper exists so that future creators (V8 / V9 / test fixtures) can wire
	 * the handle into the connection-scoped event router without changing the
	 * client API.
	 */
	registerLiveSpeechHandle(job: LiveSpeechJob): LiveSpeechJobHandle {
		this.#assertNotDisposed();
		const handle = new LiveSpeechJobHandleImpl(job, {
			cancel: (command) => this.#request(command),
			onListenerError: this.#options.onListenerError,
		});
		this.#liveSpeechHandles.set(job.id, handle);
		return handle;
	}

	/**
	 * Look up a previously-registered live job handle by id. Returns `undefined`
	 * when the job is unknown, already terminal (terminal handles are evicted
	 * from the map) or this connection never observed it. V9 web callers use
	 * this to subscribe to a job issued by a `prompt` result before they ever
	 * touch the handle object returned via the protocol layer.
	 */
	getLiveSpeechHandle(jobId: string): LiveSpeechJobHandle | undefined {
		return this.#liveSpeechHandles.get(jobId);
	}

	async createSession(options: CreateSessionOptions = {}): Promise<PiSessionHandle> {
		const result = await this.#request({ command: "create", ...options });
		const token = this.#reserveSessionLease(result.session.id, "exclusive");
		return this.#createSessionLease(result.session.id, token);
	}

	async attachSession(sessionId: string): Promise<PiSessionHandle> {
		return this.acquireSession(sessionId, { mode: "shared" });
	}

	async acquireSession(sessionId: string, options: AcquireSessionOptions): Promise<PiSessionHandle> {
		this.#assertNotDisposed();
		const token = this.#reserveSessionLease(sessionId, options.mode);
		try {
			const detachment = this.#sessionDetachments.get(sessionId);
			if (detachment) await detachment.catch(() => {});
			const reconciled = this.#sessionCleanupRequired.has(sessionId)
				? await this.#reconcileSessionCleanup(sessionId)
				: false;
			if (reconciled || !this.#state.isSessionAttached(sessionId)) {
				let attachment = this.#sessionAttachments.get(sessionId);
				if (!attachment) {
					attachment = this.#attachSession(sessionId);
					this.#sessionAttachments.set(sessionId, attachment);
				}
				try {
					await attachment;
				} finally {
					if (this.#sessionAttachments.get(sessionId) === attachment) this.#sessionAttachments.delete(sessionId);
				}
			}
			return this.#createSessionLease(sessionId, token);
		} catch (error) {
			this.#releaseSessionLease(sessionId, token);
			throw error;
		}
	}

	async #attachSession(sessionId: string): Promise<void> {
		const previous = this.#state.forgetSessionSnapshot(sessionId);
		try {
			const afterSequence = this.#state.getLastSequence(sessionId);
			const command =
				afterSequence > 0
					? ({ command: "resume" as const, sessionId, afterSequence } satisfies Command)
					: ({ command: "attach" as const, sessionId } satisfies Command);
			await this.#request(command);
		} catch (error) {
			if (previous) this.#state.restoreSessionSnapshot(previous);
			throw error;
		}
	}

	#request<const TCommand extends Command>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (!this.connected) return Promise.reject(new PiDisconnectedError());
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<CommandResult>();
		this.#pendingRequests.set(id, { command, resolve, reject });
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, request: command },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise as Promise<ResultForCommand<TCommand>>;
		}
		this.#connection.send(frame);
		return promise as Promise<ResultForCommand<TCommand>>;
	}

	#createSessionLease(sessionId: string, token: SessionLeaseToken): PiSessionHandle {
		const generation = this.#sessionLeaseGenerations.get(sessionId) ?? 0;
		this.#sessionLeaseGenerations.set(sessionId, generation);
		let state: SessionLeaseState = "active";
		let releasePromise: Promise<void> | undefined;
		const refreshState = () => {
			if (
				(state === "active" || state === "releasing") &&
				this.#sessionLeaseGenerations.get(sessionId) !== generation
			) {
				state = "invalidated";
			}
		};
		const isActive = () => {
			refreshState();
			return state === "active" && this.#state.isSessionAttached(sessionId);
		};
		const assertActive = () => {
			this.#assertNotDisposed();
			if (!this.connected) throw new PiDisconnectedError();
			if (!isActive()) throw new PiSessionDetachedError(sessionId);
		};
		const release = (relinquishOnFailure: boolean): Promise<void> => {
			refreshState();
			if (state === "released" || state === "invalidated") return Promise.resolve();
			if (releasePromise) return releasePromise;
			assertActive();
			state = "releasing";
			releasePromise = (async () => {
				const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
				if (count <= 1) {
					const detachment = this.#request({ command: "detach", sessionId }).then(() => undefined);
					this.#sessionDetachments.set(sessionId, detachment);
					try {
						await detachment;
						this.#releaseSessionLease(sessionId, token);
					} finally {
						if (this.#sessionDetachments.get(sessionId) === detachment) {
							this.#sessionDetachments.delete(sessionId);
						}
					}
				} else {
					this.#releaseSessionLease(sessionId, token);
				}
				state = "released";
			})().catch((error: unknown) => {
				refreshState();
				if (state === "invalidated") return;
				if (relinquishOnFailure) {
					this.#releaseSessionLease(sessionId, token);
					this.#sessionCleanupRequired.add(sessionId);
					state = "released";
				} else {
					state = "active";
					releasePromise = undefined;
				}
				throw error;
			});
			return releasePromise;
		};
		const callbacks: SessionHandleCallbacks = {
			isAttached: isActive,
			getSnapshot: () => (isActive() ? this.#state.getSessionSnapshot(sessionId) : undefined),
			subscribe: (listener) => {
				assertActive();
				return this.#state.subscribeSession(sessionId, (snapshot) => {
					if (isActive()) listener(snapshot);
				});
			},
			onEvent: (listener) => {
				assertActive();
				return this.#state.onSessionEvent(sessionId, (event) => {
					if (isActive() || event.type === "session_removed") listener(event);
				});
			},
			detach: () => release(false),
			dispose: () => release(true),
			request: (command) => {
				assertActive();
				return this.#request(command);
			},
		};
		return new SessionHandle(sessionId, callbacks);
	}

	#handleMessage(message: ResponseEnvelope | EventEnvelope): void {
		if (message.type === "event") {
			if (message.event.type === "speech_job") {
				// Job events are connection-scoped and never touch session state.
				this.#dispatchSpeechJob(message.event.job);
				return;
			}
			if (message.event.type === "live_speech_job") {
				// Phase 2: live朗读 events are also connection-scoped; the V5
				// freeze never emits them but the route is wired so V8/V9 don't
				// need to touch client dispatch.
				this.#dispatchLiveSpeechJob(message.event.job);
				return;
			}
			if (message.event.type === "session_removed") this.#invalidateSessionLeases(message.event.sessionId);
			this.#state.applyEvent(message.event);
			return;
		}
		const pending = this.#takePendingRequest(message.id);
		if (!pending) {
			this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new PiServerError(message.error));
			return;
		}
		if (message.result.command !== pending.command.command) {
			const error = new ProtocolValidationError(
				`Response command ${message.result.command} does not match ${pending.command.command}`,
			);
			pending.reject(error);
			this.#connection.fail(error);
			return;
		}
		this.#state.applyResult(message.result);
		// Phase 2: a successful prompt that opted into live speech carries a
		// fresh LiveSpeechJob in the result. Auto-register a handle so the
		// V9 web layer can subscribe immediately and so subsequent
		// `live_speech_job` events route correctly.
		if (message.result.command === "prompt" && message.result.liveSpeech) {
			this.registerLiveSpeechHandle(message.result.liveSpeech);
		}
		pending.resolve(message.result);
	}

	#handleConnectionStateChange(change: ConnectionStateChange): void {
		if (change.state === "disconnected") {
			this.#speechHandles.clear();
			this.#liveSpeechHandles.clear();
			this.#state.clearAttachments();
			this.#invalidateAllSessionLeases();
			this.#rejectPendingRequests(change.error ?? new PiDisconnectedError());
		}
		this.#notifyConnectionStateListeners(change);
	}

	#takePendingRequest(id: string): PendingRequest | undefined {
		const request = this.#pendingRequests.get(id);
		if (request) this.#pendingRequests.delete(id);
		return request;
	}

	#dispatchSpeechJob(job: SpeechJob): void {
		const handle = this.#speechHandles.get(job.id);
		if (!handle) return;
		handle.apply(job);
		if (isSpeechTerminal(job.status)) this.#speechHandles.delete(job.id);
	}

	#dispatchLiveSpeechJob(job: import("@earendil-works/pi-protocol").LiveSpeechJob): void {
		const handle = this.#liveSpeechHandles.get(job.id);
		if (!handle) return;
		handle.apply(job);
		if (isLiveSpeechTerminal(job.status)) this.#liveSpeechHandles.delete(job.id);
	}

	#rejectPendingRequests(error: Error): void {
		const requests = [...this.#pendingRequests.values()];
		this.#pendingRequests.clear();
		for (const request of requests) request.reject(error);
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = Promise.resolve();
		const error = new PiClientDisposedError();
		this.#rejectPendingRequests(error);
		this.#speechHandles.clear();
		this.#liveSpeechHandles.clear();
		this.#connection.disconnect(error);
		this.#state.dispose();
		this.#invalidateAllSessionLeases();
		this.#connectionStateListeners.clear();
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#assertNotDisposed(): void {
		if (this.#disposed) throw new PiClientDisposedError();
	}

	async #reconcileSessionCleanup(sessionId: string): Promise<boolean> {
		if (!this.#sessionCleanupRequired.has(sessionId)) return false;
		let reconciliation = this.#sessionReconciliations.get(sessionId);
		if (!reconciliation) {
			reconciliation = this.#request({ command: "detach", sessionId })
				.then(() => undefined)
				.then(() => {
					this.#sessionCleanupRequired.delete(sessionId);
				})
				.finally(() => {
					this.#sessionReconciliations.delete(sessionId);
				});
			this.#sessionReconciliations.set(sessionId, reconciliation);
		}
		await reconciliation;
		return true;
	}

	#reserveSessionLease(sessionId: string, mode: SessionLeaseMode): SessionLeaseToken {
		const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
		if (mode === "exclusive" && count > 0) {
			throw new PiSessionOwnershipError(sessionId, `Session ${sessionId} already has an active lease`);
		}
		if (mode === "shared" && this.#exclusiveSessionLeases.has(sessionId)) {
			throw new PiSessionOwnershipError(sessionId, `Session ${sessionId} has an exclusive lease`);
		}
		const token: SessionLeaseToken = { mode };
		this.#sessionLeaseCounts.set(sessionId, count + 1);
		if (mode === "exclusive") this.#exclusiveSessionLeases.set(sessionId, token);
		return token;
	}

	#releaseSessionLease(sessionId: string, token: SessionLeaseToken): void {
		const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
		if (count <= 1) this.#sessionLeaseCounts.delete(sessionId);
		else this.#sessionLeaseCounts.set(sessionId, count - 1);
		if (this.#exclusiveSessionLeases.get(sessionId) === token) this.#exclusiveSessionLeases.delete(sessionId);
	}

	#invalidateSessionLeases(sessionId: string): void {
		this.#sessionLeaseCounts.delete(sessionId);
		this.#exclusiveSessionLeases.delete(sessionId);
		this.#sessionCleanupRequired.delete(sessionId);
		this.#sessionLeaseGenerations.set(sessionId, (this.#sessionLeaseGenerations.get(sessionId) ?? 0) + 1);
	}

	#invalidateAllSessionLeases(): void {
		for (const sessionId of this.#sessionLeaseCounts.keys()) this.#invalidateSessionLeases(sessionId);
		this.#sessionCleanupRequired.clear();
	}

	#notifyConnectionStateListeners(change: ConnectionStateChange): void {
		for (const listener of this.#connectionStateListeners) {
			try {
				listener(change);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#reportListenerError(error: unknown): void {
		if (!this.#options.onListenerError) return;
		try {
			this.#options.onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect protocol or transport state.
		}
	}
}
