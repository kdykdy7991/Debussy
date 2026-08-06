/**
 * Snapshot adapter: converts Coding Agent session state into the protocol
 * `SessionSnapshot` DTO.
 *
 * The adapter walks the session's current branch (no tree/fork UI in MVP) and
 * translates user / assistant / tool-result messages into the corresponding
 * transcript items. Non-message entries (compaction summaries, model changes,
 * thinking-level changes, labels, etc.) are intentionally skipped: those exist
 * as persistence metadata rather than renderable transcript rows.
 *
 * DTOs are constructed via TypeScript type assertions: protocol types already
 * forbid unknown fields and incompatible unions, so a value cast at compile
 * time is sufficient for this adapter. Runtime schema validation happens in the
 * wire codec (`packages/protocol/src/codec.ts`) when the snapshot is encoded.
 */
import type {
	ImageContent as AiImageContent,
	TextContent as AiTextContent,
	ThinkingContent as AiThinkingContent,
	AssistantMessage,
	Message,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	ThinkingContent,
	ThinkingLevel,
	ToolTranscriptItem,
	TranscriptItem,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";

/**
 * Optional entry point passed in by the runtime: the runtime knows the live
 * model/thinking/phase that may not yet be reflected in the persisted entries
 * (e.g. the first assistant turn has not been appended yet).
 */
export interface RuntimeHints {
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
	phase?: SessionPhase;
	createdAt?: number;
	updatedAt?: number;
}

type AssistantContentItem =
	| { type: "text"; text: string }
	| ThinkingContent
	| { type: "toolCall"; toolCallId: string; toolName: string; input: JsonValue };

type UserContentItem = { type: "text"; text: string } | AiImageContent;

function toAssistantContent(part: AiTextContent | AiThinkingContent | ToolCall): AssistantContentItem {
	if (part.type === "text") {
		return { type: "text", text: part.text };
	}
	if (part.type === "thinking") {
		const value: ThinkingContent = {
			type: "thinking",
			thinking: part.thinking,
			...(part.redacted ? { redacted: true } : {}),
		};
		return value;
	}
	return {
		type: "toolCall",
		toolCallId: part.id,
		toolName: part.name,
		input: sanitizeJson(part.arguments) as JsonValue,
	};
}

function userItemFromMessage(message: UserMessage, timestamp: number): UserTranscriptItem {
	const content = userContentFromMessage(message);
	return {
		id: `user-${message.timestamp}`,
		role: "user",
		content,
		timestamp,
	};
}

function userContentFromMessage(message: UserMessage): UserContentItem[] {
	if (typeof message.content === "string") {
		return [{ type: "text", text: message.content }];
	}
	const out: UserContentItem[] = [];
	for (const part of message.content) {
		if (part.type === "text") {
			out.push({ type: "text", text: part.text });
		} else {
			out.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
	return out;
}

function assistantItemFromMessage(message: AssistantMessage, timestamp: number): AssistantTranscriptItem {
	const content = message.content.map(toAssistantContent);
	const base = {
		id: `assistant-${message.timestamp}`,
		role: "assistant" as const,
		content,
		model: { provider: message.provider, id: message.model } satisfies ModelRef,
		responseModel: message.responseModel,
		usage: toProtocolUsage(message.usage),
		timestamp,
	};
	switch (message.stopReason) {
		case "stop":
		case "length":
		case "toolUse":
			return {
				...base,
				status: "complete",
				stopReason: message.stopReason,
			};
		case "error":
			return {
				...base,
				status: "error",
				stopReason: "error",
				errorMessage: message.errorMessage,
			};
		case "aborted":
			return {
				...base,
				status: "aborted",
				stopReason: "aborted",
				errorMessage: message.errorMessage,
			};
		default:
			return {
				...base,
				status: "streaming",
			};
	}
}

function toolItemFromMessage(message: ToolResultMessage, timestamp: number): ToolTranscriptItem {
	const content = message.content.map(toToolContent);
	const base = {
		id: `tool-${message.timestamp}`,
		role: "tool" as const,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		input: null as JsonValue,
		content,
		details: sanitizeJson(message.details) as JsonValue | undefined,
		usage: toProtocolUsage(message.usage),
		timestamp,
	};
	if (message.isError) {
		return {
			...base,
			status: "error",
			isError: true,
		};
	}
	return {
		...base,
		status: "complete",
		isError: false,
	};
}

function toToolContent(part: AiTextContent | AiImageContent): ToolTranscriptItem["content"][number] {
	if (part.type === "text") {
		return { type: "text", text: part.text };
	}
	return { type: "image", data: part.data, mimeType: part.mimeType };
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Walk an unknown value and drop anything that does not match the JSON value
 * schema (undefined, functions, symbols, circular refs). This keeps tool
 * arguments inside the protocol's JsonValue contract even when extensions stash
 * non-serialisable state on `ToolCall.arguments` or `ToolResultMessage.details`.
 */
function sanitizeJson(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null) return null;
	const type = typeof value;
	if (type === "string" || type === "boolean") return value;
	if (type === "number") return Number.isFinite(value) ? value : null;
	if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") return null;
	if (type !== "object") return null;
	if (seen.has(value as object)) return null;
	seen.add(value as object);
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeJson(item, seen));
	}
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		const cleaned = sanitizeJson(raw, seen);
		if (cleaned !== undefined) out[key] = cleaned;
	}
	return out;
}

