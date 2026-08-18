import { cx } from "../../lib/utils";
import { Pill, type PillTone } from "../ui/pill";

export type ArtifactSectionData = {
	index: number | string;
	name: string;
	/** 关键结果（一行）。 */
	headline: string;
	/** 弱色摘要（一行）。 */
	summary?: string;
	/** 风险章节：章名 danger 级。 */
	risk?: boolean;
};

export type ReportArtifactProps = {
	/** 类型 eyebrow，如 "管理纪要 · 草稿"。 */
	eyebrow: string;
	title: string;
	/** 受众 · 依据 · 校验事实（"·" 分隔；校验事实如 "数字校验 14 / 14" 必带）。 */
	meta?: string;
	/** 状态 badge 文本（草稿 / 待审阅 / 已定稿 …）。 */
	status?: string;
	statusTone?: PillTone;
	/**
	 * 章节列表（TOC，不是内容）：内容进 reading view / 导出。
	 * 见 COMPONENT_PATTERNS.md §8。
	 */
	sections: readonly ArtifactSectionData[];
};

/**
 * 报告 Artifact：交付物 = 有身份、有状态、自成一体的块。
 * header（eyebrow/title/meta/status badge）+ body（章节 TOC）。
 * Actions 在 artifact 之外（属于 AssistantResponse）。
 */
export function ReportArtifact({
	eyebrow,
	title,
	meta,
	status,
	statusTone = "accent",
	sections
}: ReportArtifactProps) {
	return (
		<div className="ai-artifact">
			<div className="ai-artifact-head">
				<div>
					<div className="ai-artifact-eyebrow">{eyebrow}</div>
					<h3 className="ai-artifact-title">{title}</h3>
					{meta ? <div className="ai-artifact-meta">{meta}</div> : null}
				</div>
				{status ? <Pill tone={statusTone}>{status}</Pill> : null}
			</div>
			<div className="ai-artifact-body">
				{sections.map((section) => (
					<div key={section.index} className={cx("ai-artifact-sec", section.risk && "is-risk")}>
						<div className="ai-artifact-sec-no">
							<i>{String(section.index).padStart(2, "0")}</i>
							{section.name}
						</div>
						<div className="ai-artifact-sec-t">
							{section.headline}
							{section.summary ? <span>{section.summary}</span> : null}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
