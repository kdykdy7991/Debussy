/**
 * V8 live speech coordinator: turns incremental assistant text into an ordered,
 * single PCM response.
 *
 * The manager (server-wide, one instance per web server) owns the registry of
 * per-job `LiveSpeechRun` coordinators and the prompt transaction / claim /
 * cancel / lifecycle boundary. Each run owns the V6 projector + segmenter and
 * the V7 utterance queue, subscribes to the session runtime **before**
 * `runtime.prompt()` runs, binds the first assistant item, filters text
 * deltas, and streams every utterance's PCM into a deferred browser sink.
 *
 * Contract (V8 task §4 + Phase 2 Spec §12):
 *
 * - Atomic prompt transaction: `prepare` is synchronous — it validates,
 *   creates the job+run and registers the progress listener in one block, so
 *   no first delta is lost and two racing prompts cannot both pass the busy
 *   check. Prompt failure rolls the job back with no client-visible event.
 * - Binding/filter: only the first assistant `item_started` (timestamp >= job
 *   creation) is bound; only `assistant_delta(kind="text")` for that messageId
 *   is projected. thinking/toolCall/other turns never reach the queue.
 * - The queue streams one Voice Service request per utterance; the sink
 *   forwards all utterances into one HTTP response, applying backpressure.
 * - Cancel paths (owner cancel, Agent abort/steer, disconnect/detach/session
 *   removal/shutdown, downstream close) converge on the same idempotent
 *   cleanup; `cancel_live_speech` never calls `runtime.abort()`.
 * - Job events go only to the owning connection and are throttled to ≤4 Hz
 *   except milestones and terminal states.
 */

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type {
	CancelLiveSpeechCommand,
	CancelLiveSpeechResult,
	LiveSpeechErrorCode,
	LiveSpeechJob,
	LiveSpeechProgress,
	LiveSpeechRequest,
	LiveSpeechStatus,
} from "@earendil-works/pi-protocol";
import type { ConnectionState } from "../../connection.ts";
import { PiServerError } from "../../errors.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent } from "../../types.ts";
import { resolveProfile } from "../profiles.ts";
import type { StreamSynthesisRequest, VoiceAudioFormat, VoiceProfile, VoiceServiceClient } from "../types.ts";
import { PendingPcmSink } from "./pending-pcm-sink.ts";
import { createSpeakableTextProjector, type IncrementalSpeakableTextProjector } from "./text-projector.ts";
import { type CommittedUtterance, createTextSegmenter, type IncrementalTextSegmenter } from "./text-segmenter.ts";
import {
	createUtteranceQueue,
	type QueueCancelReason,
	type QueueEvent,
	type QueueResult,
	type UtteranceQueue,
} from "./utterance-queue.ts";

/** Browser-facing PCM route prefix for live jobs; the HTTP handler must agree. */
export const LIVE_SPEECH_STREAM_PATH_PREFIX = "/api/pi/v4/live-speech";

const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_FIRST_TEXT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60_000;
const DEFAULT_JOB_EVENT_INTERVAL_MS = 250;
const DEFAULT_IDLE_FLUSH_MS = 1_000;

/** Profile-resolved synthesis parameters forwarded to the Voice Service. */
export function buildSynthesis(profile: VoiceProfile, text: string): StreamSynthesisRequest {
	return {
		text,
		language: profile.language,
		speaker: profile.speaker,
		...(profile.instruct ? { instruct: profile.instruct } : {}),
	};
}

export interface LiveSpeechManagerOptions {
	voiceClient: VoiceServiceClient;
	profiles: readonly VoiceProfile[];
	defaultProfileId: string;
	/** Max wall-clock wait for the browser to claim the stream. Default 30s. */
	claimTtlMs?: number;
	/** Max wait for the first speakable text after the prompt starts. Default 60s. */
	firstTextTimeoutMs?: number;
	/** Max wall-clock duration of a live job. Default 10m. */
	maxDurationMs?: number;
	/** How long terminal jobs stay queryable before being dropped. Default 5m. */
	retentionMs?: number;
	/** Coalescing window for non-milestone job events. Default 250ms (4Hz). */
	jobEventIntervalMs?: number;
	/** Segmenter idle-flush cadence driving mid-sentence commits. Default 1s. */
	idleFlushMs?: number;
	/** When set, reject live creation while a Phase 1 manual speech job is active. */
	speechBusyCheck?: (connection: ConnectionState) => boolean;
	clock?: () => number;
	uuid?: () => string;
}

