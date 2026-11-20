import type { ConversationAdminSummary } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	compactSessionId,
	sessionLifecycleView,
	shortAgentLabel,
	summarizeSessionPage,
} from "../../../src/admin/aurora/session-list-model.ts";

function row(overrides: Partial<ConversationAdminSummary> = {}): ConversationAdminSummary {
	return {
		id: "conv_11111111-1111-1111-1111-111111111111",
		appId: "app_11111111-1111-1111-1111-111111111111",
		publicAppId: "pub_demo",
		appName: "客服应用",
		agentId: "agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		agentName: "客服 Agent",
		principalDisplayId: "prn_abcdef12",
		principalType: "external_user",
		publishedAppVersionId: "pav_11111111-1111-1111-1111-111111111111",
		title: "退款咨询",
		status: "active",
		messageCount: 3,
		errorCount: 0,
		lastEventSequence: 4,
		turnCount: 2,
		createdAt: "2026-11-17T09:00:00.000Z",
		lastActiveAt: "2026-11-17T10:00:00.000Z",
		...overrides,
	};
}

describe("Session 日志展示模型", () => {
	test("概览只统计当前页，且不从会话状态推断执行结果", () => {
		const now = new Date("2026-11-17T04:00:00.000Z");
		const overview = summarizeSessionPage(
			[
				row(),
				row({
					id: "conv_22222222-2222-2222-2222-222222222222",
					status: "archived",
					errorCount: 2,
					lastActiveAt: "2026-11-17T11:00:00.000Z",
				}),
				row({
					id: "conv_33333333-3333-3333-3333-333333333333",
					status: "deleted",
					createdAt: "2026-11-16T09:00:00.000Z",
					lastActiveAt: "2026-11-16T10:00:00.000Z",
				}),
			],
			now,
		);

		expect(overview).toMatchObject({
			pageCount: 3,
			openCount: 1,
			createdTodayCount: 2,
			withErrorsCount: 1,
		});
		expect(overview.latest?.id).toBe("conv_22222222-2222-2222-2222-222222222222");
	});

	test("今天按北京时间跨日计算，不受浏览器时区影响", () => {
		const result = summarizeSessionPage(
			[row({ createdAt: "2026-11-16T16:00:00.000Z" }), row({ createdAt: "2026-11-16T15:59:59.000Z" })],
			new Date("2026-11-16T17:00:00.000Z"),
		);
		expect(result.createdTodayCount).toBe(1);
	});

	test("生命周期标签不表示执行成功或失败", () => {
		expect(sessionLifecycleView("active")).toMatchObject({ label: "未关闭", tone: "open" });
		expect(sessionLifecycleView("archived")).toMatchObject({ label: "已归档", tone: "archived" });
		expect(sessionLifecycleView("deleted").label).toBe("已删除");
		expect(sessionLifecycleView("unexpected").label).toBe("unexpected");
		for (const status of ["active", "archived", "deleted", "unexpected"]) {
			expect(sessionLifecycleView(status).label).not.toMatch(/成功|失败/);
		}
	});

	test("技术 ID 降级显示但不丢失可复制的完整值来源", () => {
		const fullId = "conv_11111111-1111-1111-1111-111111111111";
		expect(compactSessionId(fullId)).not.toBe(fullId);
		expect(compactSessionId(fullId)).toContain("conv_");
		expect(compactSessionId("short")).toBe("short");
	});

	test("Agent 名称优先，缺失时不直接展示完整 UUID", () => {
		expect(shortAgentLabel(row())).toBe("客服 Agent");
		const fallback = shortAgentLabel(row({ agentName: null }));
		expect(fallback).toContain("agent_");
		expect(fallback).toContain("…");
		expect(fallback).not.toContain("aaaaaaaa-aaaa");
	});
});
