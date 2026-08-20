import { cx } from "../../lib/utils";

export type DotState = "idle" | "active" | "done" | "error";

export type StatusDotProps = {
	/** 语义状态；视觉（颜色/形状）由 UI pattern layer 决定。 */
	state: DotState;
	/** 是否叠加 status-running pulse。仅限当前 running 的指示点（视口内至多一个）。 */
	pulsing?: boolean;
};

/** 8px 状态点（AssistantSignature 用）。视觉细节全部在 ai.css。 */
export function StatusDot({ state, pulsing = false }: StatusDotProps) {
	return <span aria-hidden className={cx("ai-dot", `is-${state}`, pulsing && "ai-status-running")} />;
}
