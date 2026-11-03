import type { AnalysisWorkItem, AnalysisWorkState } from "@earendil-works/pi-protocol";
import type { AuroraPillTone } from "../aurora/Pill.tsx";

export const WORK_STATUS: Record<AnalysisWorkState, { label: string; tone: AuroraPillTone }> = {
	queued: { label: "排队中", tone: "amber" },
	running: { label: "分析中", tone: "accent" },
	succeeded: { label: "已完成", tone: "green" },
	failed: { label: "失败", tone: "red" },
	cancelled: { label: "已取消", tone: "neutral" },
};
export function displayTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "—"
		: new Intl.DateTimeFormat("zh-CN", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).format(date);
}
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "操作未完成，请稍后重试";
}
export function workMatches(
	item: AnalysisWorkItem,
	query: string,
	state: string,
	integration: string,
	sourceName: string,
): boolean {
	return (
		(!state || item.state === state) &&
		(!integration || item.integrationId === integration) &&
		`${item.alarmId} ${item.report ?? ""} ${sourceName}`
			.toLocaleLowerCase()
			.includes(query.trim().toLocaleLowerCase())
	);
}
export function failureMessage(code: string | null): string {
	const messages: Record<string, string> = {
		CREDENTIAL_EXPIRED: "本次任务授权已过期，请由工单系统补充有效授权后继续。",
		CREDENTIAL_UNAVAILABLE: "本次任务授权不可用，请检查接入状态并补充授权。",
		EXECUTION_INTERRUPTED: "上次执行被中断，结果无法确认。请核对后再重试。",
		EXECUTION_FAILED: "分析执行失败，请检查模型或工具服务后重试。",
		EXECUTION_TIMEOUT: "分析执行超时，可检查工具响应情况后重试。",
		QUEUE_TIMEOUT: "等待执行的时间过长，可重试原分析。",
		APP_UNAVAILABLE: "关联 Agent 或接入已停用，请先恢复服务。",
	};
	return code ? (messages[code] ?? "本次分析未完成，请查看执行记录并检查服务状态。") : "";
}
