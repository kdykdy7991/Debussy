import { Children, Fragment, isValidElement, type ReactElement, type ReactNode, useState } from "react";
import { formatDuration } from "../../lib/utils";
import { AgentTraceEvent } from "./agent-trace-event";

export type AgentTraceStatus = "running" | "completed" | "failed";

export type AgentTraceProps = {
	/** 整条 trace 的状态；标题默认由此推导（running → "Agent 活动"，否则 "运行轨迹"）。 */
	status?: AgentTraceStatus;
	title?: string;
	/** 执行耗时（completed 摘要行使用）。 */
	durationMs?: number;
	/** completed 后折叠为一行摘要（可展开回完整事件列表）。 */
	compact?: boolean;
	/** 默认展示的 summary 事件数上限，默认 5。 */
	summaryLimit?: number;
	/**
	 * AgentTraceEvent 列表。
	 * 生命周期原地更新：父层以稳定 key 重渲染同一 event（改 status 属性），
	 * 节点不重建、不重排；tool result 不创建新节点。
	 */
	children: ReactNode;
};

/**
 * Agent 活动轨（250px rail 列）。
 * - 默认 summary ≤5 事件 + "查看 N 次调用的完整轨迹 →" 披露
 * - completed + compact → 一行摘要（"运行轨迹 · N 步 · 2m 14s"，可展开）
 * - 垂直连接线 + node 由 CSS 绘制；reveal 用 enter-soft，running 用 status-running
 * 表示 agent execution（可验证活动），不展示 chain-of-thought。
 */
export function AgentTrace({
	status = "running",
	title,
	durationMs,
	compact = false,
	summaryLimit = 5,
	children,
}: AgentTraceProps) {
	const [expanded, setExpanded] = useState(false);
	const [compactOpen, setCompactOpen] = useState(false);

	const events = Children.toArray(children).filter(
		(child): child is ReactElement => isValidElement(child) && child.type === AgentTraceEvent,
	);
	const total = events.length;
	const limit = Math.min(summaryLimit, total);
	const visible = expanded ? events : events.slice(0, limit);
	const hiddenCount = total - visible.length;
	const railTitle = title ?? (status === "running" ? "Agent 活动" : "运行轨迹");
	const isCompactCollapsed = compact && status === "completed" && !compactOpen;

	return (
		<div className="ai-trace" role="log" aria-label={railTitle}>
			<div className="ai-trace-title">{railTitle}</div>

			{isCompactCollapsed ? (
				<button type="button" className="ai-trace-compact" onClick={() => setCompactOpen(true)}>
					<span>
						{railTitle} · {total} 步{typeof durationMs === "number" ? ` · ${formatDuration(durationMs)}` : ""}
					</span>
					<span aria-hidden>→</span>
				</button>
			) : (
				<div className="ai-trace-events">
					{visible.map((el, i) => (
						<Fragment key={el.key ?? `ai-trace-evt-${i}`}>{el}</Fragment>
					))}

					{hiddenCount > 0 ? (
						<div className="ai-trace-more">
							<button type="button" className="ai-link" onClick={() => setExpanded((v) => !v)}>
								{expanded ? "收起完整轨迹" : `查看 ${hiddenCount} 次调用的完整轨迹 →`}
							</button>
						</div>
					) : null}
				</div>
			)}
		</div>
	);
}
