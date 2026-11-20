/**
 * Session 列表页的纯展示模型。
 *
 * 这里只从列表 API 已返回的字段派生口径，不推断 Run / Turn / LLM 执行结果：
 * - `status` 是会话生命周期（未关闭 / 已归档 / 已删除）；
 * - `errorCount` 是列表查询统计到的错误事件数，不等于某次执行失败；
 * - 概览仅统计服务端返回的当前页，不能冒充租户总数。
 */
import type { ConversationAdminSummary } from "@earendil-works/pi-protocol";
import { beijingDay } from "../beijing-time.ts";

export type SessionLifecycleTone = "open" | "archived" | "deleted" | "unknown";

export interface SessionLifecycleView {
	readonly label: string;
	readonly tone: SessionLifecycleTone;
	readonly hint: string;
}

export interface SessionPageOverview {
	readonly pageCount: number;
	readonly openCount: number;
	readonly createdTodayCount: number;
	readonly withErrorsCount: number;
	readonly latest: ConversationAdminSummary | null;
}

export function summarizeSessionPage(
	items: readonly ConversationAdminSummary[],
	now: Date = new Date(),
): SessionPageOverview {
	const today = beijingDay(now);
	let openCount = 0;
	let createdTodayCount = 0;
	let withErrorsCount = 0;
	let latest: ConversationAdminSummary | null = null;
	let latestTime = Number.NaN;

	for (const item of items) {
		if (item.status === "active") openCount += 1;
		if (beijingDay(new Date(item.createdAt)) === today) createdTodayCount += 1;
		if (item.errorCount > 0) withErrorsCount += 1;

		const activeTime = new Date(item.lastActiveAt).getTime();
		if (!Number.isNaN(activeTime) && (Number.isNaN(latestTime) || activeTime > latestTime)) {
			latest = item;
			latestTime = activeTime;
		}
	}

	return { pageCount: items.length, openCount, createdTodayCount, withErrorsCount, latest };
}

export function sessionLifecycleView(status: string): SessionLifecycleView {
	switch (status) {
		case "active":
			return { label: "未关闭", tone: "open", hint: "会话生命周期状态，不代表正在执行或执行成功" };
		case "archived":
			return { label: "已归档", tone: "archived", hint: "会话已关闭，不代表最近一次执行成功或失败" };
		case "deleted":
			return { label: "已删除", tone: "deleted", hint: "会话已软删除，审计记录仍保留" };
		default:
			return {
				label: status === "" ? "未知" : status,
				tone: "unknown",
				hint: "未知会话状态，不推断执行结果",
			};
	}
}

/** Shorten a public ID for display; the full value stays in `title` / copy action. */
export function compactSessionId(id: string): string {
	if (id.length <= 18) return id;
	return `${id.slice(0, 12)}…${id.slice(-4)}`;
}

export function shortAgentLabel(row: ConversationAdminSummary): string {
	if (row.agentName) return row.agentName;
	if (row.agentId.startsWith("agent_")) {
		return `agent_${row.agentId.slice(6, 12)}…`;
	}
	return "未关联 Agent";
}

/** Unified Session list source badge; historical rows without origin are legacy Integrations. */
export function sessionOriginLabel(row: ConversationAdminSummary): string {
	const origin = row.origin ?? (row.integrationId ? "integration" : "chat");
	if (origin === "aaas_key") return "AaaS Key";
	if (origin === "integration") return "Integration";
	return "Chat";
}
