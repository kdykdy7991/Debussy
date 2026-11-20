/**
 * Session V1 — Chat / Trajectory 视图单测。
 *
 * 覆盖：
 * 1. 一次任务触发 5 次 LLM + 4 次工具调用：任务输入只出现一次、过程折叠、
 *    最终结果依据真实终态事件独立展示；
 * 2. AaaS `legacy_prompt`：task_prompt 作为「外部任务」，内部固定触发消息被抑制；
 *    其它契约使用真实 `user/message`；
 * 3. 终态判定（failed / interrupted / 无文本 / 进行中）；
 * 4. 上下文压缩只作为事实标识，历史消息仍然可见；
 * 5. 工具事件按 `toolCallId` 关联；
 * 6. Trace 完整性提示不得把无法核对的记录标为完整。
 */
import type {
	ConversationAdminDetailResponse,
	ConversationAdminEvent,
	ConversationAdminSummary,
	ConversationAdminSummaryEntry,
	ConversationLlmTraceStatus,
} from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatView } from "../../../src/admin/user-conversations/chat-view.tsx";
import {
	buildChatTurns,
	INTERNAL_TRIGGER_MESSAGE,
	toolEventsForIds,
} from "../../../src/admin/user-conversations/session-view-helpers.ts";
import { traceNotice } from "../../../src/admin/user-conversations/trajectory-view.tsx";

const CONVERSATION_ID = "conv_11111111-1111-1111-1111-111111111111";
const TURN_ID = "turn_22222222-2222-2222-2222-222222222222";

let sequence = 0;
function event(
	eventType: string,
	payload: unknown,
	options: { readonly turnId?: string | null } = {},
): ConversationAdminEvent {
	sequence += 1;
	return {
		eventId: `evt_${String(sequence).padStart(12, "0")}` as ConversationAdminEvent["eventId"],
		conversationId: CONVERSATION_ID as ConversationAdminEvent["conversationId"],
		sequence,
		eventType,
		kind: eventType as ConversationAdminEvent["kind"],
		schemaVersion: 1,
		turnId: options.turnId === undefined ? TURN_ID : options.turnId,
		payload,
		createdAt: new Date(2026, 0, 1, 0, 0, sequence).toISOString(),
		payloadBytes: 32,
	};
}

function summary(throughSequence: number): ConversationAdminSummaryEntry {
	return {
		summaryId: "csum_1",
		throughSequence,
		modelId: "qwen3-32b",
		sourceEventCount: 4,
		sourceBytes: 100,
		lastUserMessage: "上一轮",
		keyFacts: [],
		openItems: [],
		createdAt: new Date(2026, 0, 1).toISOString(),
	};
}

function detail(overrides: Partial<ConversationAdminDetailResponse> = {}): ConversationAdminDetailResponse {
	const conversation: ConversationAdminSummary = {
		configurationSource: "chat",
		id: CONVERSATION_ID as ConversationAdminSummary["id"],
		appId: "app_1" as ConversationAdminSummary["appId"],
		publicAppId: "pub_1" as ConversationAdminSummary["publicAppId"],
		appName: "Demo",
		agentId: "agent_1" as ConversationAdminSummary["agentId"],
		principalDisplayId: "prn_1",
		principalType: "external_user",
		publishedAppVersionId: "pav_1" as ConversationAdminSummary["publishedAppVersionId"],
		title: "",
		status: "active",
		messageCount: 2,
		errorCount: 0,
		lastEventSequence: 10,
		createdAt: new Date(2026, 0, 1).toISOString(),
		lastActiveAt: new Date(2026, 0, 1).toISOString(),
	};
	return {
		conversation,
		rollover: { previousConversationId: null, nextConversationId: null, rolledOverAt: null },
		latestSummary: null,
		source: "chat",
		requestContract: null,
		taskInput: null,
		trace: {
			available: false,
			reason: "chat_untraced",
			recordedCalls: 0,
			expectedCalls: null,
			coverage: "unknown",
		},
		...overrides,
	};
}

function reactEvents(): readonly ConversationAdminEvent[] {
	return [
		event("turn/start", { model: "qwen3-32b" }),
		event("user/message", { text: "帮我查一下今天的告警" }),
		...[1, 2, 3, 4].map((index) =>
			event("tool/call", { toolCallId: `tc_${index}`, toolName: `tool_${index}`, status: "running" }),
		),
		...[1, 2, 3, 4].map((index) =>
			event("tool/result", {
				toolCallId: `tc_${index}`,
				toolName: `tool_${index}`,
				status: "complete",
				content: [{ type: "text", text: `结果 ${index}` }],
			}),
		),
		event("assistant/message", { text: "共 4 条告警，结论如下", thinking: "先聚合再判断" }),
		event("turn/end", {
			ok: true,
			llmUsage: {
				calls: [],
				total: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
				callCount: 5,
				partial: false,
			},
		}),
	];
}

