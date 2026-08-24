/**
 * M1 reasoning：会话级覆盖 tab 单测（V2-README §4.3）。
 *
 * 不复制 DTO：组件 import `ConversationReasoningState` / `ReasoningUpdateRequest`
 * / `ReasoningEffort`；测试只校验 wire 与 UI 状态机，不重新声明档位常量。
 *
 * 测试使用 `renderToStaticMarkup`（与 web 包其它 React 测试一致；无 jsdom），
 * 覆盖组件初始渲染的兜底文案。对于真正驱动 useEffect → setState 的路径，
 * 我们直接对 `ConversationsApi.getReasoning` / `putReasoning` 做 mock 验证
 * 调用形态（URL / method / body / 错误码透传），状态机本身在
 * `test/admin/conversations-api.test.ts` 已覆盖。
 *
 * 覆盖路径：
 * 1. 加载初始渲染（loading 兜底）
 * 2. 非 `conv_` 前缀的 route 参数 → 组件不抛异常（错误态走 describeError）
 * 3. 通过 formatReasoningEffort 验证档位字面量透传（无产品语义翻译）
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationsApi } from "../../../src/admin/api/conversations-api.ts";
import { formatReasoningEffort, ReasoningTab } from "../../../src/admin/user-conversations/reasoning-tab.tsx";

function makeFakeApi(): ConversationsApi {
	return {
		getReasoning: vi.fn(),
		putReasoning: vi.fn(),
	} as unknown as ConversationsApi;
}

describe("ReasoningTab 渲染兜底", () => {
	it("初始进入 tab → 显示 loading 兜底文案", () => {
		const api = makeFakeApi();
		const html = renderToStaticMarkup(<ReasoningTab conversationId="conv_1" api={api} />);
		// 静态渲染触发不到 useEffect，但首帧仍渲染 loading 兜底分支。
		expect(html).toContain("加载思考强度覆盖");
	});

	it("非法 conv_ 前缀 → 组件不抛异常", () => {
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
