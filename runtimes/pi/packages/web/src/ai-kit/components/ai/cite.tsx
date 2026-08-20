import type { MouseEventHandler } from "react";

export type CiteProps = {
	/** 来源编号；必须与 Sources 列表中的 id 一一对应。 */
	index: number;
	onClick?: MouseEventHandler<HTMLButtonElement>;
};

/** 内联引用芯片：编号 → Sources 项的 1:1 映射（INTERACTION.md §6）。 */
export function Cite({ index, onClick }: CiteProps) {
	return (
		<button type="button" className="ai-cite" onClick={onClick} aria-label={`来源 ${index}`}>
			{index}
		</button>
	);
}
