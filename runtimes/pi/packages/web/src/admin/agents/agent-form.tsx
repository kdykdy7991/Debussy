/**
 * Agent 配置表单（WB-003 / SPEC §5.2）。
 *
 * 字段映射 SPEC §5.2 tab 1：System Prompt、模型、参数、工具、知识库、
 * 能力（语音 / Avatar / 附件 / Citation / Realtime / Web 搜索）。
 *
 * 表单永远编辑 `draft`（来自 AgentState），不直接改 saved snapshot。
 * dirty 检测由父级 `editDraft` 统一完成（结构比较）。
 */
import type {
	AgentCapabilities,
	AgentConfigSnapshot,
	AgentModelParameters,
	LlmAvailableModel,
} from "@earendil-works/pi-protocol";
import { useId } from "react";
import { productReasoningEfforts } from "./reasoning-efforts.ts";

export interface AgentFormProps {
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
	readonly models?: readonly LlmAvailableModel[];
}

const CAPABILITY_LABELS: Record<keyof AgentCapabilities, string> = {
	liveSpeech: "实时语音",
	avatar: "Avatar",
	attachments: "附件上传",
	citations: "引用检索",
	realtime: "Realtime",
	webSearch: "Web 搜索",
};

export function AgentForm({ draft, onEdit, models = [] }: AgentFormProps): React.ReactElement {
	const promptId = useId();
	const modelId = useId();
	const toolIdsId = useId();
	const knowledgeIdsId = useId();
	const selectedModel = models.find((model) => model.id === draft.modelId);
	const updateParameters = (parameters: AgentModelParameters) => onEdit({ parameters });
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
			<datalist id={`${modelId}-options`}>
				{models.map((model) => (
					<option
						key={`${model.provider}/${model.id}`}
						value={model.id}
					>{`${model.name} (${model.provider})`}</option>
				))}
			</datalist>
			<ModelParametersEditor model={selectedModel} parameters={draft.parameters} onChange={updateParameters} />
			<div>
				<label htmlFor={modelId}>Model ID</label>
				<input
					id={modelId}
					type="text"
					list={`${modelId}-options`}
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

function ModelParametersEditor({
	model,
	parameters,
	onChange,
}: {
	readonly model: LlmAvailableModel | undefined;
	readonly parameters: AgentModelParameters;
	readonly onChange: (parameters: AgentModelParameters) => void;
}): React.ReactElement {
	if (model === undefined) {
		return (
			<fieldset>
				<legend>模型参数</legend>
				<p>请从模型目录选择可用模型后配置参数。参数能力由服务端模型目录决定。</p>
			</fieldset>
		);
	}
	const capabilities = model.parameterCapabilities;
	const reasoningEfforts = productReasoningEfforts(capabilities.reasoning.efforts);
	const setReasoning = (patch: Partial<NonNullable<AgentModelParameters["reasoning"]>>) =>
		onChange({ ...parameters, reasoning: { ...parameters.reasoning, ...patch } });
	return (
		<fieldset id="model-parameters" className="agent-model-parameters">
			<legend>思考设置 · {model.name}</legend>
			{capabilities.reasoning.toggle ? (
				<label>
					<input
						type="checkbox"
						checked={parameters.reasoning?.enabled ?? true}
						onChange={(event) => setReasoning({ enabled: event.currentTarget.checked })}
					/>
					开启深度思考
				</label>
			) : null}
			{reasoningEfforts.length > 0 ? (
				<div>
					<label htmlFor="agent-reasoning-effort">默认思考强度</label>
					<select
						id="agent-reasoning-effort"
						value={parameters.reasoning?.effort ?? ""}
						onChange={(event) =>
							setReasoning({
								effort: event.currentTarget.value === "" ? undefined : (event.currentTarget.value as never),
							})
						}
					>
						<option value="">
							模型默认{capabilities.reasoning.defaultEffort ? ` (${capabilities.reasoning.defaultEffort})` : ""}
						</option>
						{reasoningEfforts.map((effort) => (
							<option key={effort.value} value={effort.value}>
								{effort.label} ({effort.value})
							</option>
						))}
					</select>
				</div>
			) : null}
			<p>采样、输出长度等生成参数由服务端代码固定，不在控制台开放修改。</p>
		</fieldset>
	);
}
