import type { IncomingMessage, ServerResponse } from "node:http";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
	/**
	 * Default ownership stamp used by `attach_upload` / `remove_attachment` to
	 * enforce cross-tenant / cross-principal attach hardening. The admin web
	 * WS plane has a single tenant + principal per server; production embed
	 * plane passes the connection's authenticated principal instead.
	 */
	attachmentOwner?: {
		readonly tenantId: import("./publishing/domain/ids.ts").TenantId;
		readonly principalId: import("./publishing/domain/ids.ts").PrincipalId;
	};
	/**
	 * Debug Conversation hook: when a broadcast `attachment_snapshot` /
	 * `attachment_removed` reaches this live session, the optional callback is
	 * invoked so the DebugConversationService can persist the event into the
	 * conversation's durable event stream.
	 */
	onAttachmentEvent?: (
		liveId: string,
		event:
			| {
					readonly type: "attachment_snapshot";
					readonly attachment: import("@earendil-works/pi-protocol").Attachment;
			  }
			| { readonly type: "attachment_removed"; readonly sessionId: string; readonly attachmentId: string },
	) => Promise<void>;
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
	/** Frozen PublishedAppVersion prompt, including bound Skill instructions. */
	systemPrompt?: string;
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
	/**
	 * Debug-only session: keep its transcript in memory and discard it when the
	 * live runtime is released. It must never be reopened from the session store.
	 */
	ephemeral?: boolean;
	cwd?: string;
	name?: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
	streamOptions?: Pick<SimpleStreamOptions, "temperature" | "samplingParams" | "maxTokens" | "thinkingBudgets">;
	/** Frozen external Tool definitions (MCP), added alongside Pi's built-in coding tools. */
	customTools?: readonly ToolDefinition[];
	/**
	 * Per-session resource overrides for published-app sessions. When present,
	 * the backend builds an independent ResourceLoader (no local skill/ext/
	 * context discovery) that injects the frozen system prompt and bound
	 * skills, so a session only ever sees its published revision's snapshot.
	 */
	resourceOverrides?: {
		/** Frozen PublishedAppVersion prompt. */
		systemPrompt?: string;
		/** Bound & materialized Skill revisions (filePath/baseDir under the runtime dir). */
		skills?: readonly MaterializedSkill[];
	};
}

/** A frozen Skill revision materialized to a server-controlled runtime directory. */
export interface MaterializedSkill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly baseDir: string;
	readonly disableModelInvocation: boolean;
}

export type PiSessionRuntimeEvent =
	| { type: "snapshot" }
	| { type: "progress"; progress: TranscriptProgress }
	| { type: "error"; error: PiServerError }
	| {
			type: "citation_snapshot";
			turnId: string;
			citations: readonly Citation[];
	  };

/** One acquired durable session. Conflicting operations must reject rather than queue. */
export interface PiSessionRuntime {
	/** Memory-only/admin debug runtimes are omitted from normal session listings. */
	readonly ephemeral?: boolean;
	snapshot(): SessionSnapshot;
	getPhase(): SessionPhase;
	/**
	 * Optional hook for a runtime that owns the durable Turn identity. Called
	 * synchronously by LiveSessionManager right before a `prompt` op so the
	 * session's `currentTurnId` (and thus every `session_progress.turnId`) is the
	 * runtime's real Turn id instead of a server-side random uuid. The runtime
	 * may also use it to atomically reserve its single active Turn slot and throw
	 * when a concurrent prompt must be rejected. Absent runtimes fall back to the
	 * server-side random id, preserving legacy behavior.
	 */
	beginTurn?(): string;
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
