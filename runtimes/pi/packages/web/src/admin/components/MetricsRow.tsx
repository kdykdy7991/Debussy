/**
 * 指标行（设计收口 / MVP-15）。展示一组并排的 metric 卡。
 *
 * 每个 metric：上为浅小 label，下为大数字，再下为趋势（可选）。
 * 当前默认横向 6 列；>= 1280px 一行，< 1024px 自动 wrap 成 2 列。
 */
import styles from "./MetricsRow.module.css";

export type TrendDirection = "up" | "down" | "flat";

export interface MetricItem {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	/** 趋势变化，例如 "12.5%" 或 "+12.5%"。 */
	readonly delta?: string;
	readonly trend?: TrendDirection;
	/** 与上一周期比较的描述，例如 "较上周期"。 */
	readonly comparison?: string;
	/** 强调色覆盖（仅用于 special 用法）。 */
	readonly emphasis?: "default" | "danger";
}

export interface MetricsRowProps {
	readonly items: readonly MetricItem[];
	readonly columns?: 4 | 6;
}

export function MetricsRow({ items, columns = 6 }: MetricsRowProps): React.ReactElement {
	return (
		<section className={`${styles.row} ${columns === 4 ? styles.cols4 : styles.cols6}`} aria-label="会话总览指标">
			{items.map((item) => (
				<article key={item.id} className={styles.metric}>
					<header className={styles.metricLabel}>{item.label}</header>
					<div className={styles.metricValue}>{item.value}</div>
					{item.delta || item.comparison ? (
						<footer className={styles.metricFooter}>
							{item.delta && item.trend ? (
								<span
									className={`${styles.delta} ${
										item.trend === "up"
											? styles.trendUp
											: item.trend === "down"
												? styles.trendDown
												: styles.trendFlat
									}`}
								>
									<span aria-hidden="true" className={styles.arrow}>
										{item.trend === "up" ? "↑" : item.trend === "down" ? "↓" : "→"}
									</span>
									{item.delta}
								</span>
							) : null}
							{item.comparison ? <span className={styles.comparison}>{item.comparison}</span> : null}
						</footer>
					) : null}
				</article>
			))}
		</section>
	);
}