export interface LiveSpeechManagerHost {
	/** Deliver a `live_speech_job` event to the owning connection; safe when disconnected. */
	sendJobEvent(connection: ConnectionState, job: LiveSpeechJob): void;
	reportError(error: unknown): void;
}

export interface LiveSpeechPrepareOptions {
	connection: ConnectionState;
	runtime: PiSessionRuntime;
	sessionId: string;
	speech: LiveSpeechRequest;
	/** The prompt operation's turn id; stored on the job once bound. */
	turnId: string;
}

export type LiveSpeechPrepareResult = {
	job: LiveSpeechJob;
	/** Publish once the Agent prompt has been successfully started. */
	announce(): void;
	/** Prompt-failure cleanup; cancels the run and drops it with no event. */
	rollback: () => void;
};

export interface LiveSpeechClaim {
	job: LiveSpeechJob;
	run: LiveSpeechRun;
	signal: AbortSignal;
}

export type LiveSpeechClaimResult =
	| { status: "ok"; claim: LiveSpeechClaim }
	| { status: "not_found" }
	| { status: "claimed" }
	| { status: "expired" };

type ResolvedLiveSpeechOptions = {
	voiceClient: VoiceServiceClient;
	profiles: readonly VoiceProfile[];
	defaultProfileId: string;
	claimTtlMs: number;
	firstTextTimeoutMs: number;
	maxDurationMs: number;
	retentionMs: number;
	jobEventIntervalMs: number;
	idleFlushMs: number;
	speechBusyCheck: ((connection: ConnectionState) => boolean) | undefined;
	clock: () => number;
	uuid: () => string;
};

/**
 * Server-wide registry of live speech jobs. Created by the web layer alongside
 * the Phase 1 SpeechManager; injected into PiServer and LiveSessionManager.
 */
export class LiveSpeechManager {
	/** @internal Shared with `LiveSpeechRun` in this module. */
	readonly options: ResolvedLiveSpeechOptions;
	private readonly jobs = new Map<string, LiveSpeechRun>();
	/** @internal Shared with `LiveSpeechRun` in this module. */
	host: LiveSpeechManagerHost | undefined;

	constructor(options: LiveSpeechManagerOptions) {
		this.options = {
			voiceClient: options.voiceClient,
			profiles: options.profiles,
			defaultProfileId: options.defaultProfileId,
			claimTtlMs: options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
			firstTextTimeoutMs: options.firstTextTimeoutMs ?? DEFAULT_FIRST_TEXT_TIMEOUT_MS,
			maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
			retentionMs: options.retentionMs ?? DEFAULT_TERMINAL_RETENTION_MS,
			jobEventIntervalMs: options.jobEventIntervalMs ?? DEFAULT_JOB_EVENT_INTERVAL_MS,
			idleFlushMs: options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS,
			speechBusyCheck: options.speechBusyCheck,
			clock: options.clock ?? (() => Date.now()),
			uuid: options.uuid ?? (() => randomUUID()),
		};
	}

	/** PiServer injects the event sink after construction. */
	bind(host: LiveSpeechManagerHost): void {
		this.host = host;
	}

	/**
	 * Atomic prompt transaction. Synchronous: validates capacity/profile, creates
	 * the job + run, and registers the runtime progress listener before returning
	 * — so the caller can start `runtime.prompt()` immediately after without any
	 * interleaving window.
	 */
	prepare(input: LiveSpeechPrepareOptions): LiveSpeechPrepareResult {
		for (const run of this.jobs.values()) {
			if (run.terminal) continue;
			if (run.owner === input.connection) {
				throw new PiServerError("busy", "This connection already has an active live speech job");
			}
			if (run.sessionId === input.sessionId) {
				throw new PiServerError("busy", `Session ${input.sessionId} already has an active live speech job`);
			}
		}
		if (this.options.speechBusyCheck?.(input.connection)) {
			throw new PiServerError("busy", "A Phase 1 manual speech job is active on this connection");
		}
		const profile = resolveProfile(this.options.profiles, input.speech.voiceProfileId, this.options.defaultProfileId);
		const now = this.options.clock();
		const id = this.options.uuid();
		const job: LiveSpeechJob = {
			id,
			sessionId: input.sessionId,
			voiceProfileId: profile.id,
			status: "waiting_for_text",
			streamPath: `${LIVE_SPEECH_STREAM_PATH_PREFIX}/${id}/stream`,
			createdAt: now,
			updatedAt: now,
			progress: { committedUtterances: 0, completedUtterances: 0, pendingCharacters: 0 },
		};
		const run = new LiveSpeechRun({
			manager: this,
			id,
			owner: input.connection,
			sessionId: input.sessionId,
			turnId: input.turnId,
			job,
			profile,
			runtime: input.runtime,
			voiceClient: this.options.voiceClient,
			clock: this.options.clock,
			idleFlushMs: this.options.idleFlushMs,
		});
		this.jobs.set(id, run);
		run.start();
		let announced = false;
		return {
			job,
			announce: () => {
				if (announced) return;
				announced = true;
				this.host?.sendJobEvent(input.connection, job);
			},
			rollback: () => run.rollback(),
		};
	}

