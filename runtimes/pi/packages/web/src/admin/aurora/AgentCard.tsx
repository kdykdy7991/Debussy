/**
 * Aurora AgentCard — 对齐 direction-b-aurora 的 .agent-card。
 *
 * 视觉：surface 白底 + line 边 + radius-lg + shadow-sm；hover 时提升为
 * shadow-md、translateY(-2px)、边框消失，露出 gradient-soft 背景层。
 * 顶部 avatar + 名称 + 角色（ink-2）；中部虚线分隔的 serif 斜体 quote；
 * 下部 tags（pill 行）+ meta-row（左 live 状态 / 右数字）。
 *
 * children 提供完全自定义渲染区（如 CTA 行）；通过 props 传入的数据默认
 * 按设计稿布局，但允许 children 完全覆盖。
 */
import type { ReactNode } from "react";
import { AuroraAgentAvatar, type AuroraAvatarSize, type AuroraAvatarTone } from "./AgentAvatar.tsx";
import styles from "./AgentCard.module.css";

export interface AuroraAgentCardProps {
	readonly name: string;
	readonly role: string;
	/** 一句话描述，serif 斜体显示。 */
	readonly quote?: string;
	/** tags 行。 */
	readonly tags?: ReactNode;
	/** meta 行（左侧 live 状态、右侧数字）。 */
	readonly metaLeft?: ReactNode;
	readonly metaRight?: ReactNode;
	readonly avatarTone?: AuroraAvatarTone;
	readonly avatarSize?: AuroraAvatarSize;
	readonly avatarText?: string;
	readonly onClick?: () => void;
	readonly footer?: ReactNode;
	readonly ariaLabel?: string;
}

export function AuroraAgentCard({
	name,
	role,
	quote,
	tags,
	metaLeft,
	metaRight,
	avatarTone = "purple",
	avatarSize = "lg",
	avatarText,
	onClick,
	footer,
	ariaLabel,
}: AuroraAgentCardProps): React.ReactElement {
	const interactive = typeof onClick === "function";
	const Tag = interactive ? "button" : "article";
	const glyph = avatarText ?? name.charAt(0);
	return (
		<Tag
			className={styles.card}
			onClick={onClick}
			aria-label={ariaLabel ?? name}
			type={interactive ? "button" : undefined}
		>
			<div className={styles.bg} aria-hidden="true" />
			<header className={styles.top}>
				<AuroraAgentAvatar tone={avatarTone} size={avatarSize}>
					{glyph}
				</AuroraAgentAvatar>
				<div className={styles.titleBlock}>
					<div className={styles.name}>{name}</div>
					<div className={styles.role}>{role}</div>
				</div>
			</header>
			{quote ? <p className={styles.quote}>{quote}</p> : null}
			{tags ? <div className={styles.tags}>{tags}</div> : null}
			{(metaLeft || metaRight) && (
				<div className={styles.metaRow}>
					<span className={styles.metaLeft}>{metaLeft}</span>
					<span className={styles.metaRight}>{metaRight}</span>
				</div>
			)}
			{footer ? <div className={styles.footer}>{footer}</div> : null}
		</Tag>
	);
}
