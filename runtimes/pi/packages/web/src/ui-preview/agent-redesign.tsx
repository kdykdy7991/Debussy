import type { LlmAvailableModel, ReasoningEffort } from "@earendil-works/pi-protocol";
import { type ReactNode, useMemo, useState } from "react";
import "./agent-redesign.css";
import "./agent-action-menu.css";

type AgentStatus = "saved" | "draft";
type AgentTone = "blue" | "green" | "violet" | "amber" | "orange" | "teal" | "red" | "slate";

export interface AgentListItem {
	readonly id: string | number;
	readonly name: string;
	readonly description: string;
	readonly status: AgentStatus;
	readonly updatedAt: string;
	readonly version: number;
	readonly tone: AgentTone;
	readonly glyph: string;
	readonly timestampLabel?: string;
}

export interface AgentDetailData {
	readonly name: string;
	readonly description: string;
	readonly systemPrompt: string;
	readonly modelId: string | null;
	readonly reasoningEnabled: boolean;
	readonly reasoningEffort: ReasoningEffort | undefined;
	readonly attachments: boolean;
	readonly avatar: boolean;
	readonly liveSpeech: boolean;
	readonly newConversations: boolean;
}

export interface AgentEditableDraft {
	readonly name: string;
	readonly description: string;
	readonly modelId: string | null;
	readonly systemPrompt: string;
	readonly reasoningEnabled: boolean;
	readonly reasoningEffort: ReasoningEffort | undefined;
	readonly attachments: boolean;
	readonly avatar: boolean;
	readonly liveSpeech: boolean;
	readonly newConversations: boolean;
}

const PREVIEW_DETAIL: AgentDetailData = {
	name: "M1 Browser Acceptance Agent",
	description: "用于浏览器验收流程的自动化协助与质量检查。",
	systemPrompt:
		"你是一个专业的浏览器验收助手，能够根据验收标准，帮助用户检查页面功能、交互、兼容性与性能表现。\n请基于事实给出明确、简洁的结论，并在必要时提供可执行的建议。",
	modelId: "Qwen3-32B-Instruct",
	reasoningEnabled: true,
	reasoningEffort: "medium",
	attachments: true,
	avatar: false,
	liveSpeech: false,
	newConversations: true,
};

const AGENTS: readonly AgentListItem[] = [
	{
		id: 1,
		name: "M1 Browser Acceptance Agent",
		description: "用于浏览器验收流程的自动化协助与质量检查。",
		status: "saved",
		updatedAt: "2026/8/25 11:03",
		version: 3,
		tone: "blue",
		glyph: "◎",
	},
	{
		id: 2,
		name: "Customer Support Agent",
		description: "为客户提供准确、及时的售前和售后支持。",
		status: "saved",
		updatedAt: "2026/8/24 16:45",
		version: 2,
		tone: "green",
		glyph: "◉",
	},
	{
		id: 3,
		name: "Contract Review Agent",
		description: "合同条款识别、风险评估与合规性检查。",
		status: "draft",
		updatedAt: "2026/8/23 09:18",
		version: 1,
		tone: "violet",
		glyph: "▤",
	},
	{
		id: 4,
		name: "Data Analysis Agent",
		description: "数据分析与洞察生成，支持多维度数据解读。",
		status: "saved",
		updatedAt: "2026/8/22 14:32",
		version: 1,
		tone: "amber",
		glyph: "⌁",
	},
	{
		id: 5,
		name: "Code Review Agent",
		description: "代码质量检查、规范建议与潜在问题识别。",
		status: "saved",
		updatedAt: "2026/8/21 10:11",
		version: 1,
		tone: "orange",
		glyph: "</>",
	},
	{
		id: 6,
		name: "Content Writing Agent",
		description: "根据主题生成高质量文案与内容草稿。",
		status: "draft",
		updatedAt: "2026/8/20 18:07",
		version: 1,
		tone: "teal",
		glyph: "⌑",
	},
	{
		id: 7,
		name: "Security Audit Agent",
		description: "安全配置审计与风险检测建议。",
		status: "saved",
		updatedAt: "2026/8/19 15:55",
		version: 1,
		tone: "red",
		glyph: "◇",
	},
	{
		id: 8,
		name: "Translation Agent",
		description: "多语言翻译与本地化处理。",
		status: "draft",
		updatedAt: "2026/8/18 11:26",
		version: 1,
		tone: "blue",
		glyph: "文",
	},
	{
		id: 9,
		name: "Product FAQ Agent",
		description: "基于产品文档的常见问题解答。",
		status: "saved",
		updatedAt: "2026/8/17 09:41",
		version: 1,
		tone: "violet",
		glyph: "▣",
	},
	{
		id: 10,
		name: "HR Assistant Agent",
		description: "人事政策查询与流程指引。",
		status: "draft",
		updatedAt: "2026/8/16 13:20",
		version: 1,
		tone: "green",
		glyph: "♧",
	},
	{
		id: 11,
		name: "Report Generation Agent",
		description: "自动生成业务报告与数据摘要。",
		status: "saved",
		updatedAt: "2026/8/15 16:08",
		version: 1,
		tone: "blue",
		glyph: "◴",
	},
	{
		id: 12,
		name: "Custom Agent Template",
		description: "空白模板，可快速创建自定义 Agent。",
		status: "draft",
		updatedAt: "2026/8/15 09:00",
		version: 1,
		tone: "slate",
		glyph: "⌘",
	},
];

