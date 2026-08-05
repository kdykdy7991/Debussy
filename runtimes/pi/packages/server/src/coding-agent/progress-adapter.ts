/**
 * Progress adapter: converts Coding Agent events into the protocol
 * `TranscriptProgress` DTOs.
 *
 * Subscribing to an `AgentSession` yields a stream of events whose lifecycle
 * matches the wire protocol:
 *
 *   message_start (assistant)        → item_started (assistant, streaming)
 *   message_update (text/thinking)   → assistant_delta
 *   message_update (toolcall)        → assistant_delta (kind=toolCall)
 *   tool_execution_start             → item_started (tool, running)
 *   tool_execution_update            → item_updated
 *   tool_execution_end               → item_finished
 *   message_end (assistant)          → item_finished
 *
 * The adapter is the sole place where these mappings live; everything else in
 * the server treats events as opaque `TranscriptProgress` values.
 */
import type {
	TextContent as AiTextContent,
	ThinkingContent as AiThinkingContent,
	AssistantMessage,
	ToolCall,
} from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ToolTranscriptItem,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";

/** Listeners receive one normalised `TranscriptProgress` per AgentSession event. */
export type ProgressListener = (progress: TranscriptProgress) => void;

/** Convert an AgentSession event stream into a `TranscriptProgress` stream. */
export function subscribeToAgentSession(session: AgentSession, listener: ProgressListener): () => void {
	return session.subscribe((event) => {
		const progress = convertEvent(event);
		if (progress) listener(progress);
	});
}

function convertEvent(event: AgentSessionEvent): TranscriptProgress | null {
	switch (event.type) {
		case "message_start": {
			if (!isAssistantMessage(event.message)) return null;
			return {
				type: "item_started",
				item: assistantFromMessage(event.message, "streaming"),
			} as TranscriptProgress;
		}
		case "message_update": {
			if (!isAssistantMessage(event.message)) return null;
			const inner = event.assistantMessageEvent;
			if (inner.type === "text_delta") {
				return {
					type: "assistant_delta",
					messageId: assistantMessageId(event.message),
					contentIndex: inner.contentIndex,
					kind: "text",
					delta: inner.delta,
				};
			}
			if (inner.type === "thinking_delta") {
				return {
					type: "assistant_delta",
					messageId: assistantMessageId(event.message),
					contentIndex: inner.contentIndex,
					kind: "thinking",
					delta: inner.delta,
				};
			}
			if (inner.type === "toolcall_delta") {
				return {
					type: "assistant_delta",
					messageId: assistantMessageId(event.message),
					contentIndex: inner.contentIndex,
					kind: "toolCall",
					delta: inner.delta,
				};
			}
			return null;
		}
		case "message_end": {
			if (!isAssistantMessage(event.message)) return null;
			const finalStatus = finalAssistantStatus(event.message);
			if (finalStatus === "complete" || finalStatus === "error" || finalStatus === "aborted") {
				return {
					type: "item_finished",
					item: assistantFromMessage(event.message, finalStatus),
				} as TranscriptProgress;
			}
			return null;
		}
		case "tool_execution_start":
			return {
				type: "item_started",
				item: toolItem(event.toolCallId, event.toolName, [], event.args, "running", Date.now()),
			} as TranscriptProgress;
		case "tool_execution_update":
			return {
				type: "item_updated",
				item: toolItem(
					event.toolCallId,
					event.toolName,
					extractToolContent(event.partialResult),
					event.args,
					"running",
					Date.now(),
				),
			} as TranscriptProgress;
		case "tool_execution_end":
			return {
				type: "item_finished",
				item: toolItem(
					event.toolCallId,
					event.toolName,
					extractToolContent(event.result),
					undefined,
					event.isError ? "error" : "complete",
					Date.now(),
				),
			} as TranscriptProgress;
		default:
			return null;
	}
}

function isAssistantMessage(message: { role: string }): message is AssistantMessage {
	return message.role === "assistant" && "provider" in message && "model" in message;
}

function finalAssistantStatus(message: AssistantMessage): "complete" | "error" | "aborted" | "pending" {
	switch (message.stopReason) {
		case "stop":
		case "length":
		case "toolUse":
			return "complete";
		case "error":
			return "error";
		case "aborted":
			return "aborted";
		default:
			return "pending";
	}
}

