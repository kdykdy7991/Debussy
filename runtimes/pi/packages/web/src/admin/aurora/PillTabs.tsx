/**
 * Aurora PillTabs — 对齐 direction-b-aurora 的 .pill-tabs。
 *
 * 视觉：浅底胶囊容器（surface-soft），子项 999px 圆角；激活态 surface +
 * shadow-sm + medium 字重；右侧可挂 count 徽章。
 *
 * 用法：
 *   <AuroraPillTabs
 *     value={tab}
 *     onChange={setTab}
 *     items={[
 *       { value: "all", label: "All", count: 12 },
 *       { value: "live", label: "Live" },
 *     ]}
 *   />
 */
import type { ReactNode } from "react";
import styles from "./PillTabs.module.css";

export interface AuroraPillTabItem<V extends string> {
	readonly value: V;
	readonly label: ReactNode;
	/** 可选：右侧的小徽章计数。 */
	readonly count?: number;
}

export interface AuroraPillTabsProps<V extends string> {
	readonly items: readonly AuroraPillTabItem<V>[];
	readonly value: V;
	readonly onChange: (value: V) => void;
	readonly ariaLabel?: string;
}

export function AuroraPillTabs<V extends string>({
	items,
	value,
	onChange,
	ariaLabel,
}: AuroraPillTabsProps<V>): React.ReactElement {
	return (
		<div className={styles.tabs} role="tablist" aria-label={ariaLabel}>
			{items.map((item) => {
				const active = item.value === value;
				return (
					<button
						key={item.value}
						type="button"
						role="tab"
						aria-selected={active}
						className={`${styles.tab} ${active ? styles.tabActive : ""}`}
						onClick={() => onChange(item.value)}
					>
						<span>{item.label}</span>
						{item.count !== undefined ? <span className={styles.count}>{item.count}</span> : null}
					</button>
				);
			})}
		</div>
	);
}
