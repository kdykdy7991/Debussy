/**
 * 控制台 Badge（设计收口 / MVP-15）。
 *
 * 语义变体：active / draft / suspended / archived / running / ended / up / down /
 * info / neutral。圆角胶囊，背景使用对应 --admin-{x}-soft token。
 */
import type { ReactNode } from "react";
import styles from "./Badge.module.css";

export type BadgeVariant =
	| "active"
	| "draft"
	| "suspended"
	| "archived"
	| "running"
	| "ended"
	| "up"
	| "down"
	| "info"
	| "neutral"
	| "success"
	| "warning"
	| "danger";

export interface BadgeProps {
	readonly variant?: BadgeVariant;
	readonly children: ReactNode;
	/** 软底/深底切换。默认 soft。 */
	readonly tone?: "soft" | "solid";
	/** 显示在文本前的状态点（圆点），常用于运行中。 */
	readonly dot?: boolean;
	/** 自定义类名（兼容现有 .badge 业务页面）。 */
	readonly className?: string;
}

export function Badge({
	variant = "neutral",
	children,
	tone = "soft",
	dot = false,
	className,
}: BadgeProps): React.ReactElement {
	const classes = [styles.badge, styles[`v_${variant}`], styles[`tone_${tone}`], className ?? ""]
		.filter(Boolean)
		.join(" ");
	return (
		<span className={classes}>
			{dot ? <span className={styles.dot} aria-hidden="true" /> : null}
			{children}
		</span>
	);
}
