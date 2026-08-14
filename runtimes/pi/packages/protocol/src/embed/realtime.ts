/**
 * Embed Realtime v1 协议（spec 9 + 25.3，TASK-023）。
 *
 * 客户端命令与服务端事件的唯一类型与运行时 Decoder。Web 与 Server 共用
 * 本模块：任何 `JSON.parse()` 结果都必须先经 `decodeClientCommand` /
 * `decodeServerEvent` 校验，禁止直接断言为业务类型（TASK-023 禁止条件）。
 *
 * 限制（spec 9.3 / 8.3）：文本长度、attachment 数量、requestId 长度、
 * sequence 非负整数；未知 type 返回稳定的协议错误码。
 */

/** 客户端命令（spec 9.1）。 */
export type ClientCommand =
	| { readonly type: "conversation.subscribe"; readonly conversationId: string; readonly lastSeenSequence?: number }
	| {
			readonly type: "turn.start";
			readonly requestId: string;
			readonly conversationId: string;
			readonly message: { readonly text: string; readonly attachmentIds: readonly string[] };
			readonly lastSeenSequence: number;
	  }
	| {
			readonly type: "turn.cancel";
			readonly requestId?: string;
			readonly conversationId: string;
			readonly turnId?: string;
	  }
	| { readonly type: "conversation.sync"; readonly conversationId: string; readonly lastSeenSequence: number }
	| { readonly type: "client.ack"; readonly conversationId: string; readonly sequence: number };

/** 服务端事件（spec 9.2）；每个可恢复事件带 conversationId/sequence/turnId/eventId/timestamp。 */
export type EmbedServerEvent =
	| (RecoverableEventBase & { readonly type: "conversation.snapshot"; readonly payload: unknown })
	| (RecoverableEventBase & { readonly type: "turn.accepted" })
	| (RecoverableEventBase & { readonly type: "message.delta"; readonly text: string })
	| (RecoverableEventBase & { readonly type: "message.completed"; readonly text: string })
	| (RecoverableEventBase & { readonly type: "tool.started"; readonly tool: string })
	| (RecoverableEventBase & { readonly type: "tool.completed"; readonly tool: string; readonly ok: boolean })
	| (RecoverableEventBase & { readonly type: "citation.updated"; readonly citations: readonly unknown[] })
	| (RecoverableEventBase & {
			readonly type: "usage.updated";
			readonly usage: { readonly input: number; readonly output: number };
	  })
	| (RecoverableEventBase & { readonly type: "turn.failed"; readonly error: string })
	| (RecoverableEventBase & { readonly type: "turn.cancelled"; readonly reason?: string })
	| (RecoverableEventBase & { readonly type: "runtime.status"; readonly status: string });

/** 可恢复事件必须携带的字段（spec 9.2）。 */
export interface RecoverableEventBase {
	readonly conversationId: string;
	readonly sequence: number;
	readonly turnId: string | null;
	readonly eventId: string;
	readonly timestamp: string;
}

/** 解码错误码（稳定、可机器处理）。 */
export type RealtimeDecodeErrorCode = "NOT_OBJECT" | "UNKNOWN_TYPE" | "INVALID_FIELD" | "TOO_LONG";

export interface RealtimeDecodeError {
	readonly code: RealtimeDecodeErrorCode;
	readonly message: string;
}

export type RealtimeDecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: RealtimeDecodeError };

/** 平台限制（与 spec 27.5 / PD-09 对齐）。 */
export const REALTIME_LIMITS = {
	maxTextChars: 32_000,
	maxAttachmentIds: 10,
	maxRequestIdChars: 128,
} as const;

const KNOWN_CLIENT_TYPES = new Set([
	"conversation.subscribe",
	"turn.start",
	"turn.cancel",
	"conversation.sync",
	"client.ack",
]);
const KNOWN_SERVER_TYPES = new Set([
	"conversation.snapshot",
	"turn.accepted",
	"message.delta",
	"message.completed",
	"tool.started",
	"tool.completed",
	"citation.updated",
	"usage.updated",
	"turn.failed",
	"turn.cancelled",
	"runtime.status",
]);

/** 解码一条客户端命令（spec 9.1）。 */
export function decodeClientCommand(input: unknown): RealtimeDecodeResult<ClientCommand> {
	const record = asRecord(input);
	if (record === null) return err("NOT_OBJECT", "message must be a JSON object");
	const type = record.type;
	if (typeof type !== "string" || !KNOWN_CLIENT_TYPES.has(type)) {
		return err("UNKNOWN_TYPE", `unknown client command type: ${JSON.stringify(type)}`);
	}
	try {
		switch (type) {
			case "conversation.subscribe":
				return ok({
					type: "conversation.subscribe",
					conversationId: stringField(record, "conversationId"),
					...(optionalInt(record, "lastSeenSequence") !== undefined
						? { lastSeenSequence: optionalInt(record, "lastSeenSequence") as number }
						: {}),
				});
			case "turn.start": {
				const requestId = stringField(record, "requestId", REALTIME_LIMITS.maxRequestIdChars);
				const message = asRecord(record.message);
				if (message === null) return err("INVALID_FIELD", "message must be an object");
				const text = stringField(message, "text");
				const attachmentIds = stringArrayField(message, "attachmentIds");
				return ok({
					type: "turn.start",
					requestId,
					conversationId: stringField(record, "conversationId"),
					message: { text, attachmentIds },
					lastSeenSequence: nonNegativeIntField(record, "lastSeenSequence"),
				});
			}
			case "turn.cancel":
				return ok({
					type: "turn.cancel",
					conversationId: stringField(record, "conversationId"),
					...(record.requestId !== undefined
						? { requestId: stringField(record, "requestId", REALTIME_LIMITS.maxRequestIdChars) }
						: {}),
					...(record.turnId !== undefined ? { turnId: stringField(record, "turnId") } : {}),
				});
			case "conversation.sync":
				return ok({
					type: "conversation.sync",
					conversationId: stringField(record, "conversationId"),
					lastSeenSequence: nonNegativeIntField(record, "lastSeenSequence"),
				});
			case "client.ack":
				return ok({
					type: "client.ack",
					conversationId: stringField(record, "conversationId"),
					sequence: nonNegativeIntField(record, "sequence"),
				});
		}
	} catch (error) {
		return error instanceof RealtimeValidationError
			? { ok: false, error: { code: error.code, message: error.message } }
			: err("INVALID_FIELD", "malformed command");
	}
	return err("UNKNOWN_TYPE", `unhandled client command type: ${type}`);
}

