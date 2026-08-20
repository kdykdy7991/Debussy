import type { ReactNode } from "react";
import { cx } from "../../lib/utils";

export type PillTone = "neutral" | "accent" | "success" | "danger";

export type PillProps = {
	tone?: PillTone;
	children: ReactNode;
};

/** 徽章/状态标签（source type、artifact status badge）。 */
export function Pill({ tone = "neutral", children }: PillProps) {
	return <span className={cx("ai-pill", `tone-${tone}`)}>{children}</span>;
}
