/**
 * 控制台通用 FilterBar（设计收口 / MVP-15）。
 *
 * 提供三种用法：
 *  1. <FilterBar left={...} right={...} />        —— 完全自由布局
 *  2. <FilterBar left={...} resetLabel="重置" onReset={...} />
 *     —— right 自动渲染"重置 + 主操作"按钮组
 *  3. children 直传，子元素横向排列
 *
 * 视觉：白底圆角卡片，软边框，元素间 8px 间距；搜索框左侧内嵌放大镜。
 */
import type { ChangeEvent, ReactNode } from "react";
import styles from "./FilterBar.module.css";

export interface FilterBarSearchProps {
	readonly placeholder: string;
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly ariaLabel?: string;
}

export function FilterSearch({ placeholder, value, onChange, ariaLabel }: FilterBarSearchProps): React.ReactElement {
	return (
		<div className={styles.search}>
			<span className={styles.searchIcon} aria-hidden="true">
				<svg
					aria-hidden="true"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="11" cy="11" r="7" />
					<path d="M21 21l-4.3-4.3" />
				</svg>
			</span>
			<input
				type="search"
				className={styles.searchInput}
				placeholder={placeholder}
				aria-label={ariaLabel ?? placeholder}
				value={value}
				onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.currentTarget.value)}
			/>
		</div>
	);
}

export interface FilterBarSelectProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly ariaLabel?: string;
	readonly options: readonly { value: string; label: string }[];
	readonly placeholder?: string;
}

export function FilterSelect({
	value,
	onChange,
	ariaLabel,
	options,
	placeholder,
}: FilterBarSelectProps): React.ReactElement {
	return (
		<select
			className={styles.select}
			aria-label={ariaLabel}
			value={value}
			onChange={(e) => onChange(e.currentTarget.value)}
		>
			{placeholder ? (
				<option value="" disabled={value !== ""}>
					{placeholder}
				</option>
			) : null}
			{options.map((opt) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
	);
}

export interface DateRangeProps {
	readonly fromValue: string;
	readonly toValue: string;
	readonly onFromChange: (next: string) => void;
	readonly onToChange: (next: string) => void;
	readonly fromLabel?: string;
	readonly toLabel?: string;
}

export function DateRange({
	fromValue,
	toValue,
	onFromChange,
	onToChange,
	fromLabel = "起始",
	toLabel = "结束",
}: DateRangeProps): React.ReactElement {
	return (
		<div className={styles.dateRange}>
			<input
				type="date"
				className={styles.dateInput}
				value={fromValue}
				aria-label={fromLabel}
				onChange={(e) => onFromChange(e.currentTarget.value)}
			/>
			<span className={styles.dateArrow} aria-hidden="true">
				→
			</span>
			<input
				type="date"
				className={styles.dateInput}
				value={toValue}
				aria-label={toLabel}
				onChange={(e) => onToChange(e.currentTarget.value)}
			/>
		</div>
	);
}

export interface FilterBarProps {
	readonly left?: ReactNode;
	readonly right?: ReactNode;
	readonly children?: ReactNode;
	readonly className?: string;
}

export function FilterBar({ left, right, children, className }: FilterBarProps): React.ReactElement {
	return (
		<div className={`${styles.bar} ${className ?? ""}`}>
			{children ? (
				<div className={styles.left}>{children}</div>
			) : (
				<>
					{left ? <div className={styles.left}>{left}</div> : null}
					{right ? <div className={styles.right}>{right}</div> : null}
				</>
			)}
		</div>
	);
}