function Icon({ name }: { readonly name: string }): React.ReactElement {
	const paths: Readonly<Record<string, React.ReactNode>> = {
		chat: <path d="M4 5.5h16v11H9l-5 3v-14Z" />,
		agent: (
			<>
				<rect x="5" y="7" width="14" height="11" rx="2" />
				<path d="M9 7V4h6v3M9 12h.01M15 12h.01" />
			</>
		),
		publish: (
			<>
				<path d="M12 3v12M7 8l5-5 5 5" />
				<path d="M5 14v6h14v-6" />
			</>
		),
		usage: (
			<>
				<path d="M5 20V11M12 20V4M19 20v-7" />
			</>
		),
		session: (
			<>
				<rect x="5" y="3" width="14" height="18" rx="2" />
				<path d="M9 8h6M9 12h6M9 16h4" />
			</>
		),
		settings: (
			<>
				<circle cx="12" cy="12" r="3" />
				<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
			</>
		),
		search: (
			<>
				<circle cx="10.5" cy="10.5" r="6.5" />
				<path d="m16 16 4 4" />
			</>
		),
		grid: (
			<>
				<rect x="4" y="4" width="6" height="6" />
				<rect x="14" y="4" width="6" height="6" />
				<rect x="4" y="14" width="6" height="6" />
				<rect x="14" y="14" width="6" height="6" />
			</>
		),
		list: (
			<>
				<path d="M9 6h11M9 12h11M9 18h11" />
				<circle cx="5" cy="6" r=".6" fill="currentColor" />
				<circle cx="5" cy="12" r=".6" fill="currentColor" />
				<circle cx="5" cy="18" r=".6" fill="currentColor" />
			</>
		),
		back: <path d="m15 5-7 7 7 7" />,
		message: (
			<>
				<path d="M4 5h16v12H9l-5 3V5Z" />
				<path d="M8 9h8M8 13h5" />
			</>
		),
		check: (
			<>
				<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
				<path d="m8 12 2.5 2.5L16 9" stroke="white" />
			</>
		),
		plus: <path d="M12 5v14M5 12h14" />,
	};
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{paths[name]}
		</svg>
	);
}

function PreviewSidebar(): React.ReactElement {
	const items = [
		["chat", "Chat"],
		["agent", "Agent 设计"],
		["publish", "发布"],
		["usage", "Usage"],
		["session", "Session 日志"],
		["settings", "设置"],
	] as const;
	return (
		<aside className="ard-sidebar">
			<div className="ard-brand">
				<b>D</b>
				<span>
					<strong>Debussy</strong>
					<small>ADMIN CONSOLE</small>
				</span>
			</div>
			<nav>
				{items.map(([icon, label]) => (
					<button type="button" className={icon === "agent" ? "is-active" : ""} key={icon}>
						<Icon name={icon} />
						<span>{label}</span>
					</button>
				))}
			</nav>
			<div className="ard-user">
				<small>当前用户</small>
				<strong>Local Admin</strong>
				<span>
					<i />
					已连接
				</span>
			</div>
		</aside>
	);
}

