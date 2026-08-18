/**
 * Admin Workbench 侧边栏（设计收口 / MVP-15）。
 *
 * 视觉：单一侧栏，240px 宽，分三段（构建 / 运营 / 平台），底部 tenant
 * 选择器。当前路由用左侧 2px accent 边条 + 软背景标识。
 *
 * 不耦合 router 的细节判断（用 `isCurrent` 回调），方便单元测试。
 */
import type { AdminRouteId } from "../router.ts";
import { navigate } from "../router.ts";
import styles from "./Sidebar.module.css";

export interface SidebarItem {
	readonly id: Exclude<AdminRouteId, "agent-detail" | "app-detail" | "user-conversation-detail">;
	readonly label: string;
	readonly path: string;
	/** 简单 emoji / unicode / 字符。设计收口阶段不引图标包，保持轻量。 */
	readonly icon: string;
	/** tooltip 文字，可选。 */
	readonly hint?: string;
}

export interface SidebarSection {
	readonly title: string;
	readonly items: readonly SidebarItem[];
}

export interface SidebarProps {
	readonly brand?: string;
	readonly sections: readonly SidebarSection[];
	readonly currentItemId: SidebarItem["id"] | null;
	readonly tenantName?: string;
	readonly tenantRole?: string;
	readonly tenantInitial?: string;
}

export function Sidebar({
	brand = "Debussy",
	sections,
	currentItemId,
	tenantName = "Acme Corp",
	tenantRole = "Admin",
	tenantInitial = "A",
}: SidebarProps): React.ReactElement {
	return (
		<aside className={styles.sidebar} aria-label="主导航">
			<header className={styles.brand}>
				<span className={styles.brandMark} aria-hidden="true">
					{brand.charAt(0)}
				</span>
				<span className={styles.brandText}>{brand}</span>
			</header>

			<nav className={styles.nav}>
				{sections.map((section) => (
					<section key={section.title} className={styles.section}>
						<h2 className={styles.sectionTitle}>{section.title}</h2>
						<ul className={styles.sectionList}>
							{section.items.map((item) => {
								const active = currentItemId === item.id;
								return (
									<li key={item.id}>
										<button
											type="button"
											className={`${styles.item} ${active ? styles.itemActive : ""}`}
											aria-current={active ? "page" : undefined}
											title={item.hint ?? item.label}
											onClick={() => navigate(item.path)}
										>
											<span className={styles.itemIcon} aria-hidden="true">
												{item.icon}
											</span>
											<span className={styles.itemLabel}>{item.label}</span>
										</button>
									</li>
								);
							})}
						</ul>
					</section>
				))}
			</nav>

			<footer className={styles.tenant}>
				<span className={styles.tenantAvatar} aria-hidden="true">
					{tenantInitial}
				</span>
				<span className={styles.tenantInfo}>
					<span className={styles.tenantName}>{tenantName}</span>
					<span className={styles.tenantRole}>{tenantRole}</span>
				</span>
				<span className={styles.tenantChevron} aria-hidden="true">
					▾
				</span>
			</footer>
		</aside>
	);
}
