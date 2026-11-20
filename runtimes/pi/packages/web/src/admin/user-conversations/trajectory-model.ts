import type {
	ConversationAdminDetailResponse,
	ConversationAdminEvent,
	ConversationAdminLlmCallSummary,
} from "@earendil-works/pi-protocol";
import { readableContent } from "./context-inspector-model.ts";
import { asRecord, errorMessage, INTERNAL_TRIGGER_MESSAGE, readString, safeJson } from "./session-view-helpers.ts";

interface RecordBase {
	readonly key: string;
	readonly turnId: string | null;
	readonly time: string;
	readonly completedAt: string | null;
	readonly durationMs: number | null;
	readonly role: "用户" | "助手" | "工具" | "系统";
	readonly title: string;
	readonly preview: string;
	readonly status: string;
	readonly abnormal: boolean;
}
export type TrajectoryNode = RecordBase &
	(
		| {
				readonly kind: "event";
				readonly event: ConversationAdminEvent;
				readonly taskInput?: NonNullable<ConversationAdminDetailResponse["taskInput"]>;
		  }
		| { readonly kind: "model"; readonly call: ConversationAdminLlmCallSummary }
		| {
				readonly kind: "tool";
				readonly events: readonly ConversationAdminEvent[];
				readonly toolCallId: string;
				readonly toolName: string;
				readonly input?: ConversationAdminEvent;
				readonly result?: ConversationAdminEvent;
		  }
	);
const EVENT_LABELS: Readonly<Record<string, string>> = {
	"conversation/created": "对话创建",
	"turn/start": "本轮开始",
	"context/snapshot": "上下文快照",
	"user/message": "用户输入",
	"assistant/start": "助手开始输出",
	"assistant/chunk": "输出片段",
	"assistant/message": "会话回复",
	"attachment/added": "添加附件",
	"citation/updated": "更新引用",
	"turn/end": "本轮完成",
	"turn/failed": "执行失败",
	"turn/interrupted": "执行中断",
	"conversation/summary": "上下文压缩",
	"conversation/rollover": "对话接续",
	"conversation/archived": "对话归档",
	"history/expired": "历史过期",
};
export const CALL_STATUS: Record<ConversationAdminLlmCallSummary["status"], string> = {
	completed: "已完成",
	failed: "失败",
	interrupted: "已中断",
	incomplete: "记录不完整",
	unknown: "状态未知",
};
const TECHNICAL_EVENTS = new Set([
	"conversation/created",
	"turn/start",
	"turn/end",
	"context/snapshot",
	"assistant/start",
	"assistant/chunk",
	"citation/updated",
]);
export function eventContent(event: ConversationAdminEvent): string {
	const payload = asRecord(event.payload);
	if (event.eventType === "tool/error" || event.eventType === "turn/failed" || event.eventType === "turn/interrupted")
		return errorMessage(event.payload);
	if (typeof payload.text === "string") return payload.text;
	if (payload.content !== undefined) return readableContent(payload.content);
	if (payload.arguments !== undefined) return safeJson(payload.arguments);
	if (payload.input !== undefined) return safeJson(payload.input);
	return safeJson(event.payload);
}

function toolTime(event: ConversationAdminEvent): string {
	const payload = asRecord(event.payload);
	const value = event.eventType === "tool/call" ? payload.startedAt : payload.finishedAt;
	if (typeof value === "number" && Number.isFinite(new Date(value).getTime())) return new Date(value).toISOString();
	return event.createdAt;
}

