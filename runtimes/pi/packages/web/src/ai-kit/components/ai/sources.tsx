import { cx } from "../../lib/utils";
import { Pill } from "../ui/pill";

export type SourceItemData = {
	/** 编号；与正文 Cite 芯片一一对应。 */
	id: number;
	title: string;
	/** 弱色 meta：组织 · 日期 · 页数 · 命中数，"·" 分隔。 */
	meta?: string;
	/** 类型徽章文本（知识库 / 共享盘 / 外部 …）。 */
	type?: string;
	/** 外部来源 → 中性徽章。 */
	external?: boolean;
};

export type SourcesProps = {
	sources: readonly SourceItemData[];
	/** Cite 锚定高亮（业务层控制：Cite 点击 → 置为该 id）。 */
	activeId?: number | null;
	onSourceClick?: (id: number) => void;
};

/**
 * 来源列表：label "来源 · N" + item（索引 / 标题+meta / 类型徽章）。
 * 2px accent 左线 + hover 位移 3px（COMPONENT_PATTERNS.md §7）。
 * 被 cite 而未列入 = 违规；列入而未被 cite 允许。
 */
export function Sources({ sources, activeId, onSourceClick }: SourcesProps) {
	return (
		<div className="ai-sources">
			<div className="ai-sources-label">来源 · {sources.length}</div>
			{sources.map((source) => (
				<button
					type="button"
					key={source.id}
					className={cx("ai-source", activeId === source.id && "is-active")}
					onClick={() => onSourceClick?.(source.id)}
				>
					<span className="ai-source-n">{source.id}</span>
					<span className="ai-source-t">
						{source.title}
						{source.meta ? <span className="ai-source-meta">{source.meta}</span> : null}
					</span>
					{source.type ? <Pill tone={source.external ? "neutral" : "accent"}>{source.type}</Pill> : null}
				</button>
			))}
		</div>
	);
}
