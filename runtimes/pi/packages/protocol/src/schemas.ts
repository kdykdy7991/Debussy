import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 4 as const;

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
/** Monotonic sequence assigned by the server to each `session_progress` event. Starts at 1. */
const SequenceSchema = Type.Integer({ minimum: 1 });
/** A client-reported or snapshot-reported sequence position; 0 means "no events yet". */
const SequencePositionSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** Matches AgentHarnessPhase so adapters do not need a second phase vocabulary. */
export const SessionPhaseSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("compaction"),
	Type.Literal("branch_summary"),
	Type.Literal("retry"),
]);
export type SessionPhase = Static<typeof SessionPhaseSchema>;

export const ModelRefSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
});
export type ModelRef = Static<typeof ModelRefSchema>;

export const ModelCostSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});

export const ModelMetadataSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
	name: Type.String({ minLength: 1 }),
	api: IdSchema,
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	cost: ModelCostSchema,
	supportedThinkingLevels: Type.Array(ThinkingLevelSchema, { minItems: 1 }),
	authenticated: Type.Boolean(),
});
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

export const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
});
export const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	redacted: Type.Optional(Type.Boolean()),
});
export const ImageContentSchema = StrictObject({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String({ minLength: 1 }),
});
export const ToolCallContentSchema = StrictObject({
	type: Type.Literal("toolCall"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
});
export const UserContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
export const AssistantContentSchema = Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallContentSchema]);
export const ToolContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
export type TextContent = Static<typeof TextContentSchema>;
export type ThinkingContent = Static<typeof ThinkingContentSchema>;
export type ImageContent = Static<typeof ImageContentSchema>;
export type ToolCallContent = Static<typeof ToolCallContentSchema>;

export const UsageSchema = StrictObject({
	input: Type.Integer({ minimum: 0 }),
	output: Type.Integer({ minimum: 0 }),
	cacheRead: Type.Integer({ minimum: 0 }),
	cacheWrite: Type.Integer({ minimum: 0 }),
	reasoning: Type.Optional(Type.Integer({ minimum: 0 })),
	totalTokens: Type.Integer({ minimum: 0 }),
	cost: StrictObject({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}),
});
export type Usage = Static<typeof UsageSchema>;

export const UserTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("user"),
	content: Type.Array(UserContentSchema),
	timestamp: TimestampSchema,
});
const AssistantTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("assistant"),
	content: Type.Array(AssistantContentSchema),
	model: ModelRefSchema,
	responseModel: Type.Optional(Type.String({ minLength: 1 })),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
const StreamingAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("streaming"),
});
const CompleteAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("complete"),
	stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
});
const ErrorAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("error"),
	stopReason: Type.Literal("error"),
	errorMessage: Type.Optional(Type.String({ minLength: 1 })),
});
const AbortedAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("aborted"),
	stopReason: Type.Literal("aborted"),
	errorMessage: Type.Optional(Type.String()),
});
export const AssistantTranscriptItemSchema = Type.Union([
	StreamingAssistantTranscriptItemSchema,
	CompleteAssistantTranscriptItemSchema,
	ErrorAssistantTranscriptItemSchema,
	AbortedAssistantTranscriptItemSchema,
]);
const ToolTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("tool"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
	content: Type.Array(ToolContentSchema),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
const RunningToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("running"),
	isError: Type.Literal(false),
});
const CompleteToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("complete"),
	isError: Type.Literal(false),
});
const ErrorToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("error"),
	isError: Type.Literal(true),
});
export const ToolTranscriptItemSchema = Type.Union([
	RunningToolTranscriptItemSchema,
	CompleteToolTranscriptItemSchema,
	ErrorToolTranscriptItemSchema,
]);
export const TranscriptItemSchema = Type.Union([
	UserTranscriptItemSchema,
	AssistantTranscriptItemSchema,
	ToolTranscriptItemSchema,
]);
export type UserTranscriptItem = Static<typeof UserTranscriptItemSchema>;
export type AssistantTranscriptItem = Static<typeof AssistantTranscriptItemSchema>;
export type ToolTranscriptItem = Static<typeof ToolTranscriptItemSchema>;
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

