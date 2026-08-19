/**
 * Aurora MetricGrid / MetricCard — 对齐设计稿"stat"展示形式。
 *
 * 视觉：白底卡片 + line 边 + radius-md；eyebrow（小字、大写、字距、ink-3）
 * + 大数字（Inter Tight, 28px, -0.02em 字距）+ 趋势行（ink-3 比较语 +
 * 绿/红 delta）。整组按 4 / 6 列水平排列（>=1180px 一行，否则 wrap）。
 *
 * 后续 Settings 也可用同样的 Stat 模式展示。
 */
import type { ReactNode } from "react";
import styles from "./MetricGrid.module.css";

export type AuroraTrend = "up" | "down" | "flat";

export interface AuroraMetricItem {
	readonly id: string;
	readonly label: string;
	readonly value: ReactNode;
	readonly delta?: string;
	readonly trend?: AuroraTrend;
	readonly comparison?: string;
	readonly emphasis?: "default" | "danger";
}

export interface AuroraMetricGridProps {
	readonly items: readonly AuroraMetricItem[];
	readonly columns?: 4 | 6;
	readonly ariaLabel?: string;
}

export function AuroraMetricGrid({
	items,
	columns = 6,
	ariaLabel = "总览指标",
}: AuroraMetricGridProps): React.ReactElement {
	const colClass = columns === 4 ? styles.cols4 : styles.cols6;
	return (
		<section className={`${styles.row} ${colClass}`} aria-label={ariaLabel}>
			{items.map((item) => (
				<MetricCard key={item.id} item={item} />
			))}
		</section>
	);
}

function MetricCard({ item }: { item: AuroraMetricItem }): React.ReactElement {
	const trendClass =
		item.trend === "up" ? styles.trendUp : item.trend === "down" ? styles.trendDown : styles.trendFlat;
	const valueClass = item.emphasis === "danger" ? styles.valueDanger : "";
	return (
		<article className={styles.card}>
			<header className={styles.label}>{item.label}</header>
			<div className={`${styles.value} ${valueClass}`}>{item.value}</div>
			{(item.delta || item.comparison) && (
				<footer className={styles.footer}>
					{item.delta && item.trend ? (
						<span className={`${styles.delta} ${trendClass}`}>
							<span aria-hidden="true" className={styles.arrow}>
								{item.trend === "up" ? "↑" : item.trend === "down" ? "↓" : "→"}
							</span>
							{item.delta}
						</span>
					) : null}
					{item.comparison ? <span className={styles.comparison}>{item.comparison}</span> : null}
				</footer>
			)}
		</article>
	);
}