export function AgentRedesignPreview(): React.ReactElement {
	const [page, setPage] = useState<"list" | "detail">(() =>
		new URLSearchParams(window.location.search).get("detail") === "1" ? "detail" : "list",
	);
	return (
		<div className="ard-root">
			<PreviewSidebar />
			{page === "list" ? (
				<AgentListPreview onCreate={() => setPage("detail")} onOpen={() => setPage("detail")} />
			) : (
				<AgentDetailPreview onBack={() => setPage("list")} />
			)}
		</div>
	);
}

export function AgentListPreview({
	onOpen,
	onCreate,
	createPending = false,
	onDelete,
	embedded = false,
	items = AGENTS,
	loadState = "ready",
	errorMessage,
	onRetry,
}: {
	readonly onOpen: (agent: AgentListItem) => void;
	readonly onCreate?: () => void;
	readonly createPending?: boolean;
	readonly onDelete?: (agent: AgentListItem) => void;
	readonly embedded?: boolean;
	readonly items?: readonly AgentListItem[];
	readonly loadState?: "loading" | "ready" | "error";
	readonly errorMessage?: string;
	readonly onRetry?: () => void;
}): React.ReactElement {
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<"all" | AgentStatus>("all");
	const [ascending, setAscending] = useState(false);
	const [view, setView] = useState<"grid" | "list">("grid");
	const visible = useMemo(
		() =>
			items
				.filter((agent) => {
					const matchesQuery = `${agent.name} ${agent.description}`.toLowerCase().includes(query.toLowerCase());
					return matchesQuery && (status === "all" || agent.status === status);
				})
				.sort((a, b) =>
					ascending ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt),
				),
		[ascending, items, query, status],
	);
	return (
		<main className={`ard-list-page${embedded ? " is-embedded" : ""}`}>
			<header className="ard-list-header">
				<div>
					<h1>Agent 列表</h1>
					<p>创建、管理和配置你的 AI Agent。</p>
				</div>
				<button
					className="ard-primary"
					type="button"
					onClick={onCreate}
					disabled={onCreate === undefined || createPending}
					title={onCreate === undefined ? "创建 Agent 能力尚未接入" : undefined}
				>
					<Icon name="plus" />
					<span>{createPending ? "创建中…" : "创建 Agent"}</span>
				</button>
			</header>
			<div className="ard-toolbar">
				<label className="ard-search">
					<span className="ard-sr-only">搜索 Agent</span>
					<Icon name="search" />
					<input
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
						placeholder="搜索 Agent 名称或描述"
					/>
				</label>
				<label className="ard-select">
					<span>状态</span>
					<select value={status} onChange={(event) => setStatus(event.currentTarget.value as "all" | AgentStatus)}>
						<option value="all">全部</option>
						<option value="saved">已保存</option>
						<option value="draft">草稿</option>
					</select>
				</label>
				<button className="ard-sort" type="button" onClick={() => setAscending((value) => !value)}>
					<span>排序</span>
					<b>更新时间</b>
					<i>{ascending ? "↟" : "↡"}</i>
				</button>
			</div>
			<div className="ard-list-meta">
				<span>共 {visible.length} 个 Agent</span>
				<div>
					<button
						type="button"
						className={view === "grid" ? "is-active" : ""}
						onClick={() => setView("grid")}
						aria-label="卡片视图"
					>
						<Icon name="grid" />
					</button>
					<button
						type="button"
						className={view === "list" ? "is-active" : ""}
						onClick={() => setView("list")}
						aria-label="列表视图"
					>
						<Icon name="list" />
					</button>
				</div>
			</div>
			{loadState === "loading" ? (
				<div className="ard-empty" aria-busy="true">
					<strong>正在加载 Agent…</strong>
				</div>
			) : loadState === "error" ? (
				<div className="ard-empty" role="alert">
					<strong>加载 Agent 失败</strong>
					<span>{errorMessage ?? "请稍后重试。"}</span>
					{onRetry ? (
						<button type="button" onClick={onRetry}>
							重试
						</button>
					) : null}
				</div>
			) : visible.length === 0 ? (
				<div className="ard-empty">
					<strong>{items.length === 0 ? "暂无 Agent" : "没有匹配的 Agent"}</strong>
					<span>{items.length === 0 ? "当前环境还没有可展示的真实 Agent。" : "请修改搜索词或状态筛选。"}</span>
				</div>
			) : (
				<section className={`ard-agent-grid ${view === "list" ? "is-list" : ""}`}>
					{visible.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							onOpen={() => onOpen(agent)}
							onDelete={onDelete ? () => onDelete(agent) : undefined}
						/>
					))}
				</section>
			)}
			{loadState === "ready" && visible.length > 0 ? (
				<footer className="ard-pagination">
					<button type="button" disabled>
						‹
					</button>
					<button type="button" className="is-current">
						1
					</button>
					<button type="button">2</button>
					<button type="button">›</button>
					<span>每页</span>
					<select defaultValue="12">
						<option>12</option>
						<option>24</option>
					</select>
					<span>条</span>
				</footer>
			) : null}
		</main>
	);
}

