/**
 * 控制台通用 EmptyState（设计收口 / MVP-15）。
 *
 * 三态覆盖：empty（默认）/ error / loading。统一图标 + 标题 + 描述 + 主行动。
 */
import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

export type EmptyStateKind = "empty" | "error" | "loading";

export interface EmptyStateProps {
	readonly kind?: EmptyStateKind;
	readonly icon?: ReactNode;
	readonly title: string;
	readonly description?: ReactNode;
	readonly action?: ReactNode;
	/** 紧凑模式（用在 Table 内嵌行）。 */
	readonly compact?: boolean;
}

export function EmptyState({
	kind = "empty",
	icon,
	title,
	description,
	action,
	compact = false,
}: EmptyStateProps): React.ReactElement {
	const defaultIcon = kind === "error" ? "⚠" : kind === "loading" ? "…" : "∅";
	return (
		<div
			className={`${styles.state} ${compact ? styles.compact : ""} ${styles[`kind_${kind}`]}`}
			role={kind === "error" ? "alert" : undefined}
		>
			<div className={styles.icon} aria-hidden="true">
				{icon ?? defaultIcon}
			</div>
			<div className={styles.body}>
				<h3 className={styles.title}>{title}</h3>
				{description ? <p className={styles.description}>{description}</p> : null}
			</div>
			{action ? <div className={styles.action}>{action}</div> : null}
		</div>
	);
}
