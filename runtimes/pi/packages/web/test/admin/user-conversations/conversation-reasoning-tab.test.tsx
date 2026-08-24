/**
 * M1 reasoning：会话级覆盖 tab 单测（V2-README §4.3）。
 *
 * 不复制 DTO：组件 import `ConversationReasoningState` / `ReasoningUpdateRequest`
 * / `ReasoningEffort`；测试只校验 wire 与 UI 状态机，不重新声明档位常量。
 *
 * 覆盖路径：
 * 1. formatReasoningEffort 6 档字面量透传（不做产品翻译）；
 * 2. 渲染兜底（loading 兜底）；
 * 3. 非 `conv_` 前缀的 route 参数 → 组件不抛异常。
 *
 * wire / state-driven 测试在 `test/admin/conversations-api.test.ts` 已有（覆盖
 * `getReasoning` / `putReasoning` 的 method/header/body/错误码透传）。
 */

import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentApi } from "../../../src/admin/api/agent-api.ts";
import type { ConversationsApi } from "../../../src/admin/api/conversations-api.ts";
import type { LlmApi } from "../../../src/admin/api/llm-api.ts";
import { formatReasoningEffort, ReasoningTab } from "../../../src/admin/user-conversations/reasoning-tab.tsx";

function makeFakeApi(): ConversationsApi {
	return {
		getReasoning: vi.fn(),
		putReasoning: vi.fn(),
	} as unknown as ConversationsApi;
}

function makeFakeAgentApi(): AgentApi {
	return {
		getAgentDetail: vi.fn(),
	} as unknown as AgentApi;
}

function makeFakeLlmApi(): LlmApi {
	return {
		listModels: vi.fn(),
	} as unknown as LlmApi;
}

const SAMPLE_AGENT_ID = "agent_11111111-1111-1111-1111-111111111111" as AgentPublicId;

describe("ReasoningTab 渲染兜底", () => {
	it("初始渲染 → capability idle，渲染 loading 兜底（form 不可见）", () => {
		const api = makeFakeApi();
		const agentApi = makeFakeAgentApi();
		const llmApi = makeFakeLlmApi();
		const html = renderToStaticMarkup(
			<ReasoningTab
				conversationId="conv_1"
				agentId={SAMPLE_AGENT_ID}
				api={api}
				agentApi={agentApi}
				llmApi={llmApi}
			/>,
		);
		// 静态渲染不触发 useEffect，所以 capability 仍是 idle，
		// 渲染 loading 兜底。form `<select>` **不应**出现。
		expect(html).toContain("加载模型能力目录");
		expect(html).not.toContain("reasoning-effort-draft");
	});

	it("agentId=null 时仍能渲染（不抛）", () => {
		const api = makeFakeApi();
		const agentApi = makeFakeAgentApi();
		const llmApi = makeFakeLlmApi();
		expect(() =>
			renderToStaticMarkup(
				<ReasoningTab conversationId="conv_1" agentId={null} api={api} agentApi={agentApi} llmApi={llmApi} />,
			),
		).not.toThrow();
	});

	it("非法 conv_ 前缀 → 组件不抛异常", () => {
		const api = makeFakeApi();
		const agentApi = makeFakeAgentApi();
		const llmApi = makeFakeLlmApi();
		expect(() =>
			renderToStaticMarkup(
				<ReasoningTab
					conversationId="oops"
					agentId={SAMPLE_AGENT_ID}
					api={api}
					agentApi={agentApi}
					llmApi={llmApi}
				/>,
			),
		).not.toThrow();
	});
});

describe("formatReasoningEffort (档位透传)", () => {
	// 不复制 DTO：档位字符串来自协议 union；这里只断言"原样返回"语义。
	const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
	for (const effort of efforts) {
		it(`formatReasoningEffort(${effort}) === ${effort}（不做产品翻译）`, () => {
			expect(formatReasoningEffort(effort)).toBe(effort);
		});
	}
});
