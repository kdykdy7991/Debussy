import { type ReactNode, useEffect, useState } from "react";
import { usePrefersReducedMotion } from "../../lib/motion";
import { cx } from "../../lib/utils";
import { CaptionBar } from "../ui/caption-bar";

export type ChartBar = {
	value: number;
	/** 单个柱强调（accent 级）；与 highlightIndex 二选一。 */
	highlight?: boolean;
};

export type ChartContainerProps = {
	/** caption 左槽：图名。 */
	caption: string;
	/** caption 右槽：单位 / 来源（如 "百万元"）。 */
	unit?: string;
	/** 内置柱状 plot（data-enter：height 0 → value，1s）。不传则用 children 自定义 plot。 */
	bars?: readonly ChartBar[];
	/** x 轴标签（与 bars 一一对应）。 */
	xLabels?: readonly string[];
	/** 强调柱索引（accent 级，不另设配色）。 */
	highlightIndex?: number;
	/** plot region 高度（px，默认 token 130px）。 */
	plotHeight?: number;
	/** 自定义 plot 内容（SVG / canvas 等）；与 bars 互斥。 */
	children?: ReactNode;
};

/**
 * 图表容器：caption（名+单位）+ 固定高 plot region + x 轴标签。
 * 只规范容器，不规定图表配色；强调点用主题 accent（COMPONENT_PATTERNS.md §6）。
 * 图表首次渲染用 motion-data-enter；前后必须有 prose 上下文。
 */
export function ChartContainer({
	caption,
	unit,
	bars,
	xLabels,
	highlightIndex,
	plotHeight,
	children,
}: ChartContainerProps) {
	const reduced = usePrefersReducedMotion();
	const [grown, setGrown] = useState(reduced);

	// data-enter：挂载后 0 → 终值（双 rAF 保证浏览器先绘出 0 态再过渡）
	useEffect(() => {
		if (grown) return;
		if (reduced) {
			setGrown(true);
			return;
		}
		const raf = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
		return () => cancelAnimationFrame(raf);
	}, [grown, reduced]);

	const max = bars && bars.length > 0 ? Math.max(...bars.map((b) => b.value)) : 0;

	return (
		<div className="ai-chart">
			<CaptionBar title={caption} trailing={unit} />
			<div className="ai-chart-plot" style={plotHeight ? { height: plotHeight } : undefined}>
				{bars && bars.length > 0 ? (
					<div className="ai-chart-bars">
						{bars.map((bar, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: chart bars/x-labels are positional fixture data.
							<div className="ai-chart-col" key={i}>
								<div
									className={cx("ai-chart-fill", (bar.highlight ?? i === highlightIndex) && "is-highlight")}
									data-v={bar.value}
									style={{ height: grown ? `${max > 0 ? (bar.value / max) * 100 : 0}%` : "0%" }}
									role="img"
									aria-label={`${xLabels?.[i] ?? `第 ${i + 1} 项`}：${bar.value}`}
								/>
							</div>
						))}
					</div>
				) : (
					children
				)}
			</div>
			{bars && xLabels && xLabels.length > 0 ? (
				<div className="ai-chart-x">
					{xLabels.map((label, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: chart x labels match bar index (positional).
						<span key={i}>{label}</span>
					))}
				</div>
			) : null}
		</div>
	);
}
