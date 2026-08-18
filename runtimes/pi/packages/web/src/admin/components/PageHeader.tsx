/**
 * 列表 / 详情页通用 PageHeader。
 *
 * 视觉：左标题 + 副标题，右上 actions；标题区与主内容之间有 generous 间距。
 */
import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

export interface PageHeaderProps {
	readonly title: string;
	readonly subtitle?: ReactNode;
	readonly actions?: ReactNode;
	/** 可选 eyebrow（上文标签，例如 "BUILDER"），字距放大、小字、淡色。 */
	readonly eyebrow?: string;
}

export function PageHeader({ title, subtitle, actions, eyebrow }: PageHeaderProps): React.ReactElement {
	return (
		<header className={styles.header}>
			<div className={styles.lead}>
				{eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
				<h1 className={styles.title}>{title}</h1>
				{subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
			</div>
			{actions ? <div className={styles.actions}>{actions}</div> : null}
		</header>
	);
}
