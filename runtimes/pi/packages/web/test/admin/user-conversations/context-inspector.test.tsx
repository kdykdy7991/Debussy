import type { ConversationAdminLlmCallDetailResponse } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextInspector } from "../../../src/admin/user-conversations/context-inspector.tsx";
import {
	compareContexts,
	contextEntries,
	readableContent,
} from "../../../src/admin/user-conversations/context-inspector-model.ts";

describe("逐次请求上下文浏览", () => {
	it("保留请求顺序、工具定义、调用 ID 与未知字段，不从事件推断请求", () => {
		const entries = contextEntries({
			systemPrompt: "规则",
			tools: [{ name: "read", parameters: { type: "object" } }],
			messages: [
				{ role: "user", content: "查告警" },
				{ role: "assistant", content: [{ type: "toolCall", name: "read", id: "tc1", arguments: { path: "/a" } }] },
				{ role: "toolResult", toolName: "read", toolCallId: "tc1", content: [{ type: "text", text: "完整结果" }] },
				{ role: "custom", content: [{ type: "custom", data: 42 }] },
			],
			customSetting: { value: true },
		});
		expect(entries.map((entry) => entry.category)).toEqual([
			"system",
			"tools",
			"user",
			"assistant",
			"tool",
			"other",
			"other",
		]);
		expect(entries.filter((entry) => entry.position !== null).map((entry) => entry.position)).toEqual([1, 2, 3, 4]);
		expect(entries[3]!.text).toContain('"path": "/a"');
		expect(entries[4]!.label).toContain("tc1");
		expect(entries[5]!.text).toContain('"data": 42');
		expect(entries[6]!.value).toEqual({ value: true });
	});

	it("非标准请求或消息结构仍可阅读", () => {
		expect(contextEntries({ messages: "unexpected", tools: null }).map((entry) => entry.text)).toEqual([
			'"unexpected"',
			"null",
		]);
		expect(contextEntries("raw request")[0]!.text).toBe("raw request");
		expect(
			readableContent([
				{ type: "thinking", thinking: "分析" },
				{ type: "text", text: "回答" },
				{ type: "image", data: "payload" },
			]),
		).toContain('"data": "payload"');
	});

	it("只在完整前缀一致时判断新增，重写或压缩历史明确标记变化", () => {
		const first = { systemPrompt: "rules", messages: [{ role: "user", content: "a" }] };
		expect(
			compareContexts(first, { ...first, messages: [...first.messages, { role: "assistant", content: "b" }] }),
		).toBe("消息末尾新增 1 条");
		expect(
			compareContexts(first, {
				systemPrompt: "new",
				tools: [{ name: "read" }],
				messages: [{ role: "user", content: "changed" }],
			}),
		).toContain("前 0 条消息一致，此后内容变化");
		expect(compareContexts(first, { ...first, messages: [] })).toContain("上次 1 条 → 本次 0 条");
		expect(compareContexts(first, first)).toBe("消息内容一致");
		expect(compareContexts(first, { messages: null })).toContain("消息结构无法比较");
	});

	it("完整正文保留，折叠时不挂载长正文，明确显示工具错误与计量口径", () => {
		const longText = `${"result".repeat(1000)} END_OF_RESULT`;
		const data: ConversationAdminLlmCallDetailResponse = {
			conversationId: "conv_demo" as ConversationAdminLlmCallDetailResponse["conversationId"],
			turnId: "turn_demo",
			callIndex: 2,
			model: "demo",
			startedAt: "2026-11-10T00:00:00Z",
			completedAt: null,
			request: {
				systemPrompt: "rules",
				messages: [
					{ role: "toolResult", toolCallId: "tc_long", toolName: "read", content: longText, isError: true },
				],
			},
			response: null,
			redacted: true,
		};
		const markup = renderToStaticMarkup(<ContextInspector data={data} />);
		expect(contextEntries(data.request).find((entry) => entry.category === "tool")!.text).toBe(longText);
		expect(markup).not.toContain("END_OF_RESULT");
		expect(markup).toContain("tc_long");
		expect(markup).toContain("工具错误");
		expect(markup).toContain("不代表 Token 用量");
		expect(markup).toContain("内容已脱敏");
		expect(markup).toContain("#1");
	});
});