/** Normalized incremental activity. Snapshots remain authoritative. */
export const TranscriptProgressSchema = Type.Union([
	StrictObject({
		type: Type.Literal("item_started"),
		item: TranscriptItemSchema,
	}),
	StrictObject({
		type: Type.Literal("assistant_delta"),
		messageId: IdSchema,
		contentIndex: Type.Integer({ minimum: 0 }),
		kind: Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("toolCall")]),
		delta: Type.String(),
	}),
	StrictObject({
		type: Type.Literal("item_updated"),
		item: Type.Union([AssistantTranscriptItemSchema, ToolTranscriptItemSchema]),
	}),
	StrictObject({
		type: Type.Literal("item_finished"),
		item: Type.Union([
			CompleteAssistantTranscriptItemSchema,
			ErrorAssistantTranscriptItemSchema,
			AbortedAssistantTranscriptItemSchema,
			CompleteToolTranscriptItemSchema,
			ErrorToolTranscriptItemSchema,
		]),
	}),
]);
export type TranscriptProgress = Static<typeof TranscriptProgressSchema>;

const SessionSummaryProperties = {
	id: IdSchema,
	name: Type.Optional(Type.String()),
	cwd: Type.String({ minLength: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	phase: SessionPhaseSchema,
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	attached: Type.Boolean(),
	locked: Type.Boolean(),
} as const;

export const SessionSummarySchema = StrictObject(SessionSummaryProperties);

export const AttachmentScopeSchema = Type.Union([Type.Literal("turn"), Type.Literal("session")]);
export type AttachmentScope = Static<typeof AttachmentScopeSchema>;

export const AttachmentStatusSchema = Type.Union([
	Type.Literal("uploading"),
	Type.Literal("scanning"),
	Type.Literal("parsing"),
	Type.Literal("indexing"),
	Type.Literal("ready"),
	Type.Literal("restricted"),
	Type.Literal("failed"),
	Type.Literal("removed"),
]);
export type AttachmentStatus = Static<typeof AttachmentStatusSchema>;

/** Authoritative attachment metadata surfaced to clients. File bytes never travel over the protocol. */
export const AttachmentSchema = StrictObject({
	id: IdSchema,
	sessionId: Type.Optional(IdSchema),
	name: Type.String({ minLength: 1 }),
	mediaType: Type.String({ minLength: 1 }),
	size: Type.Integer({ minimum: 0 }),
	sha256: Type.String({ minLength: 1 }),
	status: AttachmentStatusSchema,
	scope: Type.Optional(AttachmentScopeSchema),
	createdAt: TimestampSchema,
	pageCount: Type.Optional(Type.Integer({ minimum: 0 })),
	error: Type.Optional(
		StrictObject({
			code: Type.String(),
			message: Type.String(),
		}),
	),
});
export type Attachment = Static<typeof AttachmentSchema>;

export const SourceStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("ready"),
	Type.Literal("failed"),
	Type.Literal("removed"),
]);
export type SourceStatus = Static<typeof SourceStatusSchema>;

/**
 * A retrievable index over one uploaded attachment. A Source references its
 * P1 attachment and never copies file bytes; the staged file stays owned by
 * the attachment store.
 */
