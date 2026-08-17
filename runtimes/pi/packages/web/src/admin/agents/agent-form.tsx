/**
 * Agent 配置表单（WB-003 / SPEC §5.2）。
 *
 * 字段映射 SPEC §5.2 tab 1：System Prompt、模型、参数、工具、知识库、
 * 能力（语音 / Avatar / 附件 / Citation / Realtime / Web 搜索）。
 *
 * 表单永远编辑 `draft`（来自 AgentState），不直接改 saved snapshot。
 * dirty 检测由父级 `editDraft` 统一完成（结构比较）。
 */
import type { AgentCapabilities, AgentConfigSnapshot } from "@earendil-works/pi-protocol";
import { useId } from "react";

export interface AgentFormProps {
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
}

const CAPABILITY_LABELS: Record<keyof AgentCapabilities, string> = {
	liveSpeech: "实时语音",
	avatar: "Avatar",
	attachments: "附件上传",
	citations: "引用检索",
	realtime: "Realtime",
	webSearch: "Web 搜索",
};

export function AgentForm({ draft, onEdit }: AgentFormProps): React.ReactElement {
	const promptId = useId();
	const modelId = useId();
	const toolIdsId = useId();
	const knowledgeIdsId = useId();
	return (
		<form onSubmit={(e) => e.preventDefault()}>
			<div>
				<label htmlFor={promptId}>System Prompt</label>
				<textarea
					id={promptId}
					rows={8}
					value={draft.systemPrompt}
					onChange={(e) => onEdit({ systemPrompt: e.currentTarget.value })}
				/>
			</div>
			<div>
				<label htmlFor={modelId}>Model ID</label>
				<input
					id={modelId}
					type="text"
					value={draft.modelId ?? ""}
					onChange={(e) => onEdit({ modelId: e.currentTarget.value === "" ? null : e.currentTarget.value })}
				/>
			</div>
			<div>
				<label htmlFor={toolIdsId}>工具 ID（逗号分隔）</label>
				<input
					id={toolIdsId}
					type="text"
					value={draft.toolIds.join(",")}
					onChange={(e) =>
						onEdit({
							toolIds: e.currentTarget.value
								.split(",")
								.map((s) => s.trim())
								.filter((s) => s.length > 0),
						})
					}
				/>
			</div>
			<div>
				<label htmlFor={knowledgeIdsId}>知识库 ID（逗号分隔）</label>
				<input
					id={knowledgeIdsId}
					type="text"
					value={draft.knowledgeBaseIds.join(",")}
					onChange={(e) =>
						onEdit({
							knowledgeBaseIds: e.currentTarget.value
								.split(",")
								.map((s) => s.trim())
								.filter((s) => s.length > 0),
						})
					}
				/>
			</div>
			<fieldset>
				<legend>能力</legend>
				{(Object.keys(CAPABILITY_LABELS) as (keyof AgentCapabilities)[]).map((key) => (
					<label key={key} style={{ display: "block" }}>
						<input
							type="checkbox"
							checked={draft.capabilities[key]}
							onChange={(e) =>
								onEdit({
									capabilities: { ...draft.capabilities, [key]: e.currentTarget.checked },
								})
							}
						/>
						{CAPABILITY_LABELS[key]}
					</label>
				))}
			</fieldset>
		</form>
	);
}