	/** `cancel_live_speech`: owner-only, never aborts the Agent. */
	async executeCancel(connection: ConnectionState, command: CancelLiveSpeechCommand): Promise<CancelLiveSpeechResult> {
		const run = this.jobs.get(command.jobId);
		if (!run || run.owner !== connection) {
			// Do not reveal whether another connection owns the job.
			throw new PiServerError("not_found", `Unknown live speech job: ${command.jobId}`);
		}
		if (!run.terminal) run.cancel("user_cancel", "speech_cancelled", "Live speech cancelled by user");
		return { command: "cancel_live_speech", job: run.job };
	}

	/** Atomically claim the stream; the first GET wins. */
	claimStream(jobId: string): LiveSpeechClaimResult {
		const run = this.jobs.get(jobId);
		if (!run) return { status: "not_found" };
		if (run.claimed) return { status: "claimed" };
		if (run.terminal && !(run.job.status === "completed" && run.bytesWritten === 0)) {
			return { status: "expired" };
		}
		run.claimed = true;
		if (run.unclaimedTimer) {
			clearTimeout(run.unclaimedTimer);
			run.unclaimedTimer = undefined;
		}
		if (run.job.status === "waiting_for_text" && run.committedUtterances > 0) {
			run.setStatus("generating");
		}
		return { status: "ok", claim: { job: run.job, run, signal: run.controller.signal } };
	}

	/** Browser closed the response before a clean end. */
	abortFromDownstream(jobId: string): void {
		const run = this.jobs.get(jobId);
		if (run && !run.terminal) run.cancel("downstream_close", "speech_cancelled", "Browser closed the stream");
	}

	/** Cancel every live job owned by a connection (disconnect). */
	abortConnectionJobs(connection: ConnectionState): void {
		for (const run of [...this.jobs.values()]) {
			if (run.owner === connection && !run.terminal) {
				run.cancel("owner_disconnect", "speech_cancelled", "Owner connection disconnected");
			}
		}
	}

	/** Cancel live jobs for one connection+session (detach). */
	abortConnectionSessionJobs(connection: ConnectionState, sessionId: string): void {
		for (const run of [...this.jobs.values()]) {
			if (run.owner === connection && run.sessionId === sessionId && !run.terminal) {
				run.cancel("session_removed", "speech_cancelled", "Connection detached from the session");
			}
		}
	}

	/** Cancel live jobs for a session (Agent abort/steer, dispose, terminate). */
	abortSessionJobs(sessionId: string, reason: QueueCancelReason, message: string): void {
		for (const run of [...this.jobs.values()]) {
			if (run.sessionId === sessionId && !run.terminal) {
				run.cancel(reason, "speech_cancelled", message);
			}
		}
	}

	/** Cancel all live jobs on server shutdown. */
	close(): void {
		for (const run of [...this.jobs.values()]) {
			if (run.retentionTimer) clearTimeout(run.retentionTimer);
			if (!run.terminal) run.cancel("shutdown", "speech_cancelled", "Server shutting down");
		}
	}

	/** Phase 1 SpeechManager mutual-exclusion check. */
	hasActiveLiveJob(connection: ConnectionState): boolean {
		for (const run of this.jobs.values()) {
			if (!run.terminal && run.owner === connection) return true;
		}
		return false;
	}

	// ---- Internal boundary shared with LiveSpeechRun --------------------

	/** Drop a terminal job after its retention window. */
	drop(jobId: string): void {
		const run = this.jobs.get(jobId);
		if (!run) return;
		if (run.retentionTimer) clearTimeout(run.retentionTimer);
		this.jobs.delete(jobId);
	}

