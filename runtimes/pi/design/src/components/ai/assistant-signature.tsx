import type { ReactNode } from "react";
import { StatusDot } from "../ui/status-dot";

export type SignatureStatus = "plain" | "running" | "completed" | "failed";

export type AssistantSignatureProps = {
	/**
	 * plain：无 dot，仅 名称·模型；
	 * running：active dot + 名称 + 运行态 meta；
	 * completed / failed：状态 dot + 状态短语 + 执行摘要（步数·耗时）。
	 */
	status?: SignatureStatus;
	/** 助手身份（plain / running 显示；completed/failed 让位给状态短语）。 */
	name?: string;
	/** 模型名（meta 事实 1）。 */
	model?: string;
	/** 运行态 meta，如 "深度思考 4.2s"（running 显示）。 */
	runningMeta?: string;
	/** completed 态 Identity 位的状态短语，默认 "Agent 运行完成"。 */
	completedLabel?: string;
	/** failed 态 Identity 位的状态短语，默认 "Agent 运行失败"。 */
	failedLabel?: string;
	/** 执行摘要（completed/failed 显示），如 "8 步 · 2m 14s"。至多两个事实。 */
	summary?: ReactNode;
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
	completedLabel = "Agent 运行完成",
	failedLabel = "Agent 运行失败",
	summary
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
				<StatusDot state="active" />
				{name ? <span className="ai-sig-name">{name}</span> : null}
				{meta ? <span className="ai-sig-meta">{meta}</span> : null}
			</div>
		);
	}

	const label = status === "completed" ? completedLabel : failedLabel;
	return (
		<div className="ai-sig">
			<StatusDot state={status === "completed" ? "done" : "error"} />
			<span className="ai-sig-name">{label}</span>
			{summary ? <span className="ai-sig-meta">{summary}</span> : null}
		</div>
	);
}
