/**
 * Aurora SideRail — 对齐 direction-b-aurora 的 .side-rail。
 *
 * 视觉：surface-soft 底，右边线；padding 32×16；rail-group 间距 24px；
 * 每组上方 11px eyebrow（uppercase, letter-spacing 0.12em）；
 * rail-item 9×12 padding，icon + label；hover surface；active surface +
 * shadow-sm + medium + accent 图标。
 *
 * 用法：在 List 页内做分组筛选 / Library 入口。组件是受控的，由业务方
 * 维护 active state。
 */
import type { ReactNode } from "react";
import styles from "./SideRail.module.css";

export interface AuroraRailItem {
	readonly id: string;
	readonly label: ReactNode;
	readonly icon?: ReactNode;
	readonly hint?: string;
	readonly trailing?: ReactNode;
}

export interface AuroraRailGroup {
	readonly label?: string;
	readonly items: readonly AuroraRailItem[];
}

export interface AuroraSideRailProps {
	readonly groups: readonly AuroraRailGroup[];
	readonly activeId?: string | null;
	readonly onSelect?: (id: string) => void;
	readonly ariaLabel?: string;
}

export function AuroraSideRail({
	groups,
	activeId = null,
	onSelect,
	ariaLabel = "筛选",
}: AuroraSideRailProps): React.ReactElement {
	return (
		<aside className={styles.rail} aria-label={ariaLabel}>
			{groups.map((group, gIdx) => (
				<div key={group.label ?? `group-${gIdx}`} className={styles.group}>
					{group.label ? <div className={styles.label}>{group.label}</div> : null}
					{group.items.map((item) => {
						const active = item.id === activeId;
						return (
							<button
								type="button"
								key={item.id}
								className={`${styles.item} ${active ? styles.itemActive : ""}`}
								aria-current={active ? "true" : undefined}
								onClick={() => onSelect?.(item.id)}
								title={item.hint}
							>
								{item.icon ? (
									<span className={styles.icon} aria-hidden="true">
										{item.icon}
									</span>
								) : null}
								<span className={styles.itemLabel}>{item.label}</span>
								{item.trailing ? <span className={styles.trailing}>{item.trailing}</span> : null}
							</button>
						);
					})}
				</div>
			))}
		</aside>
	);
}
