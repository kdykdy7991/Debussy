/**
 * Session Usage — redesigned analytics view.
 *
 * Unknown values must render as "—", real zeros remain visible, and the chart
 * must be driven only by reliable per-call facts from the Session Usage API.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
	ConversationSessionLlmCallUsage,
	ConversationSessionUsageResponse,
} from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Table } from "../../../src/admin/components/Table.tsx";
import { formatMetric } from "../../../src/admin/user-conversations/session-view-helpers.ts";
import {
	buildPromptCachePoints,
	CallDetailDrawer,
	formatCallCacheRead,
	formatCallStatus,
	formatCallToken,
	formatDuration,
	formatObservedTps,
	formatPromptToken,
	formatSignedDelta,
	formatTimingMs,
	performanceColumns,
	summarizeExecution,
	UsageContent,
} from "../../../src/admin/user-conversations/usage-view.tsx";

function call(overrides: Partial<ConversationSessionLlmCallUsage> = {}): ConversationSessionLlmCallUsage {
	return {
		turnId: "turn_1",
		index: 1,
		callIndex: 11,
		model: "oneapi/Qwen",
		input: 6087,
		output: 79,
		cacheRead: 4800,
		cacheWrite: 0,
		totalTokens: 10966,
		reasoning: null,
		contextTokens: 10887,
		promptTokens: 10887,
		status: "completed",
		usageReported: true,
		timing: { startedAtMs: 1000, endedAtMs: 2300, durationMs: 1300, firstOutputLatencyMs: 530 },
		generationMs: 770,
		observedOutputTps: (79 * 1000) / 770,
		precision: "reported",
		...overrides,
	};
}

function session(overrides: Partial<ConversationSessionUsageResponse> = {}): ConversationSessionUsageResponse {
	return {
		conversationId: "conv_11111111-1111-1111-1111-111111111111" as ConversationSessionUsageResponse["conversationId"],
		totals: { input: 9107, output: 631, cacheRead: 12800, cacheWrite: 0, totalTokens: 22538, reasoning: null },
		calls: [call()],
		turns: [
			{
				turnId: "turn_1",
				sequence: 10,
				precision: "per_call",
				callCount: 1,
				partial: false,
				totals: { input: 9107, output: 631, cacheRead: 12800, cacheWrite: 0, totalTokens: 22538, reasoning: null },
			},
		],
		accurateTurns: 1,
		partialTurns: 0,
		legacyTurns: 0,
		missingTurns: 0,
		toolCallCount: 2,
		toolErrorCount: 2,
		latestPromptTokens: 10887,
		peakPromptTokens: 10887,
		trace: { available: false, reason: "chat_untraced", recordedCalls: 0, expectedCalls: 1, coverage: "unknown" },
		notes: [],
		...overrides,
	};
}

describe("Session Usage · redesigned view", () => {
	it("does not embed the prototype demo toggle or legacy MetricsTab copy", () => {
		const sourcePath = fileURLToPath(
			new URL("../../../src/admin/user-conversations/usage-view.tsx", import.meta.url),
		);
		const source = readFileSync(sourcePath, "utf8");
		for (const stale of [
			"MetricsTab",
			"轮次性能",
			"性能展示示例",
			"当前截图数据",
			"showExample",
			"data.notes.map",
			"上下文规模",
		]) {
			expect(source).not.toContain(stale);
		}
		for (const kept of ["SESSION ANALYTICS", "Prompt 与缓存变化", "执行情况", "逐次 LLM 调用", "统计说明"]) {
			expect(source).toContain(kept);
		}
	});

	it("formats unknown values as em dash while keeping real zeros", () => {
		expect(formatPromptToken({ promptTokens: null, usageReported: false })).toBe("—");
		expect(formatPromptToken({ promptTokens: 0, usageReported: true })).toBe("0");
		expect(formatPromptToken({ promptTokens: 1234, usageReported: true })).toBe(formatMetric(1234));
		expect(formatCallToken({ contextTokens: null, usageReported: true }, 999)).toBe("—");
		expect(formatCallToken({ contextTokens: 30, usageReported: true }, 0)).toBe("0");
		expect(formatCallToken({ contextTokens: 0, usageReported: false }, 0)).toBe("—");
		expect(formatTimingMs(undefined)).toBe("—");
		expect(formatTimingMs(12.34)).toBe("12.3 ms");
		expect(formatDuration(1300)).toBe("1.30 s");
		expect(formatDuration(305.7)).toBe("305.7 ms");
		expect(formatObservedTps(0)).toBe("0.00 tok/s");
		expect(formatSignedDelta(3200, "tokens")).toBe("+3,200 tokens");
		expect(formatSignedDelta(null, "tokens")).toBe("—");
	});

	it("distinguishes explicit zero, older positive cache counts, and unknown cache reads", () => {
		const unknown = call({ cacheRead: 0 });
		const zero = call({ cacheRead: 0, cacheReadReported: true });
		expect(formatCallCacheRead(unknown)).toBe("—");
		expect(formatCallCacheRead(zero)).toBe("0");
		expect(formatCallCacheRead(call({ cacheRead: 4800 }))).toBe("4,800");
		expect(buildPromptCachePoints([unknown, zero])).toHaveLength(1);
	});

	it("builds the prompt/cache chart only from reliable calls", () => {
		const points = buildPromptCachePoints([
			call(),
			call({
				index: 2,
				callIndex: 12,
				input: 3020,
				cacheRead: 8000,
				cacheWrite: 0,
				promptTokens: 11020,
				totalTokens: 11572,
			}),
			call({ index: 3, callIndex: 13, usageReported: false, promptTokens: null, contextTokens: null }),
		]);
		expect(points).toEqual([
			{
				index: 1,
				callIndex: 11,
				model: "oneapi/Qwen",
				promptTokens: 10887,
				nonCacheInput: 6087,
				cacheRead: 4800,
				cacheWrite: 0,
			},
			{
				index: 2,
				callIndex: 12,
				model: "oneapi/Qwen",
				promptTokens: 11020,
				nonCacheInput: 3020,
				cacheRead: 8000,
				cacheWrite: 0,
			},
		]);
	});

	it("summarizes execution status without treating unknown as success", () => {
		const summary = summarizeExecution(
			[
				call(),
				call({ index: 2, status: "failed" }),
				call({ index: 3, status: "unknown" }),
			],
			2,
		);
		expect(summary).toMatchObject({ completed: 1, failed: 1, unknown: 1, attention: true });
		expect(summary.label).toContain("1 完成");
		expect(summary.label).toContain("1 失败");
		expect(summary.label).toContain("1 状态未知");
	});

	it("renders summary, chart, execution panel and the clean call table", () => {
		const data = session({
			calls: [
				call(),
				call({
					index: 2,
					callIndex: 12,
					input: 3020,
					output: 552,
					cacheRead: 8000,
					totalTokens: 11572,
					promptTokens: 11020,
					contextTokens: 11020,
					timing: undefined,
					generationMs: null,
					observedOutputTps: null,
				}),
			],
			latestPromptTokens: 11020,
			peakPromptTokens: 11020,
		});
		const html = renderToStaticMarkup(<UsageContent data={data} />);
		expect(html).toContain("SESSION ANALYTICS");
		expect(html).toContain("22,538");
		expect(html).toContain("12,800");
		expect(html).toContain("11,020");
		expect(html).toContain("Prompt 与缓存变化");
		expect(html).toContain("执行情况");
		expect(html).toContain("次工具错误");
		expect(html).toContain("逐次 LLM 调用");
		expect(html).toContain("调用耗时");
		expect(html).toContain("首生成延迟");
		expect(html).toContain("观测 TPS");
		expect(html).not.toContain("输出阶段耗时");
		expect(html).toContain("1.30 s");
		expect(html).toContain("530.0 ms");
		expect(html).toContain("查看第 2 次 LLM 调用详情");
		expect(html).toContain('tabindex="0"');
		expect(html).toContain("统计说明");
	});

	it("hides performance columns entirely for historical sessions", () => {
		const data = session({
			calls: [
				call({
					timing: undefined,
					generationMs: null,
					observedOutputTps: null,
				}),
			],
		});
		const html = renderToStaticMarkup(<UsageContent data={data} />);
		expect(html).toContain("此会话没有逐次性能采集数据，性能列已自动隐藏。");
		expect(html).not.toContain("调用耗时</span>");
		expect(html).not.toContain("首生成延迟</span>");
		expect(html).not.toContain("观测 TPS</span>");
	});

	it("shows empty chart state when no call has reliable prompt facts", () => {
		const data = session({
			totals: null,
			calls: [call({ usageReported: false, contextTokens: null, promptTokens: null })],
		});
		const html = renderToStaticMarkup(<UsageContent data={data} />);
		expect(html).toContain("没有可靠的 Prompt 分项");
		expect(html).toContain("历史数据不完整");
		expect(html).toContain("—");
	});

	it("renders the performance columns and drawer with full detail", () => {
		const row = call();
		const table = renderToStaticMarkup(
			<Table columns={performanceColumns()} rows={[row, { ...row, timing: undefined, generationMs: null, observedOutputTps: null }]} rowKey={(item) => String(item.index)} />,
		);
		for (const header of ["调用耗时", "首生成延迟", "观测 TPS"]) expect(table).toContain(header);
		expect(table).toContain("1.30 s");
		expect(table).toContain("530.0 ms");
		expect(table).toContain("102.60 tok/s");
		expect(table.match(/—/g)?.length).toBe(3);

		const drawer = renderToStaticMarkup(<CallDetailDrawer call={row} onClose={() => {}} />);
		expect(drawer).toContain("LLM 调用 #1");
		expect(drawer).toContain("11");
		expect(drawer).toContain("6,087");
		expect(drawer).toContain("4,800");
		expect(drawer).toContain("79");
		expect(drawer).toContain("770.0 ms");
		expect(drawer).toContain("不等于模型内部纯推理性能");
	});

	it("maps call terminal states to user-facing labels", () => {
		expect(formatCallStatus("completed")).toBe("完成");
		expect(formatCallStatus("failed")).toBe("失败");
		expect(formatCallStatus("aborted")).toBe("已取消");
		expect(formatCallStatus("unknown")).toBe("未知");
	});
});
