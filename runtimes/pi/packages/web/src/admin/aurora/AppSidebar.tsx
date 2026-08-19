/**
 * AppSidebar — 控制台全局左侧竖排导航。
 *
 * v5：品牌区（Acme / Admin Workbench）与模块导航合并到同一左侧栏，
 * shell 顶部不再有独立 TopNav。视觉：墨黑底、钴蓝色 active 项，
 * brand 与 nav 之间用半透明分隔线区分。
 */

import type { ReactNode } from "react";
import { navigate } from "../router.ts";
import styles from "./AppSidebar.module.css";

export interface AuroraAppSidebarItem {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly icon?: ReactNode;
}

export interface AuroraAppSidebarProps {
	readonly items: readonly AuroraAppSidebarItem[];
	readonly currentItemId: string | null;
	/** 可选 brand 区，外部省略时不渲染。 */
	readonly brandName?: string;
	readonly brandSubtitle?: string;
	readonly ariaLabel?: string;
}

export function AuroraAppSidebar({
	items,
	currentItemId,
	brandName,
	brandSubtitle,
	ariaLabel = "模块导航",
}: AuroraAppSidebarProps): React.ReactElement {
	const hasBrand = brandName !== undefined || brandSubtitle !== undefined;
	return (
		<aside className={styles.rail} aria-label={ariaLabel}>
			{hasBrand ? (
				<div className={styles.brand}>
					<span className={styles.orb} aria-hidden="true" />
					<div className={styles.brandText}>
						{brandName !== undefined ? <span className={styles.brandName}>{brandName}</span> : null}
						{brandSubtitle !== undefined ? <span className={styles.brandSubtitle}>{brandSubtitle}</span> : null}
					</div>
				</div>
			) : null}

			{items.map((item) => {
				const active = item.id === currentItemId;
				return (
					<button
						key={item.id}
						type="button"
						className={`${styles.item} ${active ? styles.itemActive : ""}`}
						aria-current={active ? "page" : undefined}
						onClick={() => navigate(item.path)}
					>
						{item.icon ? (
							<span className={styles.icon} aria-hidden="true">
								{item.icon}
							</span>
						) : null}
						<span className={styles.label}>{item.label}</span>
					</button>
				);
			})}
		</aside>
	);
}
