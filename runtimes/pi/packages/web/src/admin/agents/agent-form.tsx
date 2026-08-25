/**
 * Agent Design 表单 Sections（WB-003 / SPEC §5.2；阶段一/二收口）。
 *
 * 此文件导出供 `agent-design-tab.tsx` 与 `agent-workspace.tsx` 复用的
 * section 组件。规范要求的设计 Tab 顺序：
 *
 *   1. 基本信息（只读 — 接口不支持编辑）
 *   2. 指令（System Prompt + 字符计数 + 空值/超长状态）
 *   3. 模型与思考（严格选择器 → Provider/能力摘要 → toggle → 默认强度）
 *   4. 输入输出能力（附件 / Avatar / 实验性实时语音）
 *   5. 扩展能力（工具 / 知识库 / Skill / MCP 的只读真实状态）
 *
 * 阶段一约束继续保留：能力只暴露 `attachments` / `avatar` /
 * `liveSpeech`；工具 / 知识库只允许移除不允许新增。
 */
import type {
	AgentCapabilities,
	AgentConfigSnapshot,
	AgentDefinitionDetail,
	AgentModelParameters,
	LlmAvailableModel,
} from "@earendil-works/pi-protocol";
import { useId } from "react";
import { productReasoningEfforts } from "./reasoning-efforts.ts";

/** 阶段一：仅暴露真正会持久化的能力开关。 */
export type EditableCapability = "attachments" | "avatar" | "liveSpeech";

