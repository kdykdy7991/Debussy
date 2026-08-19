/**
 * Aurora Topbar — 对齐 direction-b-aurora 的 .topbar。
 *
 * 视觉：64px 高 + 白底 + 下边线；左侧 brand 区（gradient orb + 名称）；
 * 中间 nav（pill 容器，active 项 ink 黑底白字）；右侧 search + actions。
 *
 * 本次 Agent List 页沿用全局左侧 Sidebar，Topbar 暂未挂载，组件保留
 * 以便后续 Settings/Sessions 等页面接入。
 */
import type { ReactNode } from "react";
import styles from "./Topbar.module.css";

export interface AuroraTopbarProps {
	readonly brandName: string;
	readonly nav?: ReactNode;
	readonly search?: ReactNode;
	readonly actions?: ReactNode;
	readonly avatar?: ReactNode;
}

export function AuroraTopbar({ brandName, nav, search, actions, avatar }: AuroraTopbarProps): React.ReactElement {
	return (
		<header className={styles.topbar}>
			<div className={styles.brand}>
				<span className={styles.orb} aria-hidden="true" />
				<span className={styles.brandName}>{brandName}</span>
			</div>
			{nav ? <nav className={styles.nav}>{nav}</nav> : null}
			<div className={styles.right}>
				{search ? <div className={styles.search}>{search}</div> : null}
				{actions}
				{avatar ? <div className={styles.avatar}>{avatar}</div> : null}
			</div>
		</header>
	);
}