function assistantFromMessage(
	message: AssistantMessage,
	status: "streaming" | "complete" | "error" | "aborted",
): AssistantTranscriptItem {
	const content = message.content.map(toAssistantContent);
	const base = {
		id: `assistant-${message.timestamp}`,
		role: "assistant" as const,
		content,
		model: { provider: message.provider, id: message.model },
		responseModel: message.responseModel,
		usage: toProtocolUsage(message.usage),
		timestamp: message.timestamp,
	};
	if (status === "complete") {
		const stopReason: "stop" | "length" | "toolUse" =
			message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse"
				? message.stopReason
				: "stop";
		return { ...base, status, stopReason } as AssistantTranscriptItem;
	}
	if (status === "error") {
		return {
			...base,
			status,
			stopReason: "error",
			errorMessage: message.errorMessage,
		} as AssistantTranscriptItem;
	}
	if (status === "aborted") {
		return {
			...base,
			status,
			stopReason: "aborted",
			errorMessage: message.errorMessage,
		} as AssistantTranscriptItem;
	}
	return { ...base, status: "streaming" } as AssistantTranscriptItem;
}

function toolItem(
	toolCallId: string,
	toolName: string,
	content: ToolTranscriptItem["content"],
	input: unknown,
	status: "running" | "complete" | "error",
	timestamp: number,
): ToolTranscriptItem {
	if (status === "error") {
		return {
			id: `tool-${toolCallId}`,
			role: "tool",
			toolCallId,
			toolName,
			input: input === undefined ? null : (sanitizeJson(input) as JsonValue),
			content,
			status: "error",
			isError: true,
			timestamp,
		} as ToolTranscriptItem;
	}
	if (status === "complete") {
		return {
			id: `tool-${toolCallId}`,
			role: "tool",
			toolCallId,
			toolName,
			input: input === undefined ? null : (sanitizeJson(input) as JsonValue),
			content,
			status: "complete",
			isError: false,
			timestamp,
		} as ToolTranscriptItem;
	}
	return {
		id: `tool-${toolCallId}`,
		role: "tool",
		toolCallId,
		toolName,
		input: input === undefined ? null : (sanitizeJson(input) as JsonValue),
		content,
		status: "running",
		isError: false,
		timestamp,
	} as ToolTranscriptItem;
}

function extractToolContent(result: unknown): ToolTranscriptItem["content"] {
	if (result === undefined || result === null) return [];
	if (typeof result === "string") {
		return [{ type: "text", text: result }];
	}
	if (Array.isArray(result)) {
		const out: ToolTranscriptItem["content"] = [];
		for (const item of result) {
			const mapped = mapToolContentItem(item);
			if (mapped) out.push(mapped);
		}
		return out;
	}
	if (typeof result === "object") {
		const obj = result as { content?: unknown };
		if (Array.isArray(obj.content)) {
			return obj.content
				.map((item) => mapToolContentItem(item))
				.filter((item): item is ToolTranscriptItem["content"][number] => item !== undefined);
		}
	}
	return [{ type: "text", text: stringifyUnknown(result) }];
}

function mapToolContentItem(item: unknown): ToolTranscriptItem["content"][number] | undefined {
	if (!item || typeof item !== "object") return undefined;
	const obj = item as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown };
	if (obj.type === "text" && typeof obj.text === "string") {
		return { type: "text", text: obj.text };
	}
	if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string") {
		return { type: "image", data: obj.data, mimeType: obj.mimeType };
	}
	return undefined;
}

function stringifyUnknown(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function toAssistantContent(
	part: AiTextContent | AiThinkingContent | ToolCall,
): AssistantTranscriptItem["content"][number] {
	if (part.type === "text") {
		return { type: "text", text: part.text };
	}
	if (part.type === "thinking") {
		return {
			type: "thinking",
			thinking: part.thinking,
			...(part.redacted ? { redacted: true } : {}),
		};
	}
	return {
		type: "toolCall",
		toolCallId: part.id,
		toolName: part.name,
		input: sanitizeJson(part.arguments) as JsonValue,
	};
}

function assistantMessageId(message: AssistantMessage): string {
	return `assistant-${message.timestamp}`;
}

function toProtocolUsage(usage: AssistantMessage["usage"]): AssistantTranscriptItem["usage"] {
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

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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

export const __testing = { convertEvent, extractToolContent, sanitizeJson };
