/**
 * Aurora AgentAvatar — 对齐 direction-b-aurora 的 .agent-avatar。
 *
 * 视觉：渐变背景 + Instrument Serif 斜体首字母。6 种预设 gradient
 * （purple/pink/emerald/amber/sky/rose），通过 tone 切换或显式 className 覆盖。
 *
 * 尺寸：s=32 / m=40 / lg=56 / xl=80。
 */
import type { ReactNode } from "react";
import styles from "./AgentAvatar.module.css";

export type AuroraAvatarTone = "purple" | "pink" | "emerald" | "amber" | "sky" | "rose" | "gradient";

export type AuroraAvatarSize = "s" | "m" | "lg" | "xl";

export interface AuroraAgentAvatarProps {
	/** 显示字符（Agent 名称首字母 / emoji / monogram）。 */
	readonly children: ReactNode;
	readonly tone?: AuroraAvatarTone;
	readonly size?: AuroraAvatarSize;
	readonly title?: string;
}

export function AuroraAgentAvatar({
	children,
	tone = "purple",
	size = "lg",
	title,
}: AuroraAgentAvatarProps): React.ReactElement {
	return (
		<span
			className={`${styles.avatar} ${styles[`tone_${tone}`]} ${styles[`size_${size}`]}`}
			aria-hidden={title ? undefined : true}
			title={title}
		>
			<span className={styles.glyph}>{children}</span>
		</span>
	);
}
