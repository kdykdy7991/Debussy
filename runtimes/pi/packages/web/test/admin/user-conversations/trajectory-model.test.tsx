import type {
	ConversationAdminEvent,
	ConversationAdminLlmCallDetailResponse,
	ConversationAdminLlmCallSummary,
} from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationsApi } from "../../../src/admin/api/conversations-api.ts";
import { INTERNAL_TRIGGER_MESSAGE } from "../../../src/admin/user-conversations/session-view-helpers.ts";
import { TrajectoryInspector } from "../../../src/admin/user-conversations/trajectory-inspector.tsx";
import { TrajectoryLedger, TrajectoryOverview } from "../../../src/admin/user-conversations/trajectory-ledger.tsx";
import { buildTrajectory, recordMatches } from "../../../src/admin/user-conversations/trajectory-model.ts";
import { TrajectoryView } from "../../../src/admin/user-conversations/trajectory-view.tsx";

function event(sequence: number, type: string, payload: unknown = {}, turnId = "turn_1"): ConversationAdminEvent {
	return {
		eventId: `evt_${sequence}` as ConversationAdminEvent["eventId"],
		conversationId: "conv_demo" as ConversationAdminEvent["conversationId"],
		sequence,
		eventType: type,
		kind: type as ConversationAdminEvent["kind"],
		schemaVersion: 1,
		turnId,
		createdAt: new Date(100000 + sequence * 1000).toISOString(),
		payload,
		payloadBytes: 10,
	};
}
function call(
	index: number,
	overrides: Partial<ConversationAdminLlmCallSummary> = {},
): ConversationAdminLlmCallSummary {
	return {
		turnId: "turn_1",
		callIndex: index,
		model: "demo",
		startedAt: new Date(101500 + index * 1000).toISOString(),
		completedAt: new Date(102000 + index * 1000).toISOString(),
		durationMs: 500,
		status: "completed",
		messageCount: index,
		systemPromptChars: 10,
		toolCallIds: ["tc1"],
		toolCallNames: ["read"],
		responsePreview: `回答 ${index}`,
		hasRawPayload: true,
		...overrides,
	};
}