function AgentCard({
	agent,
	onOpen,
	onDelete,
}: {
	readonly agent: AgentListItem;
	readonly onOpen: () => void;
	readonly onDelete?: () => void;
}): React.ReactElement {
	const [menuOpen, setMenuOpen] = useState(false);
	return (
		<article className="ard-agent-card">
			<button className="ard-card-open" type="button" aria-label={`打开 ${agent.name}`} onClick={onOpen} />
			<button
				className="ard-card-menu"
				type="button"
				aria-label="更多操作"
				aria-expanded={menuOpen}
				aria-haspopup="menu"
				onClick={() => setMenuOpen((open) => !open)}
			>
				•••
			</button>
			{menuOpen ? (
				<div className="ard-card-dropdown" role="menu">
					<button
						type="button"
						role="menuitem"
						disabled={onDelete === undefined}
						onClick={() => {
							setMenuOpen(false);
							onDelete?.();
						}}
					>
						删除 Agent
					</button>
				</div>
			) : null}
			<div className={`ard-agent-icon tone-${agent.tone}`}>{agent.glyph}</div>
			<div className="ard-agent-copy">
				<h2>{agent.name}</h2>
				<p>{agent.description}</p>
			</div>
			<div className={`ard-status is-${agent.status}`}>
				<i />
				{agent.status === "saved" ? "已保存" : "草稿"}
			</div>
			<div className="ard-card-foot">
				<span>
					{agent.timestampLabel ?? "更新时间"}：　{agent.updatedAt}
				</span>
				<b>v{agent.version}</b>
			</div>
		</article>
	);
}