	/** Arm the terminal-retention timer that eventually `drop`s the run. */
	armRetention(run: LiveSpeechRun): void {
		run.retentionTimer = setTimeout(() => this.drop(run.id), this.options.retentionMs);
		run.retentionTimer.unref?.();
	}

	expireUnclaimed(jobId: string): void {
		const run = this.jobs.get(jobId);
		if (run && !run.claimed && !run.terminal) {
			run.fail("live_speech_expired", "Live speech stream was not claimed in time");
		}
	}

	enforceFirstTextTimeout(jobId: string): void {
		const run = this.jobs.get(jobId);
		if (run && !run.terminal) {
			run.fail("turn_not_started", "No speakable text was produced in time");
		}
	}

	enforceMaxDuration(jobId: string): void {
		const run = this.jobs.get(jobId);
		if (run && !run.terminal) {
			run.fail("live_speech_expired", "Live speech job exceeded the maximum duration");
		}
	}
}

interface LiveSpeechRunOptions {
	manager: LiveSpeechManager;
	id: string;
	owner: ConnectionState;
	sessionId: string;
	turnId: string;
	job: LiveSpeechJob;
	profile: VoiceProfile;
	runtime: PiSessionRuntime;
	voiceClient: VoiceServiceClient;
	clock: () => number;
	idleFlushMs: number;
}

/**
 * One live job: owns the V6→V7 pipeline, the runtime progress subscription,
 * binding/filtering, job-state publishing and the terminal lifecycle.
 */
export class LiveSpeechRun {
	readonly id: string;
	readonly owner: ConnectionState;
	readonly sessionId: string;
	readonly turnId: string;
	readonly profile: VoiceProfile;
	readonly controller = new AbortController();

	job: LiveSpeechJob;
	claimed = false;
	terminal = false;
	bytesWritten = 0;
	committedUtterances = 0;
	completedUtterances = 0;

	private readonly manager: LiveSpeechManager;
	private readonly runtime: PiSessionRuntime;
	private readonly voiceClient: VoiceServiceClient;
	private readonly clock: () => number;
	private readonly idleFlushMs: number;
	private readonly projector: IncrementalSpeakableTextProjector;
	private readonly segmenter: IncrementalTextSegmenter;
	private readonly queue: UtteranceQueue;
	private readonly sink: PendingPcmSink;
	private readonly charsBySequence = new Map<number, number>();

	unclaimedTimer: NodeJS.Timeout | undefined;
	firstTextTimer: NodeJS.Timeout | undefined;
	maxDurationTimer: NodeJS.Timeout | undefined;
	retentionTimer: NodeJS.Timeout | undefined;
	private publishTimer: NodeJS.Timeout | undefined;
	private idleTickTimer: NodeJS.Timeout | undefined;
	private lastPublishAt = 0;
	private unsubscribe: (() => void) | undefined;

	private boundMessageId: string | undefined;
	private lockedFormat: VoiceAudioFormat | undefined;
	private turnFinished = false;

	constructor(options: LiveSpeechRunOptions) {
		this.manager = options.manager;
		this.id = options.id;
		this.owner = options.owner;
		this.sessionId = options.sessionId;
		this.turnId = options.turnId;
		this.job = options.job;
		this.profile = options.profile;
		this.runtime = options.runtime;
		this.voiceClient = options.voiceClient;
		this.clock = options.clock;
		this.idleFlushMs = options.idleFlushMs;
		this.projector = createSpeakableTextProjector();
		this.segmenter = createTextSegmenter();
		this.sink = new PendingPcmSink({
			signal: this.controller.signal,
			jobId: this.id,
			onFirstByte: () => this.noteStreaming(),
			onBytes: (bytes) => {
				this.bytesWritten += bytes;
			},
			onDownstreamClosed: () => this.manager.abortFromDownstream(this.id),
		});
		this.queue = createUtteranceQueue({
			profileId: this.profile.id,
			synthesize: async ({ text, signal }) => {
				const result = await this.voiceClient.openStream(buildSynthesis(this.profile, text), signal);
				return { format: result.format, body: result.body };
			},
			sink: this.sink,
			signal: this.controller.signal,
			onEvent: (event) => this.handleQueueEvent(event),
			now: this.clock,
		});
	}

