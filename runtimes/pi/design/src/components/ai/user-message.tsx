import { cx } from "../../lib/utils";

/**
 * 用户消息：右对齐、受限宽度（62%）、紧凑排版。
 * 视觉形态由 UI pattern layer 决定；本组件只表达语义。
 *
 * @example
 * <UserMessage attachments={["q3_orders.csv", "growth_q3_export.xlsx"]}>
 *   结合上季度的增长复盘和这份订单数据，告诉我 Q3 增长主要来自哪里。
 * </UserMessage>
 */
export type UserMessageProps = {
	children: React.ReactNode;
	/** plain：问候/短句，无背景、弱色。 */
	variant?: "default" | "plain";
	/** 附件文件名；多文件合并为一个 chip（见 COMPONENT_PATTERNS.md §1）。 */
	attachments?: readonly string[];
};

export function UserMessage({ children, variant = "default", attachments }: UserMessageProps) {
	return (
		<div className={cx("ai-user", variant === "plain" && "is-plain")}>
			<div className="ai-user-bubble">
				{attachments && attachments.length > 0 ? (
					<span className="ai-user-att">
						<span aria-hidden>📎</span>
						{attachments.join(" · ")}
					</span>
				) : null}
				<span className="ai-user-text">{children}</span>
			</div>
		</div>
	);
}
