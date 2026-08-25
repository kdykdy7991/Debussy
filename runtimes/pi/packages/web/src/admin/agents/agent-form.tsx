/**
 * Agent 配置表单（WB-003 / SPEC §5.2；阶段一收口）。
 *
 * 字段映射 SPEC §5.2 tab 1：System Prompt、模型、参数、工具、知识库、
 * 能力（语音 / Avatar / 附件）。阶段一真实性收口后只暴露真正会持久化
 * 的能力开关：`attachments`、`avatar`、`liveSpeech`。
 *
 * `liveSpeech` 仅作为实验性开关暴露（标注"实验性 / 当前文本版本未纳入
 * 验收"），`citations` / `realtime` / `webSearch` 协议层字段保留以便旧
 * Revision 仍可解码，但前端不渲染任何写入入口，且永不在保存时改写其
 * 已有值（详见 `agent-state.ts` 的 `buildSaveRequest`）。
 *
 * 工具 / 知识库：阶段一收口后**禁止新增任意 ID**。表单只显示已有引用为
 * 只读标签，并允许逐项移除或一次性清空；产品化的"添加工具 / 知识库"入口
 * 尚未开放，无引用时如实显示「尚未产品化」。
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

/**
 * 阶段一：仅暴露真正会持久化的能力开关。其它键保留在协议类型中以保证旧
 * Revision 仍可解码（`saved.capabilities` 透传至 `buildSaveRequest`）。
 */
type EditableCapability = "attachments" | "avatar" | "liveSpeech";

const EDITABLE_CAPABILITIES: readonly {
	readonly key: EditableCapability;
	readonly label: string;
	readonly description?: string;
	readonly experimental?: boolean;
}[] = [
	{ key: "attachments", label: "附件上传", description: "允许用户在对话里上传附件（图片、文档等）。" },
	{ key: "avatar", label: "Avatar", description: "启用 Agent Avatar（多模态头像表达）。" },
	{
		key: "liveSpeech",
		label: "实时语音（实验性）",
		description: "实验性开关：当前文本版本未纳入验收，启用与否不会改变行为。",
		experimental: true,
	},
];

export function AgentForm({ draft, onEdit, models = [] }: AgentFormProps): React.ReactElement {
	const promptId = useId();
	const modelId = useId();
	const selectedModel = models.find((model) => model.id === draft.modelId);
	const updateParameters = (parameters: AgentModelParameters) => onEdit({ parameters });
	const updateCapability = (key: EditableCapability, value: boolean) => {
		// 阶段一约束：只更新可编辑的 key；其它（citations / realtime /
		// webSearch）保持对象引用不变，避免保存时把旧值意外改写。
		const nextCapabilities: AgentCapabilities = { ...draft.capabilities, [key]: value };
		onEdit({ capabilities: nextCapabilities });
	};
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

			<ReadOnlyReferenceList
				legend="工具"
				hint="只读：阶段一不允许新增任意 ID；移除后必须保存为新 Revision 才会持久化。"
				emptyText="尚未产品化 — 此 Agent 尚未引用任何工具。"
				items={draft.toolIds}
				onRemove={(id) => onEdit({ toolIds: draft.toolIds.filter((existing) => existing !== id) })}
				onClearAll={() => onEdit({ toolIds: [] })}
			/>

			<ReadOnlyReferenceList
				legend="知识库"
				hint="只读：阶段一不允许新增任意 ID；移除后必须保存为新 Revision 才会持久化。"
				emptyText="尚未产品化 — 此 Agent 尚未引用任何知识库。"
				items={draft.knowledgeBaseIds}
				onRemove={(id) =>
					onEdit({ knowledgeBaseIds: draft.knowledgeBaseIds.filter((existing) => existing !== id) })
				}
				onClearAll={() => onEdit({ knowledgeBaseIds: [] })}
			/>

			<fieldset>
				<legend>能力</legend>
				<p className="agent-form__hint">
					阶段一：仅下列能力开关会真正保存并立即生效；其它能力（引用检索、Realtime、Web 搜索）
					未对管理员开放写入入口，亦不会在保存时改写已有值。
				</p>
				{EDITABLE_CAPABILITIES.map(({ key, label, description, experimental }) => (
					<label key={key} style={{ display: "block" }}>
						<input
							type="checkbox"
							checked={draft.capabilities[key]}
							onChange={(e) => updateCapability(key, e.currentTarget.checked)}
						/>
						{label}
						{experimental ? <em data-experimental="true">（实验性）</em> : null}
					</label>
				))}
				{EDITABLE_CAPABILITIES.map(({ key, description }) =>
					description === undefined ? null : (
						<p key={`${key}-desc`} className="agent-form__capability-desc">
							{description}
						</p>
					),
				)}
			</fieldset>
		</form>
	);
}

/**
 * 只读引用列表：用于工具 / 知识库。无任何 ID 添加入口；只展示已有引用，
 * 并允许逐项移除或一次性清空。空态明确写出"尚未产品化"。
 */
function ReadOnlyReferenceList({
	legend,
	hint,
	emptyText,
	items,
	onRemove,
	onClearAll,
}: {
	readonly legend: string;
	readonly hint: string;
	readonly emptyText: string;
	readonly items: readonly string[];
	readonly onRemove: (id: string) => void;
	readonly onClearAll: () => void;
}): React.ReactElement {
	const fieldsetId = useId();
	const listId = `${fieldsetId}-items`;
	return (
		<fieldset aria-describedby={`${fieldsetId}-hint`}>
			<legend>{legend}</legend>
			<p id={`${fieldsetId}-hint`} className="agent-form__hint">
				{hint}
			</p>
			{items.length === 0 ? (
				<p className="agent-form__empty" data-empty-state="true">
					{emptyText}
				</p>
			) : (
				<div>
					<ul id={listId} className="agent-form__ref-list">
						{items.map((id) => (
							<li key={id} className="agent-form__ref-item">
								<code className="agent-form__ref-id" title={id}>
									{id}
								</code>
								<button
									type="button"
									className="agent-form__ref-remove"
									aria-label={`移除 ${legend} ${id}`}
									onClick={() => onRemove(id)}
								>
									移除
								</button>
							</li>
						))}
					</ul>
					{items.length > 1 ? (
						<button type="button" className="agent-form__ref-clear" onClick={onClearAll}>
							全部移除（{items.length}）
						</button>
					) : null}
				</div>
			)}
		</fieldset>
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