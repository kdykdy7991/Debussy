/**
 * Session event envelope shared by Admin and Embed planes (WB-007 / SPEC §11).
 *
 * The Conversation Event Log is the only authoritative truth source for a
 * conversation's history. JSONL is purely an export format; we deliberately
 * do not maintain per-session JSONL files on disk (spec §11.1) and there is
 * no `conversation_segments` table in this milestone.
 *
 * Two planes share the wire shape (admin debugging + embed runtime), but each
 * persists with the same scope (`tenant + app + owner + conversation`) and the
 * same `(conversationId, sequence)` uniqueness.
 *
 * Sensitive fields are NEVER accepted as event payload values (spec §11.5):
 * tokens, PEM material, raw visitorId/externalUserId, Provider secrets.
 * `assertEventPayloadSafe` enforces this at the boundary so a missed caller
 * does not leak through persistence.
 */

/** Schema version of `payload` for each event type. Increment on breaking payload changes. */
export const SESSION_EVENT_PAYLOAD_SCHEMA_VERSION = 1 as const;

/** Conversation event type catalogue (spec §11.4). Adding a new value requires migration + tests. */
export const SESSION_EVENT_TYPES = [
	"conversation/created",
	"turn/start",
	"context/snapshot",
	"user/message",
	"assistant/start",
	"assistant/chunk",
	"assistant/message",
	"tool/call",
	"tool/result",
	"tool/error",
	"attachment/added",
	"citation/updated",
	"turn/end",
	"turn/failed",
	"turn/interrupted",
	"conversation/summary",
	"conversation/rollover",
	"conversation/archived",
	"history/expired",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/** Streaming chunk retention policy (spec §11.4). */
export const SESSION_LOG_LEVELS = ["standard", "diagnostic", "full"] as const;
export type SessionLogLevel = (typeof SESSION_LOG_LEVELS)[number];

/**
 * Default per-payload ceiling (UTF-8 bytes). Configured by the operator at
 * boot (spec §11.5). This constant is the floor — anything larger must spill
 * to the object store and only an `artifactId` lives in the event payload.
 */
export const SESSION_EVENT_PAYLOAD_BYTE_LIMIT = 256 * 1024;
export const SESSION_EVENT_INLINED_TOOL_RESULT_BYTE_LIMIT = 128 * 1024;
export const SESSION_EVENT_INLINED_MESSAGE_BYTE_LIMIT = 64 * 1024;

/** Sensitive keys that must never appear in an event payload (spec §11.5). */
const SENSITIVE_PAYLOAD_KEYS: readonly string[] = [
	"adminToken",
	"admin_token",
	"accessToken",
	"access_token",
	"launchToken",
	"launch_token",
	"authorization",
	"providerApiKey",
	"provider_api_key",
	"launchKeyPem",
	"launch_key_pem",
	"privateKey",
	"private_key",
	"externalUserId",
	"external_user_id",
	"visitorId",
	"visitor_id",
	"rawSubject",
	"raw_subject",
];

/**
 * Sensitive value patterns. Token-shaped strings are rejected regardless of
 * the key they live under. Conservative on purpose: a false positive only
 * forces the caller to rename a field; a false negative would leak a token.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
	/^Bearer\s+/i,
	/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
	/^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/^-----BEGIN [A-Z ]*RSA [A-Z ]*PRIVATE KEY-----/,
	/^-----BEGIN [A-Z ]*EC [A-Z ]*PRIVATE KEY-----/,
	/^-----BEGIN [A-Z ]*OPENSSH PRIVATE KEY-----/,
	/^sk-[A-Za-z0-9_-]{16,}$/, // generic Provider API key shape
];

/** Error thrown by `assertEventPayloadSafe` so callers can distinguish from generic validation. */
export class SessionEventPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionEventPayloadError";
	}
}

/**
 * Validate that an event payload is safe to persist. Walks every value
 * recursively and rejects payloads that:
 *
 * - contain a sensitive key (any depth)
 * - contain a value matching a token/key/PEM shape
 * - are not JSON-serialisable (functions, symbols, undefined values)
 * - exceed the per-payload byte ceiling
 */
export function assertEventPayloadSafe(
	payload: unknown,
	options: { readonly byteLimit?: number; readonly eventType?: SessionEventType } = {},
): void {
	const byteLimit = options.byteLimit ?? SESSION_EVENT_PAYLOAD_BYTE_LIMIT;
	const eventType = options.eventType;
	if (eventType !== undefined && !SESSION_EVENT_TYPES.includes(eventType)) {
		throw new SessionEventPayloadError(`Unknown event type: ${eventType}`);
	}
	if (!isJsonSerializable(payload)) {
		throw new SessionEventPayloadError("Event payload must be JSON-serialisable");
	}
	const bytes = utf8ByteLength(payload);
	if (bytes > byteLimit) {
		throw new SessionEventPayloadError(
			`Event payload exceeds ${byteLimit} bytes (actual ${bytes}); spill to object store`,
		);
	}
	walkPayload(payload, "");
}

function isJsonSerializable(value: unknown): boolean {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	if (type === "number") return Number.isFinite(value as number);
	if (Array.isArray(value)) return value.every(isJsonSerializable);
	if (type === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of Object.keys(obj)) {
			if (!isJsonSerializable(obj[key])) return false;
		}
		return true;
	}
	return false;
}

