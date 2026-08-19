/**
 * Aurora SearchBox — 列表页工具行搜索胶囊。
 *
 * 视觉：surface-soft 底 + 999px 圆角 + 透明边；focus 时切换到 surface + accent 边；
 * 内置 magnifier 图标（避免业务页重复实现）。
 *
 * 设计稿里 search 是 Topbar 的内嵌元素；这里复用同一组件做 List 页工具行。
 */
import type { ChangeEvent } from "react";
import styles from "./SearchBox.module.css";

export interface AuroraSearchBoxProps {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly placeholder?: string;
	readonly ariaLabel?: string;
}

export function AuroraSearchBox({
	value,
	onChange,
	placeholder = "搜索…",
	ariaLabel,
}: AuroraSearchBoxProps): React.ReactElement {
	return (
		<label className={styles.box}>
			<svg
				className={styles.icon}
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				aria-hidden="true"
			>
				<circle cx="11" cy="11" r="7" />
				<path d="m20 20-3.5-3.5" />
			</svg>
			<input
				type="search"
				className={styles.input}
				value={value}
				placeholder={placeholder}
				aria-label={ariaLabel ?? placeholder}
				onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.currentTarget.value)}
			/>
		</label>
	);
}