/** 解码一条服务端事件（spec 9.2）。 */
export function decodeServerEvent(input: unknown): RealtimeDecodeResult<EmbedServerEvent> {
	const record = asRecord(input);
	if (record === null) return err("NOT_OBJECT", "event must be a JSON object");
	const type = record.type;
	if (typeof type !== "string" || !KNOWN_SERVER_TYPES.has(type)) {
		return err("UNKNOWN_TYPE", `unknown server event type: ${JSON.stringify(type)}`);
	}
	try {
		const base = {
			conversationId: stringField(record, "conversationId"),
			sequence: nonNegativeIntField(record, "sequence"),
			turnId: nullableStringField(record, "turnId"),
			eventId: stringField(record, "eventId"),
			timestamp: stringField(record, "timestamp"),
		};
		switch (type) {
			case "conversation.snapshot":
				return ok({ ...base, type: "conversation.snapshot", payload: record.payload });
			case "turn.accepted":
				return ok({ ...base, type: "turn.accepted" });
			case "message.delta":
			case "message.completed":
				return ok({ ...base, type, text: stringField(record, "text") });
			case "tool.started":
				return ok({ ...base, type: "tool.started", tool: stringField(record, "tool") });
			case "tool.completed":
				return ok({
					...base,
					type: "tool.completed",
					tool: stringField(record, "tool"),
					ok: booleanField(record, "ok"),
				});
			case "citation.updated":
				return ok({ ...base, type: "citation.updated", citations: arrayField(record, "citations") });
			case "usage.updated": {
				const usage = asRecord(record.usage);
				if (usage === null) return err("INVALID_FIELD", "usage must be an object");
				return ok({
					...base,
					type: "usage.updated",
					usage: { input: nonNegativeIntField(usage, "input"), output: nonNegativeIntField(usage, "output") },
				});
			}
			case "turn.failed":
				return ok({ ...base, type: "turn.failed", error: stringField(record, "error") });
			case "turn.cancelled":
				return ok({
					...base,
					type: "turn.cancelled",
					...(record.reason !== undefined ? { reason: stringField(record, "reason") } : {}),
				});
			case "runtime.status":
				return ok({ ...base, type: "runtime.status", status: stringField(record, "status") });
		}
	} catch (error) {
		return error instanceof RealtimeValidationError
			? { ok: false, error: { code: error.code, message: error.message } }
			: err("INVALID_FIELD", "malformed event");
	}
	return err("UNKNOWN_TYPE", `unhandled server event type: ${type}`);
}

class RealtimeValidationError extends Error {
	readonly code: RealtimeDecodeErrorCode;
	constructor(code: RealtimeDecodeErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

function ok<T>(value: T): RealtimeDecodeResult<T> {
	return { ok: true, value };
}

function err(code: RealtimeDecodeErrorCode, message: string): RealtimeDecodeResult<never> {
	return { ok: false, error: { code, message } };
}

function asRecord(input: unknown): Record<string, unknown> | null {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
	return input as Record<string, unknown>;
}

function stringField(
	record: Record<string, unknown>,
	key: string,
	maxChars: number = REALTIME_LIMITS.maxTextChars,
): string {
	const value = record[key];
	if (typeof value !== "string") throw new RealtimeValidationError("INVALID_FIELD", `${key} must be a string`);
	if (value.length > maxChars) {
		throw new RealtimeValidationError("TOO_LONG", `${key} exceeds ${maxChars} characters`);
	}
	return value;
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (value === null) return null;
	return stringField(record, key);
}

function nonNegativeIntField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new RealtimeValidationError("INVALID_FIELD", `${key} must be a non-negative integer`);
	}
	return value;
}

function optionalInt(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return nonNegativeIntField(record, key);
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") throw new RealtimeValidationError("INVALID_FIELD", `${key} must be a boolean`);
	return value;
}

function stringArrayField(record: Record<string, unknown>, key: string): readonly string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new RealtimeValidationError("INVALID_FIELD", `${key} must be an array of strings`);
	}
	if (value.length > REALTIME_LIMITS.maxAttachmentIds) {
		throw new RealtimeValidationError("TOO_LONG", `${key} exceeds ${REALTIME_LIMITS.maxAttachmentIds} entries`);
	}
	return value as readonly string[];
}

function arrayField(record: Record<string, unknown>, key: string): readonly unknown[] {
	const value = record[key];
	if (!Array.isArray(value)) throw new RealtimeValidationError("INVALID_FIELD", `${key} must be an array`);
	return value;
}