describe("Session V1 · Chat 视图：Turn 投影", () => {
	it("5 次 LLM + 4 次工具：任务输入一次、过程可折叠、最终结果独立", () => {
		const turns = buildChatTurns(reactEvents(), detail(), []);
		expect(turns).toHaveLength(1);
		const turn = turns[0]!;
		expect(turn.inputText).toBe("帮我查一下今天的告警");
		expect(turn.llmCalls).toBe(5);
		expect(turn.toolCalls).toBe(4);
		expect(turn.toolErrors).toBe(0);
		expect(turn.finalKind).toBe("text");
		expect(turn.finalText).toBe("共 4 条告警，结论如下");
		expect(turn.thinking).toBe("先聚合再判断");
		expect(turn.toolResults).toHaveLength(4);
	});

	it("AaaS legacy_prompt：task_prompt 是外部任务，内部触发消息被抑制", () => {
		const events = [
			event("user/message", { text: INTERNAL_TRIGGER_MESSAGE }),
			event("assistant/message", { text: "研判报告" }),
			event("turn/end", { ok: true }),
		];
		const turns = buildChatTurns(
			events,
			detail({
				source: "orchestration",
				requestContract: "legacy_prompt",
				taskInput: { kind: "external_task", text: "卫星分析规则" },
			}),
			[],
		);
		const turn = turns[0]!;
		expect(turn.inputLabel).toBe("外部任务");
		expect(turn.inputText).toBe("卫星分析规则");
		expect(turn.triggerSuppressed).toBe(true);
		expect(turn.finalText).toBe("研判报告");
	});

	it("其它 AaaS 契约与普通 Chat：直接展示真实 user/message", () => {
		const events = [event("user/message", { text: "真实业务输入" }), event("turn/end", { ok: true })];
		const turns = buildChatTurns(events, detail({ source: "orchestration", requestContract: "input_v1" }), []);
		expect(turns[0]!.inputLabel).toBe("外部任务");
		expect(turns[0]!.inputText).toBe("真实业务输入");
		expect(turns[0]!.triggerSuppressed).toBe(false);
	});

	it("同一会话中的其它 Turn 不借用 task_prompt", () => {
		const events = [
			event("user/message", { text: "把上面的结论整理成对外研判报告" }, { turnId: "turn_other" }),
			event("turn/end", { ok: true }, { turnId: "turn_other" }),
		];
		const turns = buildChatTurns(
			events,
			detail({
				source: "orchestration",
				requestContract: "legacy_prompt",
				taskInput: { kind: "external_task", text: "卫星分析规则" },
			}),
			[],
		);
		expect(turns[0]!.inputText).toBe("把上面的结论整理成对外研判报告");
		expect(turns[0]!.triggerSuppressed).toBe(false);
	});

	it("最终结果只依据真实终态事件，不把最后一条 Assistant 消息当作答案", () => {
		const failed = buildChatTurns(
			[event("assistant/message", { text: "半成品" }), event("turn/failed", { error: "provider exploded" })],
			detail(),
			[],
		);
		expect(failed[0]!.finalKind).toBe("failed");
		expect(failed[0]!.finalText).toBe("provider exploded");

		const interrupted = buildChatTurns(
			[event("assistant/message", { text: "半成品" }), event("turn/interrupted", { error: "cancelled" })],
			detail(),
			[],
		);
		expect(interrupted[0]!.finalKind).toBe("interrupted");

		const noText = buildChatTurns([event("turn/end", { ok: true })], detail(), []);
		expect(noText[0]!.finalKind).toBe("completed_no_text");

		const running = buildChatTurns([event("user/message", { text: "还在跑" })], detail(), []);
		expect(running[0]!.finalKind).toBe("in_progress");
	});

	it("上下文压缩只作为事实标识，历史消息仍然可见", () => {
		const turns = buildChatTurns(reactEvents(), detail(), [summary(9999)]);
		expect(turns[0]!.compacted).toBe(true);
		expect(turns[0]!.inputText).toBe("帮我查一下今天的告警");
		expect(turns[0]!.finalText).toBe("共 4 条告警，结论如下");
	});
});

describe("Session V1 · 工具关联与 Trace 提示", () => {
	it("工具事件按 toolCallId 关联，而不是按时间顺序", () => {
		const events = [
			event("tool/call", { toolCallId: "tc_1", toolName: "alpha" }),
			event("tool/result", { toolCallId: "tc_2", toolName: "beta" }),
		];
		const matched = toolEventsForIds(events, ["tc_2"]);
		expect(matched).toHaveLength(1);
		expect(matched[0]!.eventType).toBe("tool/result");
		expect(toolEventsForIds(events, ["missing"])).toHaveLength(0);
	});

	it("Trace 完整性提示不会把无法核对的记录标为完整", () => {
		const unknown: ConversationLlmTraceStatus = {
			available: true,
			reason: "collected",
			recordedCalls: 3,
			expectedCalls: null,
			coverage: "unknown",
		};
		expect(traceNotice(unknown)).toContain("不得视为完整记录");
		expect(traceNotice({ ...unknown, reason: "table_missing", available: false, recordedCalls: 0 })).toContain(
			"未部署",
		);
		expect(traceNotice({ ...unknown, reason: "chat_untraced", available: false })).toContain("未启用");
		expect(traceNotice({ ...unknown, reason: "no_records", available: false })).toContain("没有逐次请求记录");
		expect(traceNotice({ ...unknown, coverage: "partial", expectedCalls: 5 })).toContain("不完整");
		expect(traceNotice({ ...unknown, coverage: "complete", expectedCalls: 3, recordedCalls: 3 })).toContain("已核对");
	});
});

describe("Session V1 · Chat 视图渲染", () => {
	it("默认渲染任务输入、折叠的执行过程与独立的最终结果", () => {
		const markup = renderToStaticMarkup(
			<ChatView
				detail={detail()}
				events={reactEvents()}
				summaries={[]}
				eventState={{ kind: "loaded" }}
				hasMore={false}
				loadingMore={false}
				onLoadMore={() => {}}
			/>,
		);
		expect(markup).toContain("帮我查一下今天的告警");
		// 输入只出现一次（不会被每个 LLM 请求重复渲染）。
		expect(markup.split("帮我查一下今天的告警").length - 1).toBe(1);
		expect(markup).toContain("执行过程（默认折叠）");
		expect(markup).toContain("共 4 条告警，结论如下");
		// 中间过程位于默认折叠的 details 中。
		expect(markup).toContain("<details");
	});
});
