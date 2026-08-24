/**
 * M1: context snapshot 卡片渲染回归测试（修订轮）。
 *
 * 验证 `usagePercent` 的展示口径：协议字段已经是百分比标量（如 3.75），
 * 渲染时只 `toFixed(2)` 加 `%`，**不再乘以 100**——之前 `(v * 100)`
 * 会把 3.75 渲染成 375%。
 *
 * 测试与生产组件共用 `formatUsagePercent`：避免复制实现漂移。
 */
import type { ContextUsageSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { formatUsagePercent } from "../../src/admin/user-conversations/context-tab.tsx";

describe("ContextSnapshotCard usagePercent rendering (M1)", () => {
	it("renders 3.75 as '3.75%', not '375%'", () => {
		const snapshot: ContextUsageSnapshot = {
			usedTokens: 100,
			contextWindow: 1000,
			remainingTokens: 900,
			reservedOutputTokens: 0,
			usagePercent: 3.75,
			measurement: "estimated",
			breakdown: {
				systemPrompt: 0,
				skillInstructions: 0,
				toolDefinitions: 0,
				conversationMessages: 100,
				toolResults: 0,
				retrievalContext: 0,
				attachments: 0,
			},
		};
		expect(formatUsagePercent(snapshot)).toBe("3.75%");
	});

	it("renders 0 as '0.00%'", () => {
		const snapshot: ContextUsageSnapshot = {
			usedTokens: 0,
			contextWindow: 1000,
			remainingTokens: 1000,
			reservedOutputTokens: 0,
			usagePercent: 0,
			measurement: "exact",
			breakdown: {
				systemPrompt: 0,
				skillInstructions: 0,
				toolDefinitions: 0,
				conversationMessages: 0,
				toolResults: 0,
				retrievalContext: 0,
				attachments: 0,
			},
		};
		expect(formatUsagePercent(snapshot)).toBe("0.00%");
	});

	it("renders 100 as '100.00%'", () => {
		const snapshot: ContextUsageSnapshot = {
			usedTokens: 1000,
			contextWindow: 1000,
			remainingTokens: 0,
			reservedOutputTokens: 0,
			usagePercent: 100,
			measurement: "exact",
			breakdown: {
				systemPrompt: 0,
				skillInstructions: 0,
				toolDefinitions: 0,
				conversationMessages: 1000,
				toolResults: 0,
				retrievalContext: 0,
				attachments: 0,
			},
		};
		expect(formatUsagePercent(snapshot)).toBe("100.00%");
	});
});