	/** Register the runtime listener (before prompt) and arm the timers. */
	start(): void {
		this.unsubscribe = this.runtime.subscribe((event) => this.handleRuntimeEvent(event));
		const manager = this.manager.options;
		this.unclaimedTimer = setTimeout(() => this.manager.expireUnclaimed(this.id), manager.claimTtlMs);
		this.unclaimedTimer.unref?.();
		this.firstTextTimer = setTimeout(() => this.manager.enforceFirstTextTimeout(this.id), manager.firstTextTimeoutMs);
		this.firstTextTimer.unref?.();
		this.maxDurationTimer = setTimeout(() => this.manager.enforceMaxDuration(this.id), manager.maxDurationMs);
		this.maxDurationTimer.unref?.();
		this.idleTickTimer = setInterval(() => this.onIdleTick(), this.idleFlushMs);
		this.idleTickTimer.unref?.();
		void this.queue.completion.then((result) => this.onQueueCompletion(result));
	}

	/** The HTTP handler attaches the claimed browser response. */
	attachResponse(response: ServerResponse): void {
		this.sink.attach(response);
	}

	/** Prompt-failure cleanup: no event, no retention, dropped immediately. */
	rollback(): void {
		if (this.terminal) return;
		this.terminal = true;
		this.clearTimers();
		this.unsubscribeListener();
		void this.queue.cancel("agent_abort").catch(() => undefined);
		this.manager.drop(this.id);
	}

	/** Immediate, idempotent cancel (owner/agent/downstream/lifecycle). */
	cancel(reason: QueueCancelReason, code: LiveSpeechErrorCode, message: string): void {
		if (this.terminal) return;
		this.terminal = true;
		this.clearTimers();
		this.unsubscribeListener();
		this.setJob({ status: "cancelled", error: { code, message } }, true);
		void this.queue.cancel(reason).catch(() => undefined);
		this.manager.armRetention(this);
	}

	/** Immediate, idempotent failure (timeouts, queue self-fail). */
	fail(code: LiveSpeechErrorCode, message: string): void {
		if (this.terminal) return;
		this.terminal = true;
		this.clearTimers();
		this.unsubscribeListener();
		this.setJob({ status: "failed", error: { code, message } }, true);
		void this.queue.cancel("user_cancel").catch(() => undefined);
		this.manager.armRetention(this);
	}

	/** Set a job status transition; forced publish. */
	setStatus(status: LiveSpeechStatus): void {
		if (this.job.status === status) return;
		this.setJob({ status }, true);
	}

	// ---- Runtime progress: binding + filter -----------------------------

	private handleRuntimeEvent(event: PiSessionRuntimeEvent): void {
		if (this.terminal || event.type !== "progress") return;
		const progress = event.progress;
		switch (progress.type) {
			case "item_started": {
				if (progress.item.role !== "assistant") return;
				if (this.boundMessageId !== undefined) return;
				if (progress.item.timestamp < this.job.createdAt) return; // late cross-turn item
				this.boundMessageId = progress.item.id;
				this.setJob({ turnId: this.turnId, messageId: this.boundMessageId }, true);
				break;
			}
			case "assistant_delta": {
				if (this.boundMessageId === undefined || progress.messageId !== this.boundMessageId) return;
				if (progress.kind !== "text") return; // thinking/toolCall never spoken
				this.clearFirstTextTimer();
				this.projectAndPush(progress.delta);
				break;
			}
			case "item_finished": {
				if (progress.item.role !== "assistant") return;
				if (this.boundMessageId === undefined || progress.item.id !== this.boundMessageId) return;
				this.clearFirstTextTimer();
				if (progress.item.status === "complete") this.finishTurnNormal();
				else this.cancel("agent_abort", "speech_cancelled", "Agent aborted or errored the turn");
				break;
			}
			case "item_updated":
				break;
		}
	}

	private projectAndPush(delta: string): void {
		const projected = this.projector.project(delta);
		if (!projected) return;
		for (const utterance of this.segmenter.push(projected, this.clock())) {
			this.safeEnqueue(utterance);
		}
	}

	private onIdleTick(): void {
		if (this.terminal || this.turnFinished) return;
		for (const utterance of this.segmenter.tick(this.clock())) {
			this.safeEnqueue(utterance);
		}
	}

	private finishTurnNormal(): void {
		if (this.turnFinished) return;
		this.turnFinished = true;
		this.projector.flush();
		for (const utterance of this.segmenter.flush(this.clock())) {
			this.safeEnqueue(utterance);
		}
		void this.queue.closeInput();
	}

	private safeEnqueue(utterance: CommittedUtterance): void {
		if (this.terminal) return;
		try {
			this.queue.enqueue(utterance);
		} catch {
			// The queue is settled/closed; stop feeding it.
		}
	}

