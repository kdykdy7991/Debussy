import type { ReactNode } from "react";
import { cx } from "../../lib/utils";

export type AssistantResponseProps = {
	/**
	 * 自由组合：AssistantSignature（首）→ Prose / Lede / DataTable /
	 * ChartContainer / ReportArtifact / Sources → MessageActions（尾）。
	 * 不要求所有子组件出现；形态由交付物性质决定（LAYOUT.md §2.4）。
	 */
	children: ReactNode;
	/** 右侧 Agent rail（<AgentTrace/>）。缺省 → single column。 */
	rail?: ReactNode;
};

/**
 * Assistant 响应 = reading canvas，不是 chat bubble：
 * 整体无背景无边框；grid [reading 列 | rail 250px]，gap 40px。
 * <1100px 时 rail 原位内联到 answer 之后（trace 保持可达）。
 */
export function AssistantResponse({ children, rail }: AssistantResponseProps) {
	return (
		<div className={cx("ai-turn", !rail && "no-rail")}>
			<div className="ai-reading">{children}</div>
			{rail ? <aside className="ai-rail">{rail}</aside> : null}
		</div>
	);
}