export const SourceSchema = StrictObject({
	id: IdSchema,
	attachmentId: IdSchema,
	sessionId: IdSchema,
	name: Type.String({ minLength: 1 }),
	mediaType: Type.String({ minLength: 1 }),
	status: SourceStatusSchema,
	/** Monotonic index revision; bumped on every successful re-index. */
	version: Type.Integer({ minimum: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	/** Set when the whole file was indexed but truncated by the size limit. */
	truncated: Type.Optional(Type.Boolean()),
	error: Type.Optional(
		StrictObject({
			code: Type.String(),
			message: Type.String(),
		}),
	),
});
export type Source = Static<typeof SourceSchema>;

/**
 * One indexed fragment of a Source. Chunks are server-internal: they are only
 * used for retrieval and model context, never transmitted to clients as raw
 * text. Clients see excerpts derived from stored chunks via `Citation`.
 */
export const SourceChunkSchema = StrictObject({
	id: IdSchema,
	sourceId: IdSchema,
	/** Stable, zero-based position within the source; survives re-index. */
	ordinal: Type.Integer({ minimum: 0 }),
	text: Type.String(),
	/** 1-based inclusive line range in the original file. */
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	endLine: Type.Optional(Type.Integer({ minimum: 1 })),
	/** 0-based inclusive character range in the original file text. */
	charStart: Type.Optional(Type.Integer({ minimum: 0 })),
	charEnd: Type.Optional(Type.Integer({ minimum: 0 })),
	tokenEstimate: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type SourceChunk = Static<typeof SourceChunkSchema>;

/**
 * The set of source fragments a single agent turn actually used. A Citation is
 * metadata over stored chunks — `excerpt` always originates server-side and
 * clients can never submit it.
 */
export const CitationSchema = StrictObject({
	id: IdSchema,
	sessionId: IdSchema,
	turnId: IdSchema,
	sourceId: IdSchema,
	chunkId: IdSchema,
	ordinal: Type.Integer({ minimum: 0 }),
	/** Display title (source file name), safe for client rendering. */
	title: Type.String({ minLength: 1 }),
	/** Excerpt copied from the stored chunk; never client-supplied. */
	excerpt: Type.String(),
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	endLine: Type.Optional(Type.Integer({ minimum: 1 })),
	score: Type.Optional(Type.Number({ minimum: 0 })),
});
export type Citation = Static<typeof CitationSchema>;

export const SessionSnapshotSchema = StrictObject({
	...SessionSummaryProperties,
	lastSequence: SequencePositionSchema,
	revision: Type.Integer({ minimum: 0 }),
	transcript: Type.Array(TranscriptItemSchema),
	queuedSteer: Type.Array(UserTranscriptItemSchema),
	queuedSteerCount: Type.Integer({ minimum: 0 }),
	attachments: Type.Optional(Type.Array(AttachmentSchema)),
	/** Active text sources for the session (pending/ready/failed, never removed). */
	sources: Type.Optional(Type.Array(SourceSchema)),
	/** Citations for the most recent turn; kept small, not all history. */
	citations: Type.Optional(Type.Array(CitationSchema)),
});
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

/** Public, provider-neutral identity for a voice profile. Never carries speaker, instruct, model or paths. */
export const VoiceProfileSummarySchema = StrictObject({
	id: IdSchema,
	name: Type.Optional(Type.String()),
});
export type VoiceProfileSummary = Static<typeof VoiceProfileSummarySchema>;

/**
 * Present only when the server has a speech proxy configured. Absence tells the
 * client to hide speech UI entirely; the proxy details never cross the wire.
 *
 * `live` advertises whether live (in-progress)朗读 is available in the current
 * server build. The value is independent from `available`: a v3 server can ship
 * `live: false` while still hosting manual jobs, and a v4 server ships `live:
 * false` until the V8 coordinator lands, then `live: true` once the V9 path is
 * exercised. Clients must treat `live: false` as a legitimate capability
 * downgrade that simply omits the live朗读 UI.
 */
export const VoiceCapabilitySchema = StrictObject({
	available: Type.Literal(true),
	live: Type.Boolean(),
	defaultProfile: IdSchema,
	profiles: Type.Optional(Type.Array(VoiceProfileSummarySchema)),
});
export type VoiceCapability = Static<typeof VoiceCapabilitySchema>;

export const ServerSnapshotSchema = StrictObject({
	serverId: IdSchema,
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	sessions: Type.Array(SessionSummarySchema),
	models: Type.Array(ModelMetadataSchema),
	voice: Type.Optional(VoiceCapabilitySchema),
});
export type ServerSnapshot = Static<typeof ServerSnapshotSchema>;

export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("version"),
	Type.Literal("busy"),
	Type.Literal("session_locked"),
	Type.Literal("not_found"),
	Type.Literal("invalid_request"),
	Type.Literal("unauthorized"),
	Type.Literal("forbidden"),
	Type.Literal("conflict"),
	Type.Literal("invalid_state"),
	Type.Literal("payload_too_large"),
	Type.Literal("unsupported_media_type"),
	Type.Literal("expired"),
]);
export const ProtocolErrorSchema = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

/** Provider-neutral state of one speech job; PCM never travels over this protocol. */
export const SpeechStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("generating"),
	Type.Literal("streaming"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
]);
export type SpeechStatus = Static<typeof SpeechStatusSchema>;

export const SpeechAudioFormatSchema = StrictObject({
	encoding: Type.Literal("pcm_f32le"),
	sampleRate: Type.Integer({ minimum: 1 }),
	channels: Type.Literal(1),
});
export type SpeechAudioFormat = Static<typeof SpeechAudioFormatSchema>;

export const SpeechErrorCodeSchema = Type.Union([
	Type.Literal("voice_unavailable"),
	Type.Literal("voice_profile_not_found"),
	Type.Literal("message_not_speakable"),
	Type.Literal("speech_busy"),
	Type.Literal("speech_stream_claimed"),
	Type.Literal("speech_stream_expired"),
	Type.Literal("speech_generation_failed"),
	Type.Literal("speech_cancelled"),
]);
export type SpeechErrorCode = Static<typeof SpeechErrorCodeSchema>;

export const SpeechErrorSchema = StrictObject({
	code: SpeechErrorCodeSchema,
	message: Type.String(),
});
export type SpeechError = Static<typeof SpeechErrorSchema>;

/**
 * Describes generation + transfer, not that audio was heard. `completed` means
 * the Voice Service was exhausted and the server finished the HTTP response.
 */
export const SpeechJobSchema = StrictObject({
	id: IdSchema,
	sessionId: IdSchema,
	messageId: IdSchema,
	voiceProfileId: IdSchema,
	status: SpeechStatusSchema,
	/** Server-generated relative path the browser streams PCM from. */
	streamPath: Type.String({ minLength: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	firstChunkAt: Type.Optional(TimestampSchema),
	audio: Type.Optional(SpeechAudioFormatSchema),
	error: Type.Optional(SpeechErrorSchema),
});
export type SpeechJob = Static<typeof SpeechJobSchema>;

export const StartSpeechCommandSchema = StrictObject({
	command: Type.Literal("start_speech"),
	sessionId: IdSchema,
	messageId: IdSchema,
	voiceProfileId: Type.Optional(IdSchema),
});
export type StartSpeechCommand = Static<typeof StartSpeechCommandSchema>;

export const CancelSpeechCommandSchema = StrictObject({
	command: Type.Literal("cancel_speech"),
	jobId: IdSchema,
});
export type CancelSpeechCommand = Static<typeof CancelSpeechCommandSchema>;

export const StartSpeechResultSchema = StrictObject({
	command: Type.Literal("start_speech"),
	job: SpeechJobSchema,
});
export type StartSpeechResult = Static<typeof StartSpeechResultSchema>;

export const CancelSpeechResultSchema = StrictObject({
	command: Type.Literal("cancel_speech"),
	job: SpeechJobSchema,
});
export type CancelSpeechResult = Static<typeof CancelSpeechResultSchema>;

/** Job events are delivered only to the connection that created the job. */
export const SpeechJobEventSchema = StrictObject({
	type: Type.Literal("speech_job"),
	job: SpeechJobSchema,
});
export type SpeechJobEvent = Static<typeof SpeechJobEventSchema>;

/**
 * Phase 2 live朗读 (V5-V9) — opt-in incremental朗读 for assistant messages that
 * are still being generated. Lives next to the Phase 1 manual `SpeechJob` but
 * never collides with it: different `command` names, different `Job` shape, and
 * a separate HTTP route (`/api/pi/v4/live-speech/{jobId}/stream`).
 */
export const LiveSpeechRequestSchema = StrictObject({
	mode: Type.Literal("live"),
	voiceProfileId: Type.Optional(IdSchema),
});
export type LiveSpeechRequest = Static<typeof LiveSpeechRequestSchema>;

/**
 * Live job lifecycle. `completed` means the Agent turn has ended, the segmenter
 * has flushed, the queue has drained, and the Server PCM response has closed;
 * the browser may still be draining. All terminal statuses are irreversible.
 */
export const LiveSpeechStatusSchema = Type.Union([
	Type.Literal("waiting_for_text"),
	Type.Literal("generating"),
	Type.Literal("streaming"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
	Type.Literal("failed"),
]);
export type LiveSpeechStatus = Static<typeof LiveSpeechStatusSchema>;

export const LiveSpeechProgressSchema = StrictObject({
	committedUtterances: Type.Integer({ minimum: 0 }),
	completedUtterances: Type.Integer({ minimum: 0 }),
	pendingCharacters: Type.Integer({ minimum: 0 }),
});
export type LiveSpeechProgress = Static<typeof LiveSpeechProgressSchema>;

export const LiveSpeechErrorCodeSchema = Type.Union([
	Type.Literal("voice_unavailable"),
	Type.Literal("voice_profile_not_found"),
	Type.Literal("live_speech_busy"),
	Type.Literal("live_speech_expired"),
	Type.Literal("turn_not_started"),
	Type.Literal("unsupported_content"),
	Type.Literal("speech_backlog_exceeded"),
	Type.Literal("speech_generation_failed"),
	Type.Literal("speech_cancelled"),
]);
export type LiveSpeechErrorCode = Static<typeof LiveSpeechErrorCodeSchema>;

export const LiveSpeechErrorSchema = StrictObject({
	code: LiveSpeechErrorCodeSchema,
	message: Type.String(),
});
export type LiveSpeechError = Static<typeof LiveSpeechErrorSchema>;

/**
 * Describes generation + transfer for one in-progress朗读 session. PCM never
 * travels over this protocol. `turnId`/`messageId` are populated after the
 * matching `item_started` arrives; `firstChunkAt` once the first PCM byte
 * reaches the server response.
 */
export const LiveSpeechJobSchema = StrictObject({
	id: IdSchema,
	sessionId: IdSchema,
	voiceProfileId: IdSchema,
	status: LiveSpeechStatusSchema,
	/** Server-generated relative path the browser streams PCM from. */
	streamPath: Type.String({ minLength: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	turnId: Type.Optional(IdSchema),
	messageId: Type.Optional(IdSchema),
	firstChunkAt: Type.Optional(TimestampSchema),
	audio: Type.Optional(SpeechAudioFormatSchema),
	progress: LiveSpeechProgressSchema,
	error: Type.Optional(LiveSpeechErrorSchema),
});
export type LiveSpeechJob = Static<typeof LiveSpeechJobSchema>;

export const CancelLiveSpeechCommandSchema = StrictObject({
	command: Type.Literal("cancel_live_speech"),
	jobId: IdSchema,
});
export type CancelLiveSpeechCommand = Static<typeof CancelLiveSpeechCommandSchema>;

export const CancelLiveSpeechResultSchema = StrictObject({
	command: Type.Literal("cancel_live_speech"),
	job: LiveSpeechJobSchema,
});
export type CancelLiveSpeechResult = Static<typeof CancelLiveSpeechResultSchema>;

/**
 * Live job events are delivered only to the connection that created the job.
 * They never enter session replay or session snapshots.
 */
export const LiveSpeechJobEventSchema = StrictObject({
	type: Type.Literal("live_speech_job"),
	job: LiveSpeechJobSchema,
});
export type LiveSpeechJobEvent = Static<typeof LiveSpeechJobEventSchema>;

const PromptPayloadProperties = {
	sessionId: IdSchema,
	text: Type.String(),
	attachmentIds: Type.Optional(Type.Array(IdSchema, { maxItems: 16 })),
} as const;

export const ListCommandSchema = StrictObject({ command: Type.Literal("list") });
export const CreateCommandSchema = StrictObject({
	command: Type.Literal("create"),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	name: Type.Optional(Type.String()),
	model: Type.Optional(ModelRefSchema),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
export const AttachCommandSchema = StrictObject({ command: Type.Literal("attach"), sessionId: IdSchema });
export const DetachCommandSchema = StrictObject({ command: Type.Literal("detach"), sessionId: IdSchema });
export const ResumeCommandSchema = StrictObject({
	command: Type.Literal("resume"),
	sessionId: IdSchema,
	afterSequence: SequencePositionSchema,
});
export const PromptCommandSchema = StrictObject({
	command: Type.Literal("prompt"),
	...PromptPayloadProperties,
	/** Phase 2 live朗读 opt-in. Omitted/legacy clients fall back to Phase 1 manual朗读. */
	speech: Type.Optional(LiveSpeechRequestSchema),
});
export const SteerCommandSchema = StrictObject({ command: Type.Literal("steer"), ...PromptPayloadProperties });
export const AbortCommandSchema = StrictObject({ command: Type.Literal("abort"), sessionId: IdSchema });
export const SetModelCommandSchema = StrictObject({
	command: Type.Literal("set_model"),
	sessionId: IdSchema,
	model: ModelRefSchema,
});
export const SetThinkingCommandSchema = StrictObject({
	command: Type.Literal("set_thinking"),
	sessionId: IdSchema,
	thinkingLevel: ThinkingLevelSchema,
});
export const AttachUploadCommandSchema = StrictObject({
	command: Type.Literal("attach_upload"),
	sessionId: IdSchema,
	uploadId: IdSchema,
	scope: AttachmentScopeSchema,
});
export const RemoveAttachmentCommandSchema = StrictObject({
	command: Type.Literal("remove_attachment"),
	sessionId: IdSchema,
	attachmentId: IdSchema,
});
export const CommandSchema = Type.Union([
	ListCommandSchema,
	CreateCommandSchema,
	AttachCommandSchema,
	DetachCommandSchema,
	ResumeCommandSchema,
	PromptCommandSchema,
	SteerCommandSchema,
	AbortCommandSchema,
	SetModelCommandSchema,
	SetThinkingCommandSchema,
	AttachUploadCommandSchema,
	RemoveAttachmentCommandSchema,
	StartSpeechCommandSchema,
	CancelSpeechCommandSchema,
	CancelLiveSpeechCommandSchema,
]);
export type Command = Static<typeof CommandSchema>;
export type CommandName = Command["command"];
export type ResumeCommand = Static<typeof ResumeCommandSchema>;
export type ResumeResult = Static<typeof ResumeResultSchema>;

export const CreateResultSchema = StrictObject({
	command: Type.Literal("create"),
	session: SessionSnapshotSchema,
});
export const AttachResultSchema = StrictObject({
	command: Type.Literal("attach"),
	session: SessionSnapshotSchema,
});
export const PromptResultSchema = StrictObject({
	command: Type.Literal("prompt"),
	session: SessionSnapshotSchema,
	/** Phase 2 live朗读 job. Only present when the prompt carried `speech`. */
	liveSpeech: Type.Optional(LiveSpeechJobSchema),
});
export type PromptResult = Static<typeof PromptResultSchema>;
export const SteerResultSchema = StrictObject({
	command: Type.Literal("steer"),
	session: SessionSnapshotSchema,
});
export type SteerResult = Static<typeof SteerResultSchema>;
export const AbortResultSchema = StrictObject({
	command: Type.Literal("abort"),
	session: SessionSnapshotSchema,
});
export const SetModelResultSchema = StrictObject({
	command: Type.Literal("set_model"),
	session: SessionSnapshotSchema,
});
export const SetThinkingResultSchema = StrictObject({
	command: Type.Literal("set_thinking"),
	session: SessionSnapshotSchema,
});
export const ResumeResultSchema = StrictObject({
	command: Type.Literal("resume"),
	session: SessionSnapshotSchema,
	replayedThrough: SequencePositionSchema,
	resetRequired: Type.Boolean(),
});

export const ListResultSchema = StrictObject({
	command: Type.Literal("list"),
	sessions: Type.Array(SessionSummarySchema),
});
export const DetachResultSchema = StrictObject({
	command: Type.Literal("detach"),
	sessionId: IdSchema,
});
export const AttachUploadResultSchema = StrictObject({
	command: Type.Literal("attach_upload"),
	session: SessionSnapshotSchema,
});
export const RemoveAttachmentResultSchema = StrictObject({
	command: Type.Literal("remove_attachment"),
	session: SessionSnapshotSchema,
});
export const CommandResultSchema = Type.Union([
	ListResultSchema,
	CreateResultSchema,
	AttachResultSchema,
	DetachResultSchema,
	ResumeResultSchema,
	PromptResultSchema,
	SteerResultSchema,
	AbortResultSchema,
	SetModelResultSchema,
	SetThinkingResultSchema,
	AttachUploadResultSchema,
	RemoveAttachmentResultSchema,
	StartSpeechResultSchema,
	CancelSpeechResultSchema,
	CancelLiveSpeechResultSchema,
]);
export type CommandResult = Static<typeof CommandResultSchema>;

export type ResultForCommand<TCommand extends Command> = TCommand["command"] extends "list"
	? Static<typeof ListResultSchema>
	: TCommand["command"] extends "detach"
		? Static<typeof DetachResultSchema>
		: Extract<CommandResult, { command: TCommand["command"] }>;

/** Must be the first frame sent by a client. Version is intentionally an integer, not a coercible string. */
export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

export const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	request: CommandSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

export const SessionProgressEventSchema = StrictObject({
	type: Type.Literal("session_progress"),
	sessionId: IdSchema,
	turnId: IdSchema,
	sequence: SequenceSchema,
	progress: TranscriptProgressSchema,
});
export type SessionProgressEvent = Static<typeof SessionProgressEventSchema>;

export const AttachmentSnapshotEventSchema = StrictObject({
	type: Type.Literal("attachment_snapshot"),
	attachment: AttachmentSchema,
});
export const AttachmentRemovedEventSchema = StrictObject({
	type: Type.Literal("attachment_removed"),
	sessionId: IdSchema,
	attachmentId: IdSchema,
});
/** A source status change; broadcast when indexing finishes, fails, or is removed. */
export const SourceSnapshotEventSchema = StrictObject({
	type: Type.Literal("source_snapshot"),
	source: SourceSchema,
});
/**
 * The citations a completed turn actually used. Broadcast once near the end of
 * the turn; clients merge it into their snapshot for the current turn.
 */
export const CitationSnapshotEventSchema = StrictObject({
	type: Type.Literal("citation_snapshot"),
	sessionId: IdSchema,
	turnId: IdSchema,
	citations: Type.Array(CitationSchema),
});
export const ServerEventSchema = Type.Union([
	StrictObject({ type: Type.Literal("server_snapshot"), snapshot: ServerSnapshotSchema }),
	StrictObject({ type: Type.Literal("session_snapshot"), snapshot: SessionSnapshotSchema }),
	SessionProgressEventSchema,
	StrictObject({ type: Type.Literal("session_removed"), sessionId: IdSchema }),
	AttachmentSnapshotEventSchema,
	AttachmentRemovedEventSchema,
	SourceSnapshotEventSchema,
	CitationSnapshotEventSchema,
	SpeechJobEventSchema,
	LiveSpeechJobEventSchema,
]);
export type ServerEvent = Static<typeof ServerEventSchema>;

export const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	connectionId: IdSchema,
	snapshot: ServerSnapshotSchema,
});
export const ServerHelloErrorSchema = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
export const ResponseEnvelopeSchema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		result: CommandResultSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: ProtocolErrorSchema,
	}),
]);
export const EventEnvelopeSchema = StrictObject({
	type: Type.Literal("event"),
	event: ServerEventSchema,
});
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	EventEnvelopeSchema,
]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
