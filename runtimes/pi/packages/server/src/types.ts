import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	Citation,
	ModelMetadata,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type { CitationService } from "./citations/service.ts";
import type { PiServerError } from "./errors.ts";
import type { PiServerListener } from "./listener.ts";
import type { AttachmentStore } from "./uploads/store.ts";
import type { LiveSpeechManager } from "./voice/live/live-speech-manager.ts";
import type { SpeechManager } from "./voice/speech-manager.ts";

export interface PiServerOptions {
	listeners: readonly PiServerListener[];
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	serverId?: string;
	onError?: (error: Error) => void;
	/** Maximum `session_progress` events buffered per session for resume replay. Default 2,000. */
	sessionEventLogMaxEvents?: number;
	/** How long buffered progress events are retained for resume replay. Default 10 minutes. */
	sessionEventLogRetentionMs?: number;
	/** Upload/attachment store backing `attach_upload` / `remove_attachment`. */
	attachments?: AttachmentStore;
	/** Citation index + retrieval service backing P2 source/citation flows. */
	citations?: CitationService;
	/** Speech proxy; when omitted, speech commands and PCM routes are unavailable. */
	speech?: SpeechManager;
	/** Phase 2 live speech coordinator; when omitted, live jobs and routes are unavailable. */
	liveSpeech?: LiveSpeechManager;
}

/** A handler for non-upgrade HTTP requests on the shared listener HTTP server; returns false when unhandled. */
export type HttpRequestHandler = (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;

export type MaybePromise<T> = T | Promise<T>;

/** Attachment content resolved by the server from staged files at prompt time. Paths never cross the wire. */
export interface ResolvedAttachmentInput {
	id: string;
	name: string;
	mediaType: string;
	path: string;
}

/**
 * Retrieved-context block injected into the user message for one turn.
 * `context` carries the controlled <source> fragments; `reference` is the
 * transcript-only summary, so source excerpts never reach the transcript.
 */
export interface RetrievalInput {
	context: string;
	reference: string;
	citations: readonly Citation[];
}

export interface PromptInput {
	text: string;
	attachmentIds?: string[];
	attachments?: ResolvedAttachmentInput[];
	retrieval?: RetrievalInput;
}

export interface SteerInput {
	text: string;
	attachmentIds?: string[];
	attachments?: ResolvedAttachmentInput[];
	retrieval?: RetrievalInput;
}

export interface CreateSessionOptions {
	/** A collision-resistant ID assigned by PiServer. The backend must persist this exact ID. */
	id: string;
	cwd?: string;
	name?: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

export type PiSessionRuntimeEvent =
	| { type: "snapshot" }
	| { type: "progress"; progress: TranscriptProgress }
	| { type: "error"; error: PiServerError };

/** One acquired durable session. Conflicting operations must reject rather than queue. */
export interface PiSessionRuntime {
	snapshot(): SessionSnapshot;
	getPhase(): SessionPhase;
	prompt(input: PromptInput): Promise<void>;
	steer(input: SteerInput): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void;
	dispose(): Promise<void>;
}

/** Durable storage and exclusively acquired runtime boundary. */
export interface PiSessionBackend {
	listSessions(): Promise<SessionSummary[]>;
	listModels(): Promise<ModelMetadata[]>;
	createSession(options: CreateSessionOptions): Promise<PiSessionRuntime>;
	openSession(sessionId: string): Promise<PiSessionRuntime>;
}

export type SessionRuntime = PiSessionRuntime;
export type SessionBackend = PiSessionBackend;
export type SessionRuntimeEvent = PiSessionRuntimeEvent;