/** Compact business ledger inspired by dsh. All associations use turnId + toolCallId, never proximity. */
export function buildTrajectory(
	events: readonly ConversationAdminEvent[],
	calls: readonly ConversationAdminLlmCallSummary[],
	technical = false,
	taskInput: ConversationAdminDetailResponse["taskInput"] = null,
): readonly TrajectoryNode[] {
	const records: TrajectoryNode[] = [];
	const tools = new Map<string, ConversationAdminEvent[]>();
	const tracedTurns = new Set(calls.map((call) => call.turnId));
	for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
		if (event.eventType === "tool/call" || event.eventType === "tool/result" || event.eventType === "tool/error") {
			const id = readString(asRecord(event.payload), "toolCallId");
			const key = id === "" ? `orphan:${event.eventId}` : `${event.turnId ?? ""}:${id}`;
			const group = tools.get(key);
			if (group) group.push(event);
			else tools.set(key, [event]);
			continue;
		}
		if (
			!technical &&
			(TECHNICAL_EVENTS.has(event.eventType) ||
				(event.eventType === "assistant/message" && event.turnId !== null && tracedTurns.has(event.turnId)))
		)
			continue;
		const payload = asRecord(event.payload);
		const failed = event.eventType === "turn/failed" || event.eventType === "turn/interrupted";
		const trigger = event.eventType === "user/message" && payload.text === INTERNAL_TRIGGER_MESSAGE;
		const externalTask = trigger ? taskInput : null;
		records.push({
			key: `event:${event.eventId}`,
			kind: "event",
			event,
			...(externalTask === null ? {} : { taskInput: externalTask }),
			turnId: event.turnId,
			time: event.createdAt,
			completedAt: null,
			durationMs: null,
			role: event.eventType === "user/message" ? "用户" : event.eventType.startsWith("assistant/") ? "助手" : "系统",
			title:
				externalTask !== null
					? "外部任务（API 输入）"
					: trigger
						? "任务触发（内部消息）"
						: (EVENT_LABELS[event.eventType] ?? event.eventType),
			preview: (externalTask?.text ?? eventContent(event)).slice(0, 300),
			status: failed ? "异常" : "已记录",
			abnormal: failed,
		});
	}
	for (const [key, group] of tools) {
		const input = group.find((event) => event.eventType === "tool/call");
		const result = [...group]
			.reverse()
			.find((event) => event.eventType === "tool/result" || event.eventType === "tool/error");
		const anchor = input ?? result ?? group[0]!;
		const payload = asRecord(anchor.payload);
		const toolName = readString(payload, "toolName") || "未知工具";
		const failed = result?.eventType === "tool/error" || asRecord(result?.payload).isError === true;
		const duration = input && result ? Date.parse(toolTime(result)) - Date.parse(toolTime(input)) : NaN;
		records.push({
			key: `tool:${key}`,
			kind: "tool",
			events: group,
			input,
			result,
			toolCallId: readString(payload, "toolCallId"),
			toolName,
			turnId: anchor.turnId,
			time: toolTime(anchor),
			completedAt: result === undefined ? null : toolTime(result),
			durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
			role: "工具",
			title: toolName,
			preview: `${input ? eventContent(input).slice(0, 140) : "输入未加载"} → ${result ? eventContent(result).slice(0, 180) : "结果未加载 / 未采集"}`,
			status: failed ? "失败" : result ? "已完成" : "结果未知",
			abnormal: failed,
		});
	}
	for (const call of calls)
		records.push({
			key: `model:${call.turnId}:${call.callIndex}`,
			kind: "model",
			call,
			turnId: call.turnId,
			time: call.startedAt,
			completedAt: call.completedAt,
			durationMs: call.durationMs,
			role: "助手",
			title: `请求 #${call.callIndex}`,
			preview:
				call.responsePreview ||
				(call.toolCallNames.length > 0 ? `调用 ${call.toolCallNames.join("、")}` : "暂无输出摘要"),
			status: CALL_STATUS[call.status],
			abnormal: call.status !== "completed",
		});
	return records.sort((a, b) => {
		const ta = Date.parse(a.time),
			tb = Date.parse(b.time);
		const order = (Number.isFinite(ta) ? ta : Infinity) - (Number.isFinite(tb) ? tb : Infinity);
		if (order !== 0 && !Number.isNaN(order)) return order;
		if (a.kind === "event" && b.kind === "event") return a.event.sequence - b.event.sequence;
		if (a.kind === "model" && b.kind === "model")
			return a.call.turnId.localeCompare(b.call.turnId) || a.call.callIndex - b.call.callIndex;
		if (a.kind === "tool" && b.kind === "tool") return a.events[0]!.sequence - b.events[0]!.sequence;
		return a.key.localeCompare(b.key);
	});
}

export function recordMatches(node: TrajectoryNode, query: string): boolean {
	const text =
		node.kind === "tool"
			? node.events.map(eventContent).join("\n")
			: node.kind === "event"
				? (node.taskInput?.text ?? eventContent(node.event))
				: `${node.call.model} ${node.call.toolCallNames.join(" ")}`;
	return `${node.title} ${node.preview} ${node.turnId ?? ""} ${text}`
		.toLowerCase()
		.includes(query.trim().toLowerCase());
}
