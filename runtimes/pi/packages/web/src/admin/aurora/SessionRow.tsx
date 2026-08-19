/**
 * Aurora SessionRow — 对齐 direction-b-aurora 的 .session-row。
 *
 * 视觉：白底卡片 + line 边 + radius-md；顶部 left 区（时间 + 用户 + → +
 * agent pill + 渠道）+ 右侧 status pill；中部对话预览（user: / agent: 两行
 * 折行），mono 字体显示用户 ID；底部 meta 行（时长 / token / 成本 / 轮次 /
 * 错误提示）。
 *
 * hover：shadow-sm + 边框消失。整行可点击进详情。
 */
import type { ReactNode } from "react";
import styles from "./SessionRow.module.css";

export interface AuroraSessionRowProps {
	readonly when: string;
	readonly user: string;
	readonly channel?: ReactNode;
	readonly agentBadge: ReactNode;
	readonly statusBadge: ReactNode;
	readonly userPreview: string;
	readonly agentPreview: string;
	readonly meta?: ReactNode;
	readonly onClick?: () => void;
	readonly ariaLabel?: string;
}

export function AuroraSessionRow({
	when,
	user,
	channel,
	agentBadge,
	statusBadge,
	userPreview,
	agentPreview,
	meta,
	onClick,
	ariaLabel,
}: AuroraSessionRowProps): React.ReactElement {
	const interactive = typeof onClick === "function";
	const Tag = interactive ? "button" : "div";
	return (
		<Tag className={styles.row} onClick={onClick} type={interactive ? "button" : undefined} aria-label={ariaLabel}>
			<header className={styles.top}>
				<div className={styles.left}>
					<span className={styles.when}>{when}</span>
					<span className={styles.user}>{user}</span>
					<span className={styles.arrow} aria-hidden="true">
						→
					</span>
					{agentBadge}
					{channel ? <span className={styles.channel}>{channel}</span> : null}
				</div>
				{statusBadge}
			</header>
			<div className={styles.preview}>
				<div className={styles.previewLine}>
					<strong>user：</strong>
					<span>{userPreview}</span>
				</div>
				<div className={styles.previewLine}>
					<strong className={styles.agentName}>
						{agentBadge && extractLabel(agentBadge) ? `${extractLabel(agentBadge)}：` : "agent："}
					</strong>
					<span>{agentPreview}</span>
				</div>
			</div>
			{meta ? <footer className={styles.meta}>{meta}</footer> : null}
		</Tag>
	);
}

/**
 * Aurora Pill 不直接暴露 label 字段；本辅助函数尝试从 ReactNode 中抽取
 * 字符串用于预览行的前缀（如 "Sage："）。Agent badge 通常就是 AuroraPill。
 */
function extractLabel(node: ReactNode): string | null {
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (Array.isArray(node)) {
		for (const n of node) {
			const got = extractLabel(n);
			if (got) return got;
		}
	}
	return null;
}
