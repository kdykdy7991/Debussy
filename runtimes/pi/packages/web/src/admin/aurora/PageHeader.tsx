/**
 * Aurora PageHeader — 与 direction-b-aurora 的 .canvas-header 对齐。
 *
 * v2 视觉(默认)：左侧大标题(Inter Tight, 28px, -0.02em);右侧 actions 槽。
 * 说明性 eyebrow / subtitle / lede 已按设计收口移除；标题下不再写介绍性小字。
 *
 * v2 模块导航迁移(v4 起为左侧竖排 AppSidebar)后,顶部 PageHeader 重复
 * 显示模块名,因此允许 title 省略:仅传 actions 时退化为右对齐操作行;
 * 既无 title 也无 actions 则整体不渲染,避免空 header 占用 canvas padding。
 */
import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

export interface AuroraPageHeaderProps {
	readonly title?: string;
	readonly titleId?: string;
	readonly meta?: ReactNode;
	readonly actions?: ReactNode;
}

export function AuroraPageHeader({ title, titleId, meta, actions }: AuroraPageHeaderProps): React.ReactElement | null {
	if (!title && !actions) return null;
	if (!title) {
		return <div className={styles.actionsRow}>{actions}</div>;
	}
	return (
		<header className={styles.header}>
			<div className={styles.copy}>
				<div className={styles.titleRow}>
					<h1 id={titleId} className={styles.title}>
						{title}
					</h1>
					{meta ? <div className={styles.meta}>{meta}</div> : null}
				</div>
			</div>
			{actions ? <div className={styles.actions}>{actions}</div> : null}
		</header>
	);
}
