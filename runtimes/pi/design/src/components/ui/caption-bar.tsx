import type { ReactNode } from "react";

export type CaptionBarProps = {
	/** 左槽：容器名称。 */
	title: string;
	/** 右槽：数据源 / 单位（更弱一档）。 */
	trailing?: ReactNode;
};

/**
 * 数据容器 caption（DataTable / ChartContainer 共用契约）。
 * 没有 caption 的容器不允许存在 —— 见 COMPONENT_PATTERNS.md §0。
 */
export function CaptionBar({ title, trailing }: CaptionBarProps) {
	return (
		<div className="ai-cap">
			<span>{title}</span>
			{trailing ? <span className="ai-cap-trailing">{trailing}</span> : null}
		</div>
	);
}
