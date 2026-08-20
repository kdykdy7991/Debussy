import { cx } from "../../lib/utils";

export type MessageActionItem = {
	label: string;
	/** key action（accent + 箭头）：建议的下一步。至多 1 个。 */
	key?: boolean;
	onClick?: () => void;
};

export type MessageActionsProps = {
	/** ≤ 4 项。 */
	items: readonly MessageActionItem[];
	/**
	 * 控制 actions-enter：生成中 false（隐藏），完成/失败后 true（渐入）。
	 * Plain 形态不使用 actions。
	 */
	visible?: boolean;
};

/**
 * 消息操作行（afoot）：位于 answer 末尾、artifact 之外。
 * 破坏性操作不进此行（进确认层）。
 */
export function MessageActions({ items, visible = true }: MessageActionsProps) {
	return (
		<div className={cx("ai-actions", visible && "is-visible")}>
			{items.map((item) => (
				<button
					key={item.label}
					type="button"
					className={cx("ai-actions-item", item.key && "is-key")}
					onClick={item.onClick}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}
