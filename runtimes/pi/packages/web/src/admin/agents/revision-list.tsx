/**
 * Revision 列表（WB-003 / SPEC §5.2）。
 *
 * 展示 Agent 历史 revision，附带 diff 摘要。点击可展开 diffFromPrevious
 * 详细变更（prompt delta、tools added/removed、capabilities 等）。
 */

import type { AgentDefinitionRevision } from "@earendil-works/pi-protocol";
import { Fragment, useState } from "react";

export interface RevisionListProps {
	readonly items: readonly AgentDefinitionRevision[];
}

export function RevisionList({ items }: RevisionListProps): React.ReactElement {
	const [open, setOpen] = useState<string | null>(null);
	return (
		<table>
			<thead>
				<tr>
					<th>Revision</th>
					<th>Source Hash</th>
					<th>创建时间</th>
					<th>变更字段</th>
				</tr>
			</thead>
			<tbody>
				{items.map((rev) => {
					const key = `${rev.id}-${rev.revision}`;
					const isOpen = open === key;
					return (
						<Fragment key={key}>
							<tr>
								<td>#{rev.revision}</td>
								<td>{rev.sourceHash.slice(0, 12)}…</td>
								<td>{rev.createdAt}</td>
								<td>
									{rev.diffFromPrevious === null
										? "首次"
										: rev.diffFromPrevious.changedFields.join(", ") || "（无字段级差异）"}
								</td>
								<td>
									<button type="button" onClick={() => setOpen(isOpen ? null : key)}>
										{isOpen ? "收起" : "查看 Diff"}
									</button>
								</td>
							</tr>
							{isOpen ? (
								<tr>
									<td colSpan={5}>
										<DiffView diff={rev.diffFromPrevious} />
									</td>
								</tr>
							) : null}
						</Fragment>
					);
				})}
			</tbody>
		</table>
	);
}

function DiffView({ diff }: { diff: AgentDefinitionRevision["diffFromPrevious"] }): React.ReactElement {
	if (diff === null) return <p>首次 Revision，无 diff</p>;
	return (
		<div>
			<p>变更字段: {diff.changedFields.join(", ") || "（无）"}</p>
			{diff.toolsAdded.length > 0 ? <p>+ 工具: {diff.toolsAdded.join(", ")}</p> : null}
			{diff.toolsRemoved.length > 0 ? <p>- 工具: {diff.toolsRemoved.join(", ")}</p> : null}
			{diff.knowledgeAdded.length > 0 ? <p>+ 知识库: {diff.knowledgeAdded.join(", ")}</p> : null}
			{diff.knowledgeRemoved.length > 0 ? <p>- 知识库: {diff.knowledgeRemoved.join(", ")}</p> : null}
		</div>
	);
}