export function AgentDetailPreview({
	onBack,
	onTest,
	embedded = false,
	data = PREVIEW_DETAIL,
	saveEnabled = true,
	identityEditable = true,
	modelEditable = true,
	models,
	modelsLoading = false,
	modelsError,
	onSave,
	extensionPanel,
	externallyDirty = false,
	onDiscardExternal,
}: {
	readonly onBack: () => void;
	readonly onTest?: () => void;
	readonly embedded?: boolean;
	readonly data?: AgentDetailData;
	readonly saveEnabled?: boolean;
	readonly identityEditable?: boolean;
	readonly modelEditable?: boolean;
	readonly models?: readonly LlmAvailableModel[];
	readonly modelsLoading?: boolean;
	readonly modelsError?: string;
	readonly onSave?: (draft: AgentEditableDraft) => Promise<void>;
	readonly extensionPanel?: ReactNode;
	readonly externallyDirty?: boolean;
	readonly onDiscardExternal?: () => void;
}): React.ReactElement {
	const [name, setName] = useState(data.name);
	const [description, setDescription] = useState(data.description);
	const [prompt, setPrompt] = useState(data.systemPrompt);
	const [model, setModel] = useState(data.modelId ?? "");
	const [reasoning, setReasoning] = useState(data.reasoningEnabled);
	const [effort, setEffort] = useState<ReasoningEffort | undefined>(data.reasoningEffort);
	const [attachments, setAttachments] = useState(data.attachments);
	const [avatar, setAvatar] = useState(data.avatar);
	const [speech, setSpeech] = useState(data.liveSpeech);
	const [newConversations, setNewConversations] = useState(data.newConversations);
	const [savedSnapshot, setSavedSnapshot] = useState(() =>
		JSON.stringify({
			name: data.name,
			description: data.description,
			prompt: data.systemPrompt,
			model: data.modelId ?? "",
			reasoning: data.reasoningEnabled,
			effort: data.reasoningEffort,
			attachments: data.attachments,
			avatar: data.avatar,
			speech: data.liveSpeech,
			newConversations: data.newConversations,
		}),
	);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
	const [saveError, setSaveError] = useState<string | null>(null);
	const snapshot = JSON.stringify({
		name,
		description,
		prompt,
		model,
		reasoning,
		effort,
		attachments,
		avatar,
		speech,
		newConversations,
	});
	const formDirty = savedSnapshot !== "" && snapshot !== savedSnapshot;
	const dirty = formDirty || externallyDirty;
	const selectedModel = models?.find((item) => item.id === model);
	const reasoningCapability = selectedModel?.parameterCapabilities.reasoning;
	const effortOptions = reasoningCapability?.efforts ?? (effort === undefined ? [] : [effort]);
	const save = async (): Promise<void> => {
		if (!dirty || !saveEnabled || saveState === "saving") return;
		setSaveState("saving");
		setSaveError(null);
		try {
			if (onSave !== undefined) {
				await onSave({
					name,
					description,
					modelId: model === "" ? null : model,
					systemPrompt: prompt,
					reasoningEnabled: reasoning,
					reasoningEffort: effort,
					attachments,
					avatar,
					liveSpeech: speech,
					newConversations,
				});
			}
			setSavedSnapshot(snapshot);
			setSaveState("idle");
		} catch (error) {
			setSaveState("error");
			setSaveError(error instanceof Error ? error.message : String(error));
		}
	};
	const reset = () => {
		setName(data.name);
		setDescription(data.description);
		setPrompt(data.systemPrompt);
		setModel(data.modelId ?? "");
		setReasoning(data.reasoningEnabled);
		setEffort(data.reasoningEffort);
		setAttachments(data.attachments);
		setAvatar(data.avatar);
		setSpeech(data.liveSpeech);
		setNewConversations(data.newConversations);
		onDiscardExternal?.();
	};
	return (
		<main className={`ard-detail-page${embedded ? " is-embedded" : ""}`}>
			<header className="ard-detail-head">
				<button className="ard-back" type="button" onClick={onBack}>
					<Icon name="back" />
					返回 Agent 列表
				</button>
				<div className="ard-title-row">
					<h1>{name}</h1>
					<span className={dirty ? "is-dirty" : ""}>
						<Icon name="check" />
						{dirty ? "未保存" : "已保存"}
					</span>
				</div>
				<div className="ard-head-actions">
					<button
						type="button"
						className="ard-secondary"
						onClick={onTest}
						disabled={onTest === undefined}
						title={onTest === undefined ? "Chat 调试入口尚未接入" : undefined}
					>
						<Icon name="message" />去 Chat 测试
					</button>
				</div>
			</header>
			<form
				className="ard-form"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<section>
					<h2>基本信息</h2>
					<label>
						名称
						<div className="ard-input">
							<input
								value={name}
								maxLength={100}
								readOnly={!identityEditable}
								onChange={(event) => setName(event.currentTarget.value)}
							/>
							<span>{name.length} / 100</span>
						</div>
					</label>
					<label>
						描述
						<div className="ard-input">
							<textarea
								value={description}
								maxLength={300}
								readOnly={!identityEditable}
								onChange={(event) => setDescription(event.currentTarget.value)}
							/>
							<span>{description.length} / 300</span>
						</div>
					</label>
				</section>
				<section>
					<h2>Agent 指令</h2>
					<label>
						System Prompt
						<div className="ard-input">
							<textarea
								className="ard-prompt"
								value={prompt}
								maxLength={8000}
								onChange={(event) => setPrompt(event.currentTarget.value)}
							/>
							<span>{prompt.length} / 8000</span>
						</div>
					</label>
				</section>
				<section>
					<h2>模型设置</h2>
					<div className="ard-model-row">
						<label>
							<b>模型</b>
							<select
								value={model}
								onChange={(event) => {
									const next = event.currentTarget.value;
									setModel(next);
									const capability = models?.find((item) => item.id === next)?.parameterCapabilities.reasoning;
									setReasoning(capability?.supported ?? false);
									setEffort(capability?.defaultEffort ?? capability?.efforts[0]);
								}}
								disabled={!modelEditable || modelsLoading || modelsError !== undefined}
							>
								<option value="">未选择模型</option>
								{models?.map((item) => (
									<option key={`${item.provider}/${item.id}`} value={item.id}>
										{item.name} · {item.provider}
									</option>
								))}
								{model !== "" && models?.every((item) => item.id !== model) ? (
									<option value={model}>{model}（当前值，目录中不可用）</option>
								) : null}
							</select>
							{modelsLoading ? <small className="ard-field-note">正在加载模型目录…</small> : null}
							{modelsError ? <small className="ard-field-error">模型目录加载失败：{modelsError}</small> : null}
						</label>
						<div className="ard-setting">
							<span>
								<b>深度思考</b>
								<small>ⓘ</small>
							</span>
							<Switch
								checked={reasoning}
								onChange={setReasoning}
								disabled={
									!modelEditable ||
									reasoningCapability === undefined ||
									!reasoningCapability.supported ||
									!reasoningCapability.toggle
								}
							/>
							<p>开启后模型会进行更深入的思考</p>
						</div>
						<div className="ard-effort">
							<span>
								<b>思考强度</b>
								<small>ⓘ</small>
							</span>
							<div>
								{effortOptions.map((item) => (
									<button
										key={item}
										type="button"
										className={effort === item ? "is-active" : ""}
										onClick={() => setEffort(item)}
									>
										{item}
									</button>
								))}
							</div>
						</div>
					</div>
				</section>
				<section>
					<h2>对话能力</h2>
					<div className="ard-capabilities">
						<Capability
							title="允许新建对话"
							description="发布后显示会话侧边栏，用户可创建并切换多个对话"
							value={newConversations}
							onChange={setNewConversations}
						/>
						<Capability
							title="附件"
							description="允许用户上传文件作为对话输入"
							value={attachments}
							onChange={setAttachments}
						/>
						<Capability
							title="Avatar"
							description="在对话中展示数字人 Avatar"
							value={avatar}
							onChange={setAvatar}
						/>
						<Capability
							title="实验性实时语音"
							description="启用实时语音输入与输出（实验性）"
							value={speech}
							onChange={setSpeech}
						/>
					</div>
				</section>
				{extensionPanel}
				<footer className="ard-savebar">
					<span className={dirty || saveState === "error" ? "is-dirty" : ""}>
						<Icon name="check" />
						<b>
							{saveState === "saving"
								? "保存中"
								: saveState === "error"
									? "保存失败"
									: dirty
										? "有未保存修改"
										: "已保存"}
						</b>
						<small>{saveError ?? (dirty ? "修改尚未保存" : "所有修改已保存")}</small>
					</span>
					<div>
						<button type="button" onClick={reset} disabled={!dirty || saveState === "saving"}>
							放弃修改
						</button>
						<button
							type="submit"
							className="ard-primary"
							disabled={!dirty || !saveEnabled || saveState === "saving"}
						>
							{saveState === "saving" ? "保存中…" : saveEnabled ? "保存" : "保存暂未接入"}
						</button>
					</div>
				</footer>
			</form>
		</main>
	);
}

function Switch({
	checked,
	onChange,
	disabled = false,
}: {
	readonly checked: boolean;
	readonly onChange: (checked: boolean) => void;
	readonly disabled?: boolean;
}): React.ReactElement {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			className={`ard-switch ${checked ? "is-on" : ""}`}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<i />
		</button>
	);
}

function Capability({
	title,
	description,
	value,
	onChange,
}: {
	readonly title: string;
	readonly description: string;
	readonly value: boolean;
	readonly onChange: (value: boolean) => void;
}): React.ReactElement {
	return (
		<div className="ard-capability">
			<span>
				<b>{title}</b>
				<small>{description}</small>
			</span>
			<Switch checked={value} onChange={onChange} />
		</div>
	);
}