	// ---- Queue events → job state ---------------------------------------

	private handleQueueEvent(event: QueueEvent): void {
		switch (event.type) {
			case "enqueued":
				this.committedUtterances += 1;
				this.charsBySequence.set(event.sequence, event.characters);
				if (this.job.status === "waiting_for_text") this.setStatus("generating");
				else this.publish(false);
				break;
			case "started":
				this.setStatus("generating");
				break;
			case "format_locked":
				this.lockedFormat = event.format;
				this.sink.setFormat(event.format);
				break;
			case "completed":
				this.completedUtterances += 1;
				this.charsBySequence.delete(event.sequence);
				this.publish(false);
				break;
			case "discarded":
				this.charsBySequence.delete(event.sequence);
				this.publish(false);
				break;
			case "backlog_exceeded":
				// The queue settles as `failed`; onQueueCompletion is authoritative.
				break;
			case "cancelled":
			case "failed":
				break;
		}
	}

	/** The queue's completion is the single terminal authority for natural paths. */
	private onQueueCompletion(result: QueueResult): void {
		if (this.terminal) return;
		if (result.status === "completed") {
			if (this.bytesWritten % 4 !== 0) {
				this.fail("speech_generation_failed", "Audio stream length is not a multiple of 4 bytes");
			} else {
				this.terminal = true;
				this.clearTimers();
				this.unsubscribeListener();
				this.setJob({ status: "completed" }, true);
				this.manager.armRetention(this);
			}
		} else if (result.status === "failed") {
			this.fail(result.error.code, result.error.message);
		}
		// `cancelled` results are already handled by `cancel()`.
	}

	private noteStreaming(): void {
		if (this.job.status === "streaming") return;
		const patch: Partial<LiveSpeechJob> = {
			status: "streaming",
			firstChunkAt: this.clock(),
			...(this.lockedFormat ? { audio: this.lockedFormat } : {}),
		};
		this.setJob(patch, true);
	}

	// ---- Job publishing (≤4 Hz) -----------------------------------------

	private setJob(patch: Partial<LiveSpeechJob>, force: boolean): void {
		// Mutate the shared job object in place so the job reference handed back
		// from `prepare` (the PromptResult.liveSpeech) always reflects the
		// current state rather than a stale snapshot.
		Object.assign(this.job, patch, { progress: this.progress(), updatedAt: this.clock() });
		this.publish(force);
	}

	private progress(): LiveSpeechProgress {
		let pendingCharacters = 0;
		for (const characters of this.charsBySequence.values()) pendingCharacters += characters;
		return {
			committedUtterances: this.committedUtterances,
			completedUtterances: this.completedUtterances,
			pendingCharacters,
		};
	}

	private publish(force: boolean): void {
		const host = this.manager.host;
		if (!host) return;
		if (force) {
			if (this.publishTimer) {
				clearTimeout(this.publishTimer);
				this.publishTimer = undefined;
			}
			this.lastPublishAt = this.clock();
			host.sendJobEvent(this.owner, this.job);
			return;
		}
		if (this.publishTimer) return; // coalesced; a later snapshot is emitted
		const interval = this.manager.options.jobEventIntervalMs;
		const delay = Math.max(1, interval - (this.clock() - this.lastPublishAt));
		this.publishTimer = setTimeout(() => {
			this.publishTimer = undefined;
			this.lastPublishAt = this.clock();
			host.sendJobEvent(this.owner, this.job);
		}, delay);
		this.publishTimer.unref?.();
	}

	// ---- Cleanup ---------------------------------------------------------

	private clearFirstTextTimer(): void {
		if (this.firstTextTimer) {
			clearTimeout(this.firstTextTimer);
			this.firstTextTimer = undefined;
		}
	}

	private clearTimers(): void {
		if (this.unclaimedTimer) clearTimeout(this.unclaimedTimer);
		if (this.firstTextTimer) clearTimeout(this.firstTextTimer);
		if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		if (this.publishTimer) clearTimeout(this.publishTimer);
		if (this.idleTickTimer) clearInterval(this.idleTickTimer);
		this.unclaimedTimer = undefined;
		this.firstTextTimer = undefined;
		this.maxDurationTimer = undefined;
		this.retentionTimer = undefined;
		this.publishTimer = undefined;
		this.idleTickTimer = undefined;
	}

	private unsubscribeListener(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