function utf8ByteLength(value: unknown): number {
	// JSON round-trip keeps the exact wire shape; encoder handles escaping.
	const json = JSON.stringify(value);
	return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function walkPayload(value: unknown, path: string): void {
	if (value === null) return;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) {
			walkPayload(value[i], `${path}[${i}]`);
		}
		return;
	}
	if (typeof value === "object") {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			const childPath = path === "" ? key : `${path}.${key}`;
			if (SENSITIVE_PAYLOAD_KEYS.includes(key)) {
				throw new SessionEventPayloadError(`Event payload contains sensitive field at ${childPath} (key "${key}")`);
			}
			walkPayload(child, childPath);
		}
		return;
	}
	if (typeof value === "string") {
		for (const pattern of SENSITIVE_VALUE_PATTERNS) {
			if (pattern.test(value)) {
				throw new SessionEventPayloadError(`Event payload value at ${path} matches a sensitive shape`);
			}
		}
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new SessionEventPayloadError(`Event payload value at ${path} is not a finite number`);
		}
	}
}

/**
 * Decide which streaming-chunk events a log level must persist.
 *
 * - `standard`: only `assistant/message` final results; debugging chunks are
 *   dropped (spec §11.4 default for published apps).
 * - `diagnostic`: first chunk + every milestone chunk (first tool call, last
 *   chunk, turn end) plus timing metadata.
 * - `full`: every chunk, every tool detail; admin debugging only.
 */
export function shouldPersistAssistantChunk(
	level: SessionLogLevel,
	chunk: { readonly ordinal: number; readonly isFirst: boolean; readonly isLast: boolean },
): boolean {
	if (level === "full") return true;
	if (level === "diagnostic") return chunk.isFirst || chunk.isLast || chunk.ordinal % 16 === 1;
	// standard: only the final consolidated message
	return false;
}

/**
 * Decide whether a tool call event should be persisted at this log level.
 * All levels persist tool call/result/error; only `full` keeps the tool input
 * payload verbatim (other levels keep metadata only).
 */
export function shouldInlineToolInput(level: SessionLogLevel): boolean {
	return level === "full";
}

/**
 * WB-008: summary / rollover envelope shared by Admin and Embed planes.
 *
 * A `Summary` is the frozen snapshot of a conversation at the `throughSequence`
 * boundary; `throughSequence` MUST point at the last sequence of a complete
 * Turn (the next event in the log is either a new `turn/start` or the
 * conversation itself is over). The Runtime uses the latest summary plus all
 * events with `sequence > throughSequence` to rebuild model context, so the
 * full log remains the only authoritative truth source.
 */

/** Free-text summary body. Always JSON-serialisable; sensitive fields forbidden. */
export interface ConversationEventSummaryBody {
	readonly text: string;
	/** Short bullet list of facts the model must remember verbatim. */
	readonly keyFacts: readonly string[];
	/** Open user goals / unfinished items the model must not lose. */
	readonly openItems: readonly string[];
	/** Last user message referenced by the summary; empty string when unknown. */
	readonly lastUserMessage: string;
}

/**
 * Named `ConversationEventSummary` (not `ConversationSummary`) to avoid
 * collision with the existing `ConversationSummary` admin list-row DTO in
 * `embed/public-http.ts`. They are distinct shapes: list rows carry
 * metadata only; this type carries the actual summary content used by
 * Runtime context restore and rollover.
 */
export interface ConversationEventSummary {
	readonly id: string;
	readonly conversationId: string;
	readonly throughSequence: number;
	readonly modelId: string;
	readonly sourceEventCount: number;
	readonly sourceBytes: number;
	readonly body: ConversationEventSummaryBody;
	readonly createdAt: string;
}

/** Rollover response returned by `createConversation` (WB-008 / spec §12.3). */
export interface ConversationRollover {
	readonly conversationId: string;
	/** True when an existing conversation was sealed and this is the new one. */
	readonly rolledOver: boolean;
	/** ID of the conversation that was sealed (always present when rolledOver). */
	readonly previousConversationId: string | null;
	/** Through-sequence at which the rollover happened (always present when rolledOver). */
	readonly rolledOverAtSequence: number | null;
	/** ID of the summary that anchored the rollover (always present when rolledOver). */
	readonly rolloverSummaryId: string | null;
}

/**
 * WB-008: hard limits applied to a single conversation. Operator-tunable.
 * Defaults match spec §12.3. Exceeding any limit triggers rollover to a new
 * conversation (preserving full history; never silent deletion).
 */
export interface ConversationLimits {
	readonly maxConversationEvents: number;
	readonly maxConversationEventBytes: number;
	readonly maxConversationTurns: number;
}

export const DEFAULT_CONVERSATION_LIMITS: ConversationLimits = {
	maxConversationEvents: 5_000,
	maxConversationEventBytes: 20 * 1024 * 1024, // 20 MiB
	maxConversationTurns: 500,
} as const;

/**
 * Pure decision: should this conversation roll over given its latest counters?
 *
 * Pure / no side-effects; callers run it after every append and decide whether
 * to seal the conversation on the next complete turn. The function deliberately
 * does NOT consider in-flight turns: rollover happens only at a complete-turn
 * boundary (spec §12.3 — "current turn not hard-cut").
 */
export function shouldRolloverConversation(
	counters: { readonly eventCount: number; readonly eventBytes: number; readonly turnCount: number },
	limits: ConversationLimits,
): boolean {
	if (counters.eventCount >= limits.maxConversationEvents) return true;
	if (counters.eventBytes >= limits.maxConversationEventBytes) return true;
	if (counters.turnCount >= limits.maxConversationTurns) return true;
	return false;
}
