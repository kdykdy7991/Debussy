import { randomUUID } from "node:crypto";
import type {
	CancelSpeechCommand,
	CancelSpeechResult,
	Command,
	CommandResult,
	SpeechErrorCode,
	SpeechJob,
	StartSpeechCommand,
	StartSpeechResult,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import type { ConnectionState } from "../connection.ts";
import { PiServerError } from "../errors.ts";
import { resolveProfile } from "./profiles.ts";
import type {
	StreamSynthesisRequest,
	VoiceAudioFormat,
	VoiceCapability,
	VoiceProfile,
	VoiceServiceClient,
	VoiceStreamResult,
} from "./types.ts";

/** Browser-facing PCM route prefix; the manager and the HTTP handler must agree. */
export const SPEECH_STREAM_PATH_PREFIX = "/api/pi/v3/speech";

const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const DEFAULT_UNCLAIMED_TTL_MS = 30_000;
const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60_000;

export interface SpeechManagerHost {
	/** Resolve the transcript item backing a speech request (ownership + lookup). */
	resolveMessage(connection: ConnectionState, sessionId: string, messageId: string): TranscriptItem;
	/** Deliver a `speech_job` event to the owning connection; safe when disconnected. */
	sendJobEvent(connection: ConnectionState, job: SpeechJob): void;
	reportError(error: unknown): void;
}

export interface SpeechManagerOptions {
	voiceClient: VoiceServiceClient;
	profiles: readonly VoiceProfile[];
	defaultProfileId: string;
	/** Advertise `voice.live` capability. `false` until the V8 coordinator ships. */
	live?: boolean;
	/** When set, reject a Phase 1 job while a live speech job is active on the connection. */
	liveBusyCheck?: (connection: ConnectionState) => boolean;
	maxTextLength?: number;
	unclaimedTtlMs?: number;
	terminalRetentionMs?: number;
	streamPathPrefix?: string;
	clock?: () => number;
	uuid?: () => string;
}

interface SpeechJobEntry {
	job: SpeechJob;
	owner: ConnectionState;
	claimed: boolean;
	controller: AbortController;
	/** Speakable text resolved at creation; never stored to disk or transcripts. */
	text: string;
	profile: VoiceProfile;
	/** PCM bytes forwarded to the browser (for the %4 final-length check). */
	bytesWritten: number;
	terminal: boolean;
	unclaimedTimer?: ReturnType<typeof setTimeout>;
	retentionTimer?: ReturnType<typeof setTimeout>;
}

interface ResolvedSpeechManagerOptions {
	voiceClient: VoiceServiceClient;
	profiles: readonly VoiceProfile[];
	defaultProfileId: string;
	live: boolean;
	liveBusyCheck: ((connection: ConnectionState) => boolean) | undefined;
	maxTextLength: number;
	unclaimedTtlMs: number;
	terminalRetentionMs: number;
	streamPathPrefix: string;
	clock: () => number;
	uuid: () => string;
}

export interface SpeechClaim {
	job: SpeechJob;
	signal: AbortSignal;
	synthesis: StreamSynthesisRequest;
}

export type SpeechClaimResult =
	| { status: "ok"; claim: SpeechClaim }
	| { status: "not_found" }
	| { status: "claimed" }
	| { status: "expired" };

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function isTerminalStatus(status: SpeechJob["status"]): boolean {
	return TERMINAL_STATUSES.has(status);
}

/**
 * Only the public text parts of a completed assistant message may be spoken.
 * thinking/toolCall content never reaches the Voice Service.
 */
export function extractSpeakableText(item: TranscriptItem): string {
	if (item.role !== "assistant" || item.status !== "complete") {
		throw new PiServerError("invalid_request", "Only completed assistant messages can be read aloud", {
			speechCode: "message_not_speakable",
		});
	}
	const text = item.content
		.filter((part) => part.type === "text")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
	if (!text) {
		throw new PiServerError("invalid_request", "Message has no speakable text", {
			speechCode: "message_not_speakable",
		});
	}
	return text;
}

/**
 * Owns SpeechJob lifecycle: ownership, the state machine, atomic claim, TTL,
 * terminal retention, cancel and abort propagation. Jobs belong to the
 * WebSocket connection that created them and never enter session persistence.
 */
export class SpeechManager {
	private readonly options: ResolvedSpeechManagerOptions;
	private readonly jobs = new Map<string, SpeechJobEntry>();
	private host?: SpeechManagerHost;

	constructor(options: SpeechManagerOptions) {
		this.options = {
			maxTextLength: options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
			unclaimedTtlMs: options.unclaimedTtlMs ?? DEFAULT_UNCLAIMED_TTL_MS,
			terminalRetentionMs: options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS,
			streamPathPrefix: options.streamPathPrefix ?? SPEECH_STREAM_PATH_PREFIX,
			clock: options.clock ?? (() => Date.now()),
			uuid: options.uuid ?? (() => randomUUID()),
			live: options.live ?? false,
			liveBusyCheck: options.liveBusyCheck,
			voiceClient: options.voiceClient,
			profiles: options.profiles,
			defaultProfileId: options.defaultProfileId,
		};
	}

	/** PiServer injects the resolver and event sink after construction. */
	bind(host: SpeechManagerHost): void {
		this.host = host;
	}

	getCapability(): VoiceCapability {
		return {
			available: true,
			live: this.options.live,
			defaultProfile: this.options.defaultProfileId,
			profiles: this.options.profiles.map((profile) => ({
				id: profile.id,
				...(profile.name ? { name: profile.name } : {}),
			})),
		};
	}

	/** Whether this connection owns a non-terminal Phase 1 manual speech job. */
	hasActiveJob(connection: ConnectionState): boolean {
		for (const entry of this.jobs.values()) {
			if (entry.owner === connection && !entry.terminal) return true;
		}
		return false;
	}

	async executeCommand(connection: ConnectionState, command: Command): Promise<CommandResult> {
		if (command.command === "start_speech") return this.startSpeech(connection, command);
		if (command.command === "cancel_speech") return this.cancelSpeech(connection, command);
		throw new PiServerError("invalid_request", `Unhandled speech command: ${command.command}`);
	}

	/** Atomically claim a stream; the first GET wins, subsequent GETs see a stable error. */
	claimStream(jobId: string): SpeechClaimResult {
		const entry = this.jobs.get(jobId);
		if (!entry) return { status: "not_found" };
		if (entry.claimed) return { status: "claimed" };
		if (entry.terminal) return { status: "expired" };
		entry.claimed = true;
		clearTimeout(entry.unclaimedTimer);
		this.update(entry, { status: "generating" });
		return {
			status: "ok",
			claim: {
				job: entry.job,
				signal: entry.controller.signal,
				synthesis: this.buildSynthesis(entry),
			},
		};
	}

	/** Open the upstream stream for a claimed job (throws VoiceUpstreamError before any byte). */
	async openStream(jobId: string): Promise<VoiceStreamResult> {
		const entry = this.requireClaimed(jobId);
		return this.options.voiceClient.openStream(this.buildSynthesis(entry), entry.controller.signal);
	}

	/** First PCM byte written to the browser. */
	noteStreaming(jobId: string, format: VoiceAudioFormat): void {
		const entry = this.jobs.get(jobId);
		if (!entry || entry.terminal) return;
		this.update(entry, { status: "streaming", audio: format, firstChunkAt: this.options.clock() });
	}

	noteBytes(jobId: string, bytes: number): void {
		const entry = this.jobs.get(jobId);
		if (entry) entry.bytesWritten += bytes;
	}

	/**
	 * Finish a job when upstream EOF is reached. Returns false and fails the job
	 * when the forwarded byte count is not a multiple of 4 (broken float32 tail).
	 */
	completeJob(jobId: string): boolean {
		const entry = this.jobs.get(jobId);
		if (!entry || entry.terminal) return true;
		if (entry.bytesWritten % 4 !== 0) {
			this.settle(entry, "failed", {
				code: "speech_generation_failed",
				message: "Audio stream length is not a multiple of 4 bytes",
			});
			return false;
		}
		this.settle(entry, "completed");
		return true;
	}

	failJob(jobId: string, code: SpeechErrorCode, message: string): void {
		const entry = this.jobs.get(jobId);
		if (!entry || entry.terminal) return;
		this.settle(entry, "failed", { code, message });
	}

	/** Cancel a job (owner cancel, HTTP close, disconnect, shutdown). Idempotent. */
	abort(jobId: string): void {
		const entry = this.jobs.get(jobId);
		if (!entry || entry.terminal) return;
		entry.controller.abort();
		this.settle(entry, "cancelled");
	}

	/** Cancel every non-terminal job owned by a connection on disconnect/detach. */
	abortConnectionJobs(connection: ConnectionState): void {
		for (const entry of this.jobs.values()) {
			if (entry.owner === connection && !entry.terminal) this.abort(entry.job.id);
		}
	}

	/** Cancel all live jobs on server shutdown. */
	close(): void {
		for (const entry of [...this.jobs.values()]) {
			clearTimeout(entry.unclaimedTimer);
			clearTimeout(entry.retentionTimer);
			if (!entry.terminal) this.abort(entry.job.id);
		}
	}

	private async startSpeech(connection: ConnectionState, command: StartSpeechCommand): Promise<StartSpeechResult> {
		for (const entry of this.jobs.values()) {
			if (entry.owner === connection && !entry.terminal) {
				throw new PiServerError("busy", "This connection already has an active speech job");
			}
		}
		if (this.options.liveBusyCheck?.(connection)) {
			throw new PiServerError("busy", "A live speech job is active on this connection");
		}
		const profile = resolveProfile(this.options.profiles, command.voiceProfileId, this.options.defaultProfileId);
		const item = this.requireHost().resolveMessage(connection, command.sessionId, command.messageId);
		const text = extractSpeakableText(item);
		if (text.length > this.options.maxTextLength) {
			throw new PiServerError(
				"invalid_request",
				`Speakable text exceeds the ${this.options.maxTextLength} character limit`,
			);
		}
		const id = this.options.uuid();
		const now = this.options.clock();
		const job: SpeechJob = {
			id,
			sessionId: command.sessionId,
			messageId: command.messageId,
			voiceProfileId: profile.id,
			status: "queued",
			streamPath: `${this.options.streamPathPrefix}/${id}/stream`,
			createdAt: now,
			updatedAt: now,
		};
		const entry: SpeechJobEntry = {
			job,
			owner: connection,
			claimed: false,
			controller: new AbortController(),
			text,
			profile,
			bytesWritten: 0,
			terminal: false,
		};
		this.jobs.set(id, entry);
		entry.unclaimedTimer = setTimeout(() => this.expireUnclaimed(id), this.options.unclaimedTtlMs);
		entry.unclaimedTimer.unref?.();
		return { command: "start_speech", job };
	}

	private async cancelSpeech(connection: ConnectionState, command: CancelSpeechCommand): Promise<CancelSpeechResult> {
		const entry = this.jobs.get(command.jobId);
		if (!entry || entry.owner !== connection) {
			// Do not reveal whether another connection owns a job.
			throw new PiServerError("not_found", `Unknown speech job: ${command.jobId}`);
		}
		if (!entry.terminal) this.abort(command.jobId);
		return { command: "cancel_speech", job: entry.job };
	}

	private expireUnclaimed(jobId: string): void {
		const entry = this.jobs.get(jobId);
		if (!entry || entry.terminal || entry.claimed) return;
		this.abort(jobId);
	}

	private requireClaimed(jobId: string): SpeechJobEntry {
		const entry = this.jobs.get(jobId);
		if (!entry || !entry.claimed || entry.terminal) {
			throw new PiServerError("invalid_state", `Speech job is not claimable: ${jobId}`);
		}
		return entry;
	}

	private buildSynthesis(entry: SpeechJobEntry): StreamSynthesisRequest {
		return {
			text: entry.text,
			language: entry.profile.language,
			speaker: entry.profile.speaker,
			...(entry.profile.instruct ? { instruct: entry.profile.instruct } : {}),
		};
	}

	private settle(
		entry: SpeechJobEntry,
		status: "completed" | "failed" | "cancelled",
		error?: { code: SpeechErrorCode; message: string },
	): SpeechJob {
		if (entry.terminal) return entry.job;
		entry.terminal = true;
		clearTimeout(entry.unclaimedTimer);
		if (status !== "completed") entry.controller.abort();
		const job = this.update(entry, { status, ...(error ? { error } : {}) });
		entry.retentionTimer = setTimeout(() => this.drop(job.id), this.options.terminalRetentionMs);
		entry.retentionTimer.unref?.();
		return job;
	}

	private update(entry: SpeechJobEntry, patch: Partial<SpeechJob>): SpeechJob {
		const job = { ...entry.job, ...patch, updatedAt: this.options.clock() };
		entry.job = job;
		if (isTerminalStatus(job.status)) entry.terminal = true;
		this.host?.sendJobEvent(entry.owner, job);
		return job;
	}

	private drop(jobId: string): void {
		const entry = this.jobs.get(jobId);
		if (!entry) return;
		clearTimeout(entry.unclaimedTimer);
		this.jobs.delete(jobId);
	}

	private requireHost(): SpeechManagerHost {
		if (!this.host) throw new PiServerError("invalid_state", "Speech manager is not bound to a server");
		return this.host;
	}
}
