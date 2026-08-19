/**
 * Aurora Pill — 状态/标签小胶囊，对齐 direction-b-aurora 的 .pill。
 *
 * 视觉：4px×10px padding、999px 圆角、12px 字、tone-* 控制背景与文字色。
 * 预设 tone：neutral（默认）/ accent / green / amber / red / live（带绿点）。
 */
import type { ReactNode } from "react";
import styles from "./Pill.module.css";

export type AuroraPillTone = "neutral" | "accent" | "green" | "amber" | "red" | "live";

export interface AuroraPillProps {
	readonly children: ReactNode;
	readonly tone?: AuroraPillTone;
	readonly className?: string;
}

export function AuroraPill({ children, tone = "neutral", className }: AuroraPillProps): React.ReactElement {
	return <span className={`${styles.pill} ${styles[`tone_${tone}`]} ${className ?? ""}`}>{children}</span>;
}
