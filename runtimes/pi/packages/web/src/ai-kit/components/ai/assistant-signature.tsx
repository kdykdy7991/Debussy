import type { ReactNode } from "react";
import { type AgentAvatarState, AgentStatusAvatar } from "./agent-status-avatar";

export type SignatureStatus = "plain" | "running" | "completed" | "failed";

export type AssistantSignatureProps = {
	/**
	 * plain：无 dot，仅 名称·模型；
	 * running：active dot + 名称 + 运行态 meta；
	 * completed：简洁终态圆环 + 可选执行摘要；failed：状态短语 + 摘要。
	 */
	status?: SignatureStatus;
	/** 助手身份（plain / running 显示；completed/failed 让位给状态短语）。 */
	name?: string;
	/** 模型名（meta 事实 1）。 */
	model?: string;
	/** 运行态 meta，如 "深度思考 4.2s"（running 显示）。 */
	runningMeta?: string;
	/** failed 态 Identity 位的状态短语，默认 "Agent 运行失败"。 */
	failedLabel?: string;
	/** 执行摘要（completed/failed 显示），如 "8 步 · 2m 14s"。至多两个事实。 */
	summary?: ReactNode;
	/** 对话中的实际运行阶段；仅运行态显示完整形象。 */
	agentState?: AgentAvatarState;
};

/**
 * Assistant 签名行：每个 response 的第一行，承载执行状态。
 * 见 COMPONENT_PATTERNS.md §3、INTERACTION.md §11。
 */
export function AssistantSignature({
	status = "running",
	name,
	model,
	runningMeta,
	failedLabel = "Agent 运行失败",
	summary,
	agentState,
}: AssistantSignatureProps) {
	if (status === "plain") {
		const meta = [name, model].filter(Boolean).join(" · ");
		return (
			<div className="ai-sig">
				<span className="ai-sig-meta">{meta}</span>
			</div>
		);
	}

	if (status === "running") {
		const meta = [model, runningMeta].filter(Boolean).join(" · ");
		return (
			<div className="ai-sig">
				<AgentStatusAvatar state={agentState ?? "thinking"} />
				{name ? <span className="ai-sig-name">{name}</span> : null}
				{meta ? <span className="ai-sig-meta">{meta}</span> : null}
			</div>
		);
	}

	return (
		<div className="ai-sig">
			<AgentStatusAvatar state={status === "completed" ? "completed" : "failed"} />
			{status === "failed" ? <span className="ai-sig-name">{failedLabel}</span> : null}
			{summary ? <span className="ai-sig-meta">{summary}</span> : null}
		</div>
	);
}
