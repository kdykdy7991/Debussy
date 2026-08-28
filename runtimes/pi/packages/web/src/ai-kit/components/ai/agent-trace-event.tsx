import { cx } from "../../lib/utils";

export type AgentTraceEventStatus = "pending" | "running" | "completed" | "failed";

export type AgentTraceEventProps = {
	/**
	 * 语义状态机：pending → running → completed | failed。
	 * 同一 event 生命周期原地更新：父层用稳定 key 重渲染同一 node，
	 * tool call 与 tool result 不创建两个节点（INTERACTION.md §3）。
	 */
	status: AgentTraceEventStatus;
	/** 动词 + 对象（"检索知识库"）；禁止协议术语，禁止 chain-of-thought。 */
	title: string;
	/** 至多 1 行技术信息：`技术名 · 指标 · 耗时`。 */
	detail?: string;
};

/**
 * Agent 活动轨的单个事件：node + title + detail (+ payload 披露)。
 * 表示可验证的 execution activity，不是推理过程。
 * reveal 用 motion-enter-soft（X 轴），running 用 motion-status-running，
 * 均由 motion.css 决定，本组件不暴露任何视觉属性。
 */
export function AgentTraceEvent({ status, title, detail }: AgentTraceEventProps) {
	return (
		<div className={cx("ai-trace-evt", `is-${status}`)} data-status={status}>
			<span className="node" aria-hidden />
			<span className="ai-trace-t">{title}</span>
			{detail ? <span className="ai-trace-d">{detail}</span> : null}
		</div>
	);
}
