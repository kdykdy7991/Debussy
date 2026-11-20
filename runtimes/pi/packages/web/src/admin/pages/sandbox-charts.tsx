import type { AdminSandboxStatistics } from "@earendil-works/pi-protocol";
import { type CSSProperties, useId } from "react";
import { beijingDate } from "../beijing-time.ts";
import styles from "./sandbox-page.module.css";

const percent = new Intl.NumberFormat("zh-CN", {
	style: "percent",
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});
const countLabel = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

export function SandboxTrend({ trend, total }: Pick<AdminSandboxStatistics, "trend" | "total">) {
	const fillId = useId();
	const points = trend ?? [];
	const peak = points.reduce((max, point) => Math.max(max, point.count), 0);
	const rawStep = Math.max(1, peak / 4);
	const magnitude = 10 ** Math.floor(Math.log10(rawStep));
	const step = ([1, 2, 5, 10].find((factor) => factor * magnitude >= rawStep) ?? 10) * magnitude;
	const ticks = [4, 3, 2, 1, 0].map((tick) => tick * step);
	const width = 600;
	const height = 95;
	const hourly = points.length > 1 && Date.parse(points[1].startAt) - Date.parse(points[0].startAt) === 3_600_000;
	const interval = Math.max(1, Math.ceil((points.length - 1) / 6));
	const coordinates = points.map((point, index) => ({
		x: points.length === 1 ? width / 2 : (index * width) / (points.length - 1),
		y: height * (1 - point.count / (4 * step)),
		label: beijingDate(new Date(point.startAt))
			.toISOString()
			.slice(hourly ? 11 : 5, hourly ? 16 : 10),
		...point,
	}));
	const line = coordinates.map(({ x, y }) => `${x},${y}`).join(" ");

	return (
		<section className={`${styles.card} ${styles.chartCard}`} aria-labelledby="sandbox-trend">
			<h2 id="sandbox-trend">执行趋势</h2>
			{!total || points.length === 0 ? (
				<p className={styles.chartEmpty}>{total ? "暂无趋势数据。" : "该时间范围内暂无执行。"}</p>
			) : (
				<div className={styles.trendChart}>
					<div className={styles.yAxis} aria-hidden="true">
						{ticks.map((tick) => (
							<span key={tick}>{countLabel.format(tick)}</span>
						))}
					</div>
					<div className={styles.plot}>
						<svg
							className={styles.trendSvg}
							viewBox={`0 0 ${width} ${height}`}
							preserveAspectRatio="none"
							role="img"
							aria-label={hourly ? "北京时间每小时执行次数" : "北京时间每日执行次数"}
						>
							<defs>
								<linearGradient id={fillId} x2="0" y2="100%" gradientUnits="objectBoundingBox">
									<stop offset="0" stopColor="var(--sandbox-accent)" stopOpacity=".22" />
									<stop offset="1" stopColor="var(--sandbox-accent)" stopOpacity=".03" />
								</linearGradient>
							</defs>
							{ticks.map((tick, index) => (
								<line
									key={tick}
									x1="0"
									x2={width}
									y1={(index * height) / 4}
									y2={(index * height) / 4}
									stroke="var(--sandbox-line)"
									vectorEffect="non-scaling-stroke"
								/>
							))}
							<polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#${fillId})`} />
							<polyline
								points={line}
								fill="none"
								stroke="var(--sandbox-accent)"
								strokeWidth="1.8"
								vectorEffect="non-scaling-stroke"
							/>
							{coordinates.map(({ x, y, startAt, label, count }) => (
								<circle
									key={startAt}
									cx={x}
									cy={y}
									r={coordinates.length > 12 ? 1.8 : 2.7}
									fill="white"
									stroke="var(--sandbox-accent)"
									strokeWidth="1.4"
									vectorEffect="non-scaling-stroke"
								>
									<title>{`${label} · ${count.toLocaleString()} 次`}</title>
								</circle>
							))}
						</svg>
						<div className={styles.xAxis} aria-hidden="true">
							{coordinates
								.filter(
									(_, index) =>
										(index % interval === 0 && index < coordinates.length - interval / 2) ||
										index === coordinates.length - 1,
								)
								.map(({ x, label, startAt }) => (
									<span key={startAt} style={{ left: `${(x / width) * 100}%` }}>
										{label}
									</span>
								))}
						</div>
					</div>
				</div>
			)}
		</section>
	);
}

export function SandboxDistribution({ counts, total }: Pick<AdminSandboxStatistics, "counts" | "total">) {
	const groups = [
		{ tone: "success", label: "执行成功", count: counts.success },
		{ tone: "timeout", label: "超时 / 取消", count: counts.timeout + counts.canceled },
		{ tone: "command_failed", label: "命令失败", count: counts.command_failed },
		{ tone: "start_failed", label: "启动失败", count: counts.start_failed },
	];
	let from = 0;
	const segments = groups
		.filter(({ count }) => count > 0)
		.map(({ tone, count }) => {
			const to = from + (count / total) * 100;
			const segment = `var(--sandbox-${tone}) ${from}% ${to}%`;
			from = to;
			return segment;
		});
	return (
		<section className={`${styles.card} ${styles.chartCard}`} aria-labelledby="sandbox-distribution">
			<h2 id="sandbox-distribution">执行结果分布</h2>
			<div className={styles.distribution}>
				<div
					className={styles.donut}
					style={
						{
							"--donut-fill": segments.length > 0 ? `conic-gradient(${segments.join(",")})` : undefined,
						} as CSSProperties
					}
					aria-hidden="true"
				>
					<div>
						<strong>{total.toLocaleString()}</strong>
						<small>总次数</small>
					</div>
				</div>
				<dl className={styles.legend}>
					{groups.map(({ tone, label, count }) => (
						<div key={tone}>
							<dt>
								<i data-tone={tone} />
								{label}
							</dt>
							<dd>{count.toLocaleString()}</dd>
							<dd>{total ? percent.format(count / total) : "—"}</dd>
						</div>
					))}
				</dl>
			</div>
		</section>
	);
}
