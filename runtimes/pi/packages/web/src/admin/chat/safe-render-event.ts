/**
 * Safe transcript event renderer (MVP-04).
 *
 * Renders any `ServerEvent`-shaped object as a renderable transcript entry
 * without ever throwing on unknown event types. Unknown events surface as a
 * "未知事件" placeholder so the UI never crashes mid-stream. Errors thrown
 * by upstream deserialisation are caught and rendered as a system message.
 *
 * The `ChatTranscriptEntry` shape is intentionally loose: it's an admin-only
 * projection used for display, not the canonical server-side
 * `TranscriptItem` (which has a strict schema). This lets us render partial /
 * unknown events safely.
 */

import type { ServerEvent } from "@earendil-works/pi-protocol";

export type ChatTranscriptRole = "user" | "assistant" | "tool" | "system";

export interface ChatTranscriptEntry {
	readonly id: string;
	readonly role: ChatTranscriptRole;
	readonly text: string;
	readonly meta?: Readonly<Record<string, unknown>>;
	readonly timestamp: number;
}

function localId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Convert a server event into a renderable transcript entry. Falls back to a
 * placeholder entry when the event type is unknown or malformed. Never
 * throws.
 */
export function eventToTranscriptEntry(event: unknown): ChatTranscriptEntry {
	if (event === null || typeof event !== "object") {
		return makeSystem("收到非对象事件");
	}
	const value = event as Record<string, unknown>;
	const type = value["type"];
	if (typeof type !== "string") {
		return makeSystem("收到无 type 字段的事件");
	}
	try {
		switch (type) {
			case "user_message":
			case "user.message":
				return makeUser(stringField(value, "text", "(空消息)"));
			case "assistant_message":
			case "assistant.message":
				return makeAssistant(stringField(value, "text", ""));
			case "tool_result":
			case "tool.result":
				return makeTool(stringField(value, "name", "tool"), value);
			case "attachment":
				return makeSystem(`附件：${stringField(value, "name", "未命名附件")}`);
			case "citation":
				return makeSystem(`引用：${stringField(value, "url", "")}`);
			case "error":
				return makeSystem(`错误：${stringField(value, "message", "未知错误")}`);
			default:
				return makeSystem(`未知事件：${type}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : "render failed";
		return makeSystem(`渲染事件失败：${message}`);
	}
}

/**
 * Wrap a list of server events into transcript entries without throwing. Use
 * this anywhere a long-lived WebSocket listener might surface new event
 * shapes after a protocol bump.
 */
export function eventsToTranscript(events: readonly unknown[]): readonly ChatTranscriptEntry[] {
	const out: ChatTranscriptEntry[] = [];
	for (const ev of events) {
		try {
			out.push(eventToTranscriptEntry(ev));
		} catch {
			out.push(makeSystem("事件处理失败"));
		}
	}
	return out;
}

function stringField(obj: Record<string, unknown>, key: string, fallback: string): string {
	const v = obj[key];
	return typeof v === "string" ? v : fallback;
}

function makeUser(text: string): ChatTranscriptEntry {
	return { id: localId("user"), role: "user", text, timestamp: Date.now() };
}

function makeAssistant(text: string): ChatTranscriptEntry {
	return { id: localId("assistant"), role: "assistant", text, timestamp: Date.now() };
}

function makeTool(name: string, payload: Record<string, unknown>): ChatTranscriptEntry {
	return {
		id: localId("tool"),
		role: "tool",
		text: `工具：${name}`,
		meta: { name, payload },
		timestamp: Date.now(),
	};
}

function makeSystem(text: string): ChatTranscriptEntry {
	return { id: localId("system"), role: "system", text, timestamp: Date.now() };
}

/** Type-guard that wraps a server event with strict null safety. */
export function isKnownEvent(event: unknown): event is ServerEvent {
	if (event === null || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && type.length > 0;
}