describe("dsh 风格的会话执行记录", () => {
	it("助手、请求与系统配置分开检查，41 个可用定义不冒充实际工具执行", () => {
		const summary = call(1, { toolCallIds: ["tc1", "tc2"], toolCallNames: ["actual_a", "actual_b"] });
		const record = buildTrajectory([], [summary])[0]!;
		const data: ConversationAdminLlmCallDetailResponse = {
			conversationId: "conv_demo" as ConversationAdminLlmCallDetailResponse["conversationId"],
			turnId: summary.turnId,
			callIndex: 1,
			model: "demo",
			startedAt: summary.startedAt,
			completedAt: summary.completedAt,
			redacted: false,
			request: {
				systemPrompt: "SYSTEM_CONFIGURATION_BODY",
				tools: Array.from({ length: 41 }, (_, index) => ({ name: `unused_capability_${index}` })),
				messages: [{ role: "user", content: INTERNAL_TRIGGER_MESSAGE }],
			},
			response: {
				content: [
					{ type: "toolCall", id: "tc1", name: "actual_a", arguments: {} },
					{ type: "toolCall", id: "tc2", name: "actual_b", arguments: {} },
				],
				usage: { input: 20, output: 3 },
			},
		};
		const common = { record, detail: { kind: "loaded" as const, data }, onLoadCall: () => {}, onClose: () => {} };
		const assistant = renderToStaticMarkup(<TrajectoryInspector {...common} />);
		expect(assistant).toContain("助手输出");
		expect(assistant).toContain("actual_a");
		expect(assistant).not.toContain("输入上下文");
		expect(assistant).not.toContain("unused_capability");
		expect(assistant).not.toContain("SYSTEM_CONFIGURATION_BODY");
		const request = renderToStaticMarkup(<TrajectoryInspector {...common} initialMode="request" />);
		expect(request).toContain("实际工具调用</dt><dd>2 次");
		expect(request).not.toContain("unused_capability");
		expect(request).not.toContain("SYSTEM_CONFIGURATION_BODY");
		const system = renderToStaticMarkup(<TrajectoryInspector {...common} initialMode="system" />);
		expect(system).toContain("系统配置");
		expect(system).toContain("SYSTEM_CONFIGURATION_BODY");
		expect(system).not.toContain("actual_a");
		expect(buildTrajectory([], [summary]).filter((entry) => entry.kind === "tool")).toHaveLength(0);
	});
	it("API 外部任务显示在真实触发事件的位置，完整正文可读且不改写原始事件", () => {
		const text = `API 工单分析任务 ${"资料".repeat(500)} TASK_END`;
		const trigger = event(1, "user/message", { text: INTERNAL_TRIGGER_MESSAGE });
		const records = buildTrajectory([trigger, event(2, "user/message", { text: "后续追问" }, "turn_2")], [], false, {
			kind: "external_task",
			text,
		});
		const task = records[0]!;
		expect(task.title).toBe("外部任务（API 输入）");
		expect(task.role).toBe("用户");
		expect(task.time).toBe(trigger.createdAt);
		expect(recordMatches(task, "TASK_END")).toBe(true);
		expect(records[1]!.preview).toBe("后续追问");
		if (task.kind !== "event") throw new Error("expected input event");
		expect(task.event).toBe(trigger);
		expect(task.taskInput?.text).toBe(text);
		const html = renderToStaticMarkup(<TrajectoryInspector record={task} onLoadCall={() => {}} onClose={() => {}} />);
		expect(html).toContain("TASK_END");
		expect(html).toContain("外部 API 任务");
		expect(html).toContain("系统提示词（当前 API 契约）");
		expect(html).not.toContain(INTERNAL_TRIGGER_MESSAGE);
	});
	it("触发事件尚未加载时仍可看见 API 任务，不伪造时间节点", () => {
		const taskInput = { kind: "external_task" as const, text: "来自 API 的工单资料" };
		expect(buildTrajectory([], [], false, taskInput)).toEqual([]);
		const html = renderToStaticMarkup(
			<TrajectoryView
				api={{} as ConversationsApi}
				conversationId="conv_demo"
				events={[]}
				taskInput={taskInput}
				initialTrace={{
					available: false,
					reason: "no_records",
					recordedCalls: 0,
					expectedCalls: null,
					coverage: "unknown",
				}}
			/>,
		);
		expect(html).toContain(taskInput.text);
		expect(html).toContain("暂不指定时间位置");
	});
	it("没有外部任务记录时，不把内部触发消息冒充业务输入", () => {
		const records = buildTrajectory([event(1, "user/message", { text: INTERNAL_TRIGGER_MESSAGE })], []);
		expect(records[0]!.title).toBe("任务触发（内部消息）");
		expect(records[0]!.preview).toBe(INTERNAL_TRIGGER_MESSAGE);
	});
	it("多次请求属于同一轮，按开始时间排列，工具参数与结果只占一条记录", () => {
		const records = buildTrajectory(
			[
				event(8, "tool/result", { toolCallId: "tc1", content: [{ type: "text", text: "结果" }] }),
				event(1, "user/message", { text: "任务" }),
				event(4, "tool/call", { toolCallId: "tc1", toolName: "read", input: { path: "/a" } }),
			],
			[call(2), call(1)],
		);
		expect(records.map((record) => record.kind)).toEqual(["event", "model", "model", "tool"]);
		expect(new Set(records.map((record) => record.turnId)).size).toBe(1);
		const tool = records.find((record) => record.kind === "tool")!;
		expect(tool.preview).toContain('"path": "/a"');
		expect(tool.preview).toContain("→ 结果");
		expect(tool.completedAt).toBe(new Date(108000).toISOString());
		expect(tool.durationMs).toBe(4000);
	});
	it("同名或跨轮次重复 ID 不会串联，无 ID 的事件不猜测关联", () => {
		const records = buildTrajectory(
			[
				event(1, "tool/call", { toolCallId: "same", toolName: "read" }),
				event(2, "tool/result", { toolCallId: "same" }, "turn_2"),
				event(3, "tool/call", { toolName: "read" }),
				event(4, "tool/result", { toolName: "read" }),
			],
			[],
		);
		expect(records).toHaveLength(4);
		expect(
			records.find((record) => record.turnId === "turn_1" && record.kind === "tool" && record.toolCallId === "same")
				?.completedAt,
		).toBeNull();
	});
	it("优先使用已记录的工具运行时间，不以落库时间冒充执行耗时", () => {
		const records = buildTrajectory(
			[
				event(5, "tool/call", { toolCallId: "tc1", startedAt: 1000 }),
				event(9, "tool/result", { toolCallId: "tc1", finishedAt: 1250 }),
			],
			[],
		);
		expect(records[0]?.time).toBe(new Date(1000).toISOString());
		expect(records[0]?.durationMs).toBe(250);
	});
	it("未采集的结束时间和耗时保持未知，不虚构运行跨度", () => {
		const records = buildTrajectory(
			[event(1, "tool/call", { toolCallId: "tc1" })],
			[call(1, { completedAt: null, durationMs: null, status: "incomplete" })],
		);
		expect(records.every((record) => record.completedAt === null && record.durationMs === null)).toBe(true);
		const html = renderToStaticMarkup(
			<TrajectoryOverview records={records} actualDuration selected={null} onSelect={() => {}} />,
		);
		expect(html).toContain("未知 / 无耗时记录");
	});
	it("底层事件默认收起且仍可完整检查，无请求追踪时保留会话回复", () => {
		const events = [event(1, "turn/start"), event(2, "assistant/message", { text: "回复" }), event(3, "turn/end")];
		expect(buildTrajectory(events, [call(1)])).toHaveLength(1);
		expect(buildTrajectory(events, [call(1)], true)).toHaveLength(4);
		expect(buildTrajectory(events, []).map((record) => record.preview)).toEqual(["回复"]);
	});
	it("工具结果正文末尾可搜索；搜索可显示被折叠的工具行", () => {
		const records = buildTrajectory(
			[
				event(3, "tool/call", { toolCallId: "tc1" }),
				event(4, "tool/result", {
					toolCallId: "tc1",
					content: [{ type: "text", text: `${"a".repeat(5000)} END_RESULT` }],
				}),
			],
			[call(1)],
		);
		const match = records.find((record) => recordMatches(record, "END_RESULT"))!;
		expect(match.kind).toBe("tool");
		const html = renderToStaticMarkup(
			<TrajectoryLedger
				records={records}
				allRecords={records}
				selected={null}
				onSelect={() => {}}
				collapsedTurns={new Set(["turn_1"])}
				collapsedCalls={new Set(["model:turn_1:1"])}
				onToggleTurn={() => {}}
				onToggleCall={() => {}}
				searching
			/>,
		);
		expect(html).toContain("工具</span>");
		expect(html).not.toContain("工具执行已折叠");
		expect(html).toContain("第 1 轮");
	});
});