function toProtocolUsage(usage: Usage | undefined): AssistantTranscriptItem["usage"] {
	if (!usage) return undefined;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		reasoning: usage.reasoning,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}

/**
 * Build a `SessionSnapshot` from a `SessionManager` and optional runtime hints.
 *
 * The `phase`, `model`, `thinkingLevel`, `attached`, `locked`, and timestamps
 * are authoritative from the live runtime, not from any single persisted entry.
 */
export function buildSessionSnapshot(sessionManager: SessionManager, hints: RuntimeHints = {}): SessionSnapshot {
	const sessionId = sessionManager.getSessionId();
	const cwd = sessionManager.getCwd();
	const name = sessionManager.getSessionName();
	const branch = sessionManager.getBranch();
	const model = hints.model ?? defaultModelRef(sessionManager);
	const thinkingLevel = hints.thinkingLevel ?? defaultThinkingLevel(sessionManager);
	const phase = hints.phase ?? "idle";
	const createdAt = hints.createdAt ?? readHeaderTimestamp(sessionManager);
	const updatedAt = hints.updatedAt ?? Math.max(createdAt, lastEntryTimestamp(branch));
	const transcript = branch
		.map((entry) => toTranscriptItem(entry))
		.filter((item): item is TranscriptItem => item !== null);
	return {
		id: sessionId,
		name,
		cwd,
		createdAt,
		updatedAt,
		phase,
		model,
		thinkingLevel,
		attached: false,
		locked: false,
		lastSequence: 0,
		revision: branch.length,
		transcript,
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}

function toTranscriptItem(entry: ReturnType<SessionManager["getBranch"]>[number]): TranscriptItem | null {
	if (entry.type !== "message") return null;
	if (!isStandardMessage(entry.message)) return null;
	return messageToTranscriptItem(entry.message, entry.timestamp);
}

function isStandardMessage(message: { role: string }): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function messageToTranscriptItem(message: Message, rawTimestamp: string): TranscriptItem {
	const timestamp = parseEntryTimestamp(rawTimestamp);
	if (message.role === "user") return userItemFromMessage(message, timestamp);
	if (message.role === "assistant") return assistantItemFromMessage(message, timestamp);
	return toolItemFromMessage(message, timestamp);
}

function parseEntryTimestamp(rawTimestamp: string): number {
	const millis = Date.parse(rawTimestamp);
	if (Number.isFinite(millis)) return Math.max(0, Math.floor(millis));
	return 0;
}

function lastEntryTimestamp(entries: ReturnType<SessionManager["getBranch"]>): number {
	let latest = 0;
	for (const entry of entries) {
		const ts = parseEntryTimestamp(entry.timestamp);
		if (ts > latest) latest = ts;
	}
	return latest;
}

function readHeaderTimestamp(sessionManager: SessionManager): number {
	const header = sessionManager.getHeader();
	if (!header) return Math.floor(Date.now());
	return parseEntryTimestamp(header.timestamp);
}

function defaultModelRef(sessionManager: SessionManager): ModelRef {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry && entry.type === "model_change") {
			return { provider: entry.provider, id: entry.modelId };
		}
	}
	const context = sessionManager.buildSessionContext();
	if (context.model) {
		return { provider: context.model.provider, id: context.model.modelId };
	}
	return { provider: "unknown", id: "unknown" };
}

function defaultThinkingLevel(sessionManager: SessionManager): ThinkingLevel {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry && entry.type === "thinking_level_change") {
			const raw = entry.thinkingLevel;
			if (
				raw === "off" ||
				raw === "minimal" ||
				raw === "low" ||
				raw === "medium" ||
				raw === "high" ||
				raw === "xhigh" ||
				raw === "max"
			) {
				return raw;
			}
		}
	}
	return "off";
}

export const __testing = { sanitizeJson, toAssistantContent, userContentFromMessage, toToolContent };
