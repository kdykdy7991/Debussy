/**
 * M1 reasoning：会话级覆盖 tab 单测（V2-README §4.3）。
 *
 * R8 修订：capability 数据源待 BE 契约冻结，本组件不再接 `agentApi` /
 * `llmApi` props；tab 永远进入 "awaiting-contract" 态，不展示档位编辑。
 *
 * 不复制 DTO：组件 import `ConversationReasoningState` / `ReasoningUpdateRequest`
 * / `ReasoningEffort`；测试只校验 wire 与 UI 状态机，不重新声明档位常量。
 *
 * 覆盖路径：
 * 1. 初始渲染进入 awaiting-contract 壳（**不**调 agentApi/llmApi）；
 * 2. 非 `conv_` 前缀的 route 参数 → 组件不抛异常；
 * 3. formatReasoningEffort 6 档字面量透传。
 *
 * wire / state-driven 测试在 `test/admin/conversations-api.test.ts` 已有（覆盖
 * `getReasoning` / `putReasoning` 的 method/header/body/错误码透传）。
 */
import type { ConversationReasoningState, ReasoningEffort } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationsApi } from "../../../src/admin/api/conversations-api.ts";
import { formatReasoningEffort, ReasoningTab } from "../../../src/admin/user-conversations/reasoning-tab.tsx";

function makeFakeApi(overrides: Partial<ConversationsApi> = {}): ConversationsApi {
	return {
		getReasoning: vi.fn(),
		putReasoning: vi.fn(),
		...overrides,
	} as unknown as ConversationsApi;
}

const SAMPLE_CONV = "conv_1";

describe("ReasoningTab 渲染兜底（R8 awaiting-contract）", () => {
	it("初始渲染进入 awaiting-contract 壳（不调 agentApi/llmApi）", () => {
		const api = makeFakeApi();
		const html = renderToStaticMarkup(<ReasoningTab conversationId={SAMPLE_CONV} api={api} />);
		// 静态渲染不触发 useEffect——state idle → loading 兜底出现；
		// capability 永远 awaiting-contract。
		expect(html).toContain("加载思考强度覆盖");
		// **关键**：R7 的 capability loaded 分支（`<select id="reasoning-effort-draft">`）**不应**出现。
		expect(html).not.toContain("reasoning-effort-draft");
		// getReasoning 没被调用（renderToStaticMarkup 不触发 useEffect）。
		expect(api.getReasoning).not.toHaveBeenCalled();
	});

	it("非 conv_ 前缀 → 组件不抛异常", () => {
		const api = makeFakeApi();
		expect(() => renderToStaticMarkup(<ReasoningTab conversationId="oops" api={api} />)).not.toThrow();
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

/** 重新导出供 tests 校验 wire 形状。 */
export type { ConversationReasoningState, ReasoningEffort };
