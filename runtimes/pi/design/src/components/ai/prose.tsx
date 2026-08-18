import type { ReactNode } from "react";
import { cx } from "../../lib/utils";

export type ProseProps = {
	children: ReactNode;
	/**
	 * streaming：子级语义块（p / h3 小节 / 表 / 图 / sources）挂载时
	 * 逐个 motion-enter-soft-y 出现。块级是最小动画粒度，token 不动画。
	 */
	streaming?: boolean;
	/** plain：单段短回复（16px/1.8，无 lede/小节节奏）。 */
	plain?: boolean;
};

/**
 * 正文阅读容器（reading canvas 的 prose 上下文）：
 * 16px/1.9、段落 1.3em、strong/code 语义样式。
 */
export function Prose({ children, streaming = false, plain = false }: ProseProps) {
	return (
		<div className={cx("ai-prose", plain && "is-plain", streaming && "is-streaming")}>{children}</div>
	);
}

/** 导语：display 级，每篇 answer 至多 1 处，必须为首块。 */
export function Lede({ children }: { children: ReactNode }) {
	return <p className="ai-lede">{children}</p>;
}

/** 编号小节标题（01 / 02 / …）。多小节 answer 必须编号且顺序递增。 */
export function Section({ index, children }: { index: number | string; children: ReactNode }) {
	return (
		<h3 className="ai-section">
			<span className="ai-section-no">{String(index).padStart(2, "0")}</span>
			{children}
		</h3>
	);
}