export const EDITABLE_CAPABILITIES: readonly {
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

export const PROMPT_OVER_LONG_HINT = 8000;

export function updateCapability(
	draft: AgentConfigSnapshot,
	key: EditableCapability,
	value: boolean,
): AgentCapabilities {
	// 阶段一约束：只更新可编辑的 key；其它（citations / realtime /
	// webSearch）保持对象引用不变，避免保存时把旧值意外改写。
	return { ...draft.capabilities, [key]: value };
}

// ---------------------------------------------------------------------------
// 1. 基本信息（只读）
// ---------------------------------------------------------------------------

export function BasicInfoSection({ detail }: { readonly detail: AgentDefinitionDetail }): React.ReactElement {
	return (
		<section aria-label="基本信息" className="agent-section">
			<header className="agent-section__header">
				<h3>基本信息</h3>
				<p className="agent-section__hint">
					接口未暴露编辑入口；以下字段来自最新已保存 Revision，仅作展示。
				</p>
			</header>
			<dl className="agent-section__kv">
				<dt>名称</dt>
				<dd>{detail.name}</dd>
				<dt>描述</dt>
				<dd>{detail.description?.trim() ? detail.description : <span className="agent-section__muted">（无）</span>}</dd>
				<dt>当前 Revision</dt>
				<dd>
					<code>#{detail.currentRevision}</code>
				</dd>
				<dt>最近更新</dt>
				<dd>
					<time dateTime={detail.updatedAt}>{detail.updatedAt}</time>
					<span className="agent-section__muted"> · {detail.updatedBy}</span>
				</dd>
			</dl>
		</section>
	);
}

// ---------------------------------------------------------------------------
// 2. 指令
// ---------------------------------------------------------------------------

export function InstructionsSection({
	draft,
	onEdit,
}: {
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
}): React.ReactElement {
	const promptId = useId();
	const value = draft.systemPrompt;
	const length = value.length;
	const isEmpty = length === 0;
	const isOverLong = length > PROMPT_OVER_LONG_HINT;
	const charClass = isOverLong
		? "agent-section__charcount agent-section__charcount--over"
		: isEmpty
			? "agent-section__charcount"
			: "agent-section__charcount";
	return (
		<section aria-label="指令" className="agent-section">
			<header className="agent-section__header">
				<h3>指令</h3>
				<p className="agent-section__hint">
					用于驱动 Agent 行为的 System Prompt；保存时会冻结到 Revision 里。
				</p>
			</header>
			<label htmlFor={promptId} className="agent-section__label">
				System Prompt
			</label>
			<textarea
				id={promptId}
				rows={10}
				className="agent-section__textarea"
				value={value}
				spellCheck={false}
				aria-describedby={`${promptId}-status`}
				onChange={(e) => onEdit({ systemPrompt: e.currentTarget.value })}
			/>
			<div id={`${promptId}-status`} className="agent-section__status" aria-live="polite">
				<span className={charClass}>
					{length} 字{isOverLong ? `（超过 ${PROMPT_OVER_LONG_HINT} 字符上限）` : ""}
				</span>
				{isEmpty ? <span className="agent-section__warn">空值不会被服务端拒绝，但可能导致 Agent 表现退化为通用模型行为。</span> : null}
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// 3. 模型与思考
// ---------------------------------------------------------------------------

export type ModelCatalogState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly LlmAvailableModel[] }
	| { readonly kind: "error"; readonly message: string };

export function ModelSection({
	draft,
	onEdit,
	catalog,
}: {
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
	readonly catalog: ModelCatalogState;
}): React.ReactElement {
	const selectId = useId();
	const selectedModel =
		catalog.kind === "loaded" ? catalog.items.find((model) => model.id === draft.modelId) : undefined;
	const isCatalogMissingCurrent =
		catalog.kind === "loaded" && draft.modelId !== null && selectedModel === undefined;

	return (
		<section aria-label="模型与思考" className="agent-section">
			<header className="agent-section__header">
				<h3>模型与思考</h3>
				<p className="agent-section__hint">
					模型只能从服务端模型目录中选取；如当前模型已下架，会保留旧值并标记为不可用，但不会自动替换。
				</p>
			</header>

			<label htmlFor={selectId} className="agent-section__label">
				模型
			</label>

			{catalog.kind === "loading" ? (
				<p aria-busy="true" className="agent-section__state">
					正在加载模型目录…
				</p>
			) : catalog.kind === "error" ? (
				<p role="alert" className="agent-section__state agent-section__state--error">
					模型目录加载失败：{catalog.message}
					<br />
					无法在此状态下选择模型；请刷新或稍后重试。
				</p>
			) : (
				<ModelSelect
					id={selectId}
					items={catalog.items}
					value={draft.modelId}
					isCurrentMissing={isCatalogMissingCurrent}
					onChange={(value) => onEdit({ modelId: value })}
				/>
			)}

			{isCatalogMissingCurrent ? (
				<p className="agent-section__warn" data-state="model-deprecated">
					当前模型 <code>{draft.modelId}</code> 已不在模型目录中，已保留原值但暂时无法选择其他模型。
				</p>
			) : null}

			{selectedModel !== undefined ? (
				<ModelParameterEditor
					model={selectedModel}
					parameters={draft.parameters}
					onChange={(parameters) => onEdit({ parameters })}
				/>
			) : draft.modelId === null ? (
				<p className="agent-section__hint">请从模型目录选择可用模型后配置参数。参数能力由服务端模型目录决定。</p>
			) : null}
		</section>
	);
}

function ModelSelect({
	id,
	items,
	value,
	isCurrentMissing,
	onChange,
}: {
	readonly id: string;
	readonly items: readonly LlmAvailableModel[];
	readonly value: string | null;
	readonly isCurrentMissing: boolean;
	readonly onChange: (value: string | null) => void;
}): React.ReactElement {
	// 阶段二约束：严格 <select>，禁止自由文本输入任意 Model ID。
	return (
		<select
			id={id}
			className="agent-section__select"
			value={value ?? ""}
			disabled={isCurrentMissing}
			onChange={(e) => {
				const next = e.currentTarget.value;
				onChange(next === "" ? null : next);
			}}
		>
			<option value="" disabled>
				{items.length === 0 ? "（模型目录为空）" : "请选择模型"}
			</option>
			{items.map((model) => (
				<option key={`${model.provider}/${model.id}`} value={model.id}>
					{model.name} · {model.provider}
				</option>
			))}
			{isCurrentMissing ? (
				<option value={value ?? ""} disabled>
					{value}（已下架 — 保留原值）
				</option>
			) : null}
		</select>
	);
}

function ModelParameterEditor({
	model,
	parameters,
	onChange,
}: {
	readonly model: LlmAvailableModel;
	readonly parameters: AgentModelParameters;
	readonly onChange: (parameters: AgentModelParameters) => void;
}): React.ReactElement {
	const capabilities = model.parameterCapabilities;
	const reasoningEfforts = productReasoningEfforts(capabilities.reasoning.efforts);
	const setReasoning = (patch: Partial<NonNullable<AgentModelParameters["reasoning"]>>) =>
		onChange({ ...parameters, reasoning: { ...parameters.reasoning, ...patch } });
	return (
		<div className="agent-section__sub">
			<dl className="agent-section__kv">
				<dt>Provider</dt>
				<dd>
					<code>{model.provider}</code>
					<span className="agent-section__muted"> · API {model.api}</span>
				</dd>
				<dt>能力摘要</dt>
				<dd>
					{capabilities.reasoning.supported
						? `reasoning ${capabilities.reasoning.toggle ? "可开关" : "只读"} · 档位 ${reasoningEfforts.length}`
						: "不支持 reasoning"}
				</dd>
			</dl>

			{capabilities.reasoning.supported && capabilities.reasoning.toggle ? (
				<label className="agent-section__row">
					<input
						type="checkbox"
						checked={parameters.reasoning?.enabled ?? true}
						onChange={(event) => setReasoning({ enabled: event.currentTarget.checked })}
					/>
					开启深度思考
				</label>
			) : null}

			{reasoningEfforts.length > 0 ? (
				<>
					<label htmlFor="agent-reasoning-effort" className="agent-section__label">
						默认思考强度
					</label>
					<select
						id="agent-reasoning-effort"
						className="agent-section__select"
						value={parameters.reasoning?.effort ?? ""}
						onChange={(event) =>
							setReasoning({
								effort:
									event.currentTarget.value === ""
										? undefined
										: (event.currentTarget.value as never),
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
				</>
			) : null}

			<p className="agent-section__hint">采样、输出长度等生成参数由服务端代码固定，不在控制台开放修改。</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 4. 输入输出能力
// ---------------------------------------------------------------------------

export function IoCapabilitiesSection({
	draft,
	onEdit,
}: {
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
}): React.ReactElement {
	return (
		<section aria-label="输入输出能力" className="agent-section">
			<header className="agent-section__header">
				<h3>输入输出能力</h3>
				<p className="agent-section__hint">
					只有下列开关会写入 Revision；引用检索 / Realtime / Web 搜索的写入入口尚未对管理员开放，亦不会在保存时被改写。
				</p>
			</header>
			{EDITABLE_CAPABILITIES.map(({ key, label, description, experimental }) => (
				<label key={key} className="agent-section__row">
					<input
						type="checkbox"
						checked={draft.capabilities[key]}
						onChange={(e) => onEdit({ capabilities: updateCapability(draft, key, e.currentTarget.checked) })}
					/>
					<span>
						{label}
						{experimental ? <em data-experimental="true">（实验性）</em> : null}
					</span>
					{description === undefined ? null : (
						<span className="agent-section__hint agent-section__hint--inline">{description}</span>
					)}
				</label>
			))}
		</section>
	);
}

// ---------------------------------------------------------------------------
// 5. 扩展能力
// ---------------------------------------------------------------------------

export function ExtensionsSection({
	draft,
	onEdit,
}: {
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
}): React.ReactElement {
	return (
		<section aria-label="扩展能力" className="agent-section">
			<header className="agent-section__header">
				<h3>扩展能力</h3>
				<p className="agent-section__hint">
					工具 / 知识库仅显示已确认引用，不允许新增任意 ID。Skill / MCP 的产品化入口尚未开放。
				</p>
			</header>

			<ReadOnlyReferenceList
				legend="工具"
				hint="只读：移除后必须保存为新 Revision 才会持久化。"
				emptyText="尚未产品化 — 此 Agent 尚未引用任何工具。"
				items={draft.toolIds}
				onRemove={(id) => onEdit({ toolIds: draft.toolIds.filter((existing) => existing !== id) })}
				onClearAll={() => onEdit({ toolIds: [] })}
			/>

			<ReadOnlyReferenceList
				legend="知识库"
				hint="只读：移除后必须保存为新 Revision 才会持久化。"
				emptyText="尚未产品化 — 此 Agent 尚未引用任何知识库。"
				items={draft.knowledgeBaseIds}
				onRemove={(id) =>
					onEdit({ knowledgeBaseIds: draft.knowledgeBaseIds.filter((existing) => existing !== id) })
				}
				onClearAll={() => onEdit({ knowledgeBaseIds: [] })}
			/>

			<PlaceholderReferenceList legend="Skill" description="Skill 目录的产品化尚未开放；当前 Agent 未声明 Skill。" />
			<PlaceholderReferenceList legend="MCP" description="MCP 服务的产品化尚未开放；当前 Agent 未声明 MCP。" />
		</section>
	);
}

export function ReadOnlyReferenceList({
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
	return (
		<fieldset aria-describedby={`${fieldsetId}-hint`} className="agent-section__ref">
			<legend>{legend}</legend>
			<p id={`${fieldsetId}-hint`} className="agent-section__hint">
				{hint}
			</p>
			{items.length === 0 ? (
				<p className="agent-section__empty" data-empty-state="true">
					{emptyText}
				</p>
			) : (
				<div>
					<ul className="agent-section__ref-list">
						{items.map((id) => (
							<li key={id} className="agent-section__ref-item">
								<code className="agent-section__ref-id" title={id}>
									{id}
								</code>
								<button
									type="button"
									className="agent-section__ref-remove"
									aria-label={`移除 ${legend} ${id}`}
									onClick={() => onRemove(id)}
								>
									移除
								</button>
							</li>
						))}
					</ul>
					{items.length > 1 ? (
						<button type="button" className="agent-section__ref-clear" onClick={onClearAll}>
							全部移除（{items.length}）
						</button>
					) : null}
				</div>
			)}
		</fieldset>
	);
}

function PlaceholderReferenceList({
	legend,
	description,
}: {
	readonly legend: string;
	readonly description: string;
}): React.ReactElement {
	return (
		<fieldset className="agent-section__ref agent-section__ref--placeholder">
			<legend>{legend}</legend>
			<p className="agent-section__empty">{description}</p>
		</fieldset>
	);
}

// ---------------------------------------------------------------------------
// 旧 AgentForm 兼容出口（已被 agent-design-tab.tsx 取代；保留供旧测试）
// ---------------------------------------------------------------------------

export interface AgentFormProps {
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
	readonly models?: readonly LlmAvailableModel[];
}

/**
 * 旧版 `AgentForm` 仅用于兼容 `agent-form-parameters.test.tsx`。新流程请
 * 直接使用 `agent-design-tab.tsx` 中的 sections。
 */
export function AgentForm({ draft, onEdit, models = [] }: AgentFormProps): React.ReactElement {
	return (
		<form onSubmit={(e) => e.preventDefault()}>
			<InstructionsSection draft={draft} onEdit={onEdit} />
			<ModelSection
				draft={draft}
				onEdit={onEdit}
				catalog={
					models.length === 0
						? { kind: "loaded", items: [] }
						: { kind: "loaded", items: models }
				}
			/>
			<IoCapabilitiesSection draft={draft} onEdit={onEdit} />
			<ExtensionsSection draft={draft} onEdit={onEdit} />
		</form>
	);
}