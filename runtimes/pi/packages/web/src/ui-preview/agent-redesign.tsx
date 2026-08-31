import type { LlmAvailableModel, ReasoningEffort } from "@earendil-works/pi-protocol";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
	/** 绑定编辑（Skill / MCP）；不传时由调用方沿用服务端当前绑定。 */
	readonly skills?: readonly { readonly skillId: string; readonly revision: number }[];
	readonly mcpServers?: readonly {
		readonly mcpServerId: string;
		readonly revision: number;
		readonly toolNames: readonly string[];
	}[];
}

/* ============================================================================
 * v2: Publish / Version / Resource types
 * ============================================================================ */

export type PublishStatus = "online" | "paused" | "draft";

export interface VersionHistoryItem {
	readonly version: string;
	readonly createdAt: string;
	readonly author: string;
	readonly isCurrent: boolean;
}

export interface AgentResource {
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	/** Skill / MCP 目录接口不返回描述，缺失时 UI 省略该行。 */
	readonly description?: string;
	readonly enabled: boolean;
	readonly connectionStatus?: "connected" | "failed" | "untested";
	readonly toolCount?: number;
	/** 绑定的 revision 落后于该资源的当前 revision。 */
	readonly outdated?: boolean;
	/** 绑定所用的资源 revision —— 保存（saveRevision）时需要还原成引用。 */
	readonly revision?: number;
	/** MCP 绑定冻结的工具名列表 —— 保存时随引用一起提交。 */
	readonly toolNames?: readonly string[];
}

/** 可绑定的目录条目（Skill / MCP 通用形状）。 */
export interface AgentCatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly currentRevision: number;
	readonly enabled?: boolean;
	readonly connectionStatus?: "connected" | "failed" | "untested";
	readonly toolCount?: number;
	/** MCP server 当前 revision 冻结的工具名 —— 新增绑定时作为默认 allowlist。 */
	readonly toolNames?: readonly string[];
}

export interface AgentPublishData {
	readonly status: PublishStatus;
	readonly draftRevision: string;
	readonly draftSavedAt: string;
	readonly currentVersion: string;
	readonly lastPublishedAt: string;
	readonly versionHistory: readonly VersionHistoryItem[];
	/** P2: public embed/chat link shown on the status card. */
	readonly externalLink?: string;
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

const PREVIEW_PUBLISH: AgentPublishData = {
	status: "online",
	draftRevision: "Revision 3",
	draftSavedAt: "2026-08-28 12:30",
	currentVersion: "Revision 3",
	lastPublishedAt: "2026-08-28 12:30",
	externalLink: "https://chat.example.com/embed/pub_1234",
	versionHistory: [
		{ version: "v3", createdAt: "10 分钟前", author: "Local Admin", isCurrent: true },
		{ version: "v2", createdAt: "2 天前", author: "Local Admin", isCurrent: false },
		{ version: "v1", createdAt: "8 月 20 日", author: "Local Admin", isCurrent: false },
	],
};

const PREVIEW_SKILLS: readonly AgentResource[] = [
	{ id: "skill_1", name: "产品知识检索", version: "v2.1.0", description: "检索产品文档和常见问题", enabled: true },
	{ id: "skill_2", name: "工单处理", version: "v1.3.0", description: "创建和查询工单", enabled: true },
	{ id: "skill_3", name: "用户信息查询", version: "v1.0.1", description: "查询用户基本信息", enabled: true },
];

const PREVIEW_MCP: readonly AgentResource[] = [
	{
		id: "mcp_1",
		name: "CRM MCP Server",
		description: "客户关系管理系统接口",
		enabled: true,
		connectionStatus: "connected",
		toolCount: 8,
	},
	{
		id: "mcp_2",
		name: "Knowledge MCP Server",
		description: "知识库检索与问答接口",
		enabled: true,
		connectionStatus: "connected",
		toolCount: 5,
	},
];

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
				<path d="M3 3v18h18" />
				<path d="M7 14l4-4 4 4 5-5" />
			</>
		),
		sessions: (
			<>
				<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
				<path d="M14 3v6h6M9 13h6M9 17h6" />
			</>
		),
		settings: (
			<>
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
			</>
		),
		skills: (
			<>
				<rect x="3" y="3" width="7" height="7" rx="1" />
				<rect x="14" y="3" width="7" height="7" rx="1" />
				<rect x="3" y="14" width="7" height="7" rx="1" />
				<rect x="14" y="14" width="7" height="7" rx="1" />
			</>
		),
		mcp: (
			<>
				<path d="M12 2 2 7l10 5 10-5-10-5z" />
				<path d="m2 17 10 5 10-5" />
				<path d="m2 12 10 5 10-5" />
			</>
		),
		back: (
			<>
				<line x1="19" y1="12" x2="5" y2="12" />
				<polyline points="12 19 5 12 12 5" />
			</>
		),
		edit: (
			<>
				<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
				<path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z" />
			</>
		),
		more: (
			<>
				<circle cx="5" cy="12" r="1.5" />
				<circle cx="12" cy="12" r="1.5" />
				<circle cx="19" cy="12" r="1.5" />
			</>
		),
		check: <polyline points="20 6 9 17 4 12" />,
		message: (
			<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
		),
		send: (
			<>
				<line x1="22" y1="2" x2="11" y2="13" />
				<polygon points="22 2 15 22 11 13 2 9 22 2" />
			</>
		),
		plus: (
			<>
				<line x1="12" y1="5" x2="12" y2="19" />
				<line x1="5" y1="12" x2="19" y2="12" />
			</>
		),
		chevron: <polyline points="9 18 15 12 9 6" />,
		chevronDown: <polyline points="6 9 12 15 18 9" />,
		search: (
			<>
				<circle cx="11" cy="11" r="8" />
				<line x1="21" y1="21" x2="16.65" y2="16.65" />
			</>
		),
		pause: (
			<>
				<rect x="6" y="4" width="4" height="16" />
				<rect x="14" y="4" width="4" height="16" />
			</>
		),
		pauseLine: (
			<>
				<line x1="9" y1="2" x2="9" y2="22" />
				<line x1="15" y1="2" x2="15" y2="22" />
			</>
		),
		template: (
			<>
				<rect x="3" y="3" width="18" height="18" rx="2" />
				<path d="M3 9h18" />
				<path d="M9 21V9" />
			</>
		),
		variable: (
			<>
				<path d="M12 2v6" />
				<path d="m4.93 10.93 4.24 4.24" />
				<path d="M2 18h6" />
				<path d="M19.07 10.93l-4.24 4.24" />
				<path d="M22 18h-6" />
				<circle cx="12" cy="14" r="4" />
			</>
		),
		format: (
			<>
				<line x1="3" y1="6" x2="21" y2="6" />
				<line x1="3" y1="12" x2="21" y2="12" />
				<line x1="3" y1="18" x2="21" y2="18" />
			</>
		),
		attachment: (
			<>
				<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
			</>
		),
		avatar: (
			<>
				<circle cx="12" cy="8" r="4" />
				<path d="M5 21v-1a7 7 0 0 1 14 0v1" />
			</>
		),
		mic: (
			<>
				<rect x="9" y="2" width="6" height="11" rx="3" />
				<path d="M19 10v1a7 7 0 0 1-14 0v-1" />
				<line x1="12" y1="18" x2="12" y2="22" />
			</>
		),
		chatBox: (
			<>
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			</>
		),
		upload: (
			<>
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
				<polyline points="17 8 12 3 7 8" />
				<line x1="12" y1="3" x2="12" y2="15" />
			</>
		),
		lightning: <path d="M13 2 3 14h7l-1 8 10-12h-7z" />,
		spark: (
			<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
		),
		globe: (
			<>
				<circle cx="12" cy="12" r="9" />
				<path d="M3 12h18" />
				<path d="M12 3a13 13 0 0 1 0 18" />
				<path d="M12 3a13 13 0 0 0 0 18" />
			</>
		),
		users: (
			<>
				<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
				<circle cx="9" cy="7" r="4" />
				<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
				<path d="M16 3.13a4 4 0 0 1 0 7.75" />
			</>
		),
		diamond: (
			<>
				<path d="M6 3h12l4 6-10 13L2 9z" />
				<path d="M11 3 8 9l4 13" />
				<path d="m13 3 3 6-4 13" />
			</>
		),
		external: (
			<>
				<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
				<polyline points="15 3 21 3 21 9" />
				<line x1="10" y1="14" x2="21" y2="3" />
			</>
		),
		clock: (
			<>
				<path d="M12 8v4l3 2" />
				<circle cx="12" cy="12" r="9" />
			</>
		),
		history: (
			<>
				<polyline points="21 8 21 21 3 21 3 8" />
				<rect x="1" y="3" width="22" height="5" />
				<line x1="10" y1="12" x2="14" y2="12" />
			</>
		),
		cube: (
			<>
				<path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4" />
				<path d="M12 2v15" />
				<path d="m7 7 5-5 5 5" />
			</>
		),
		doc: (
			<>
				<path d="M3 7h18M3 12h18M3 17h12" />
			</>
		),
		book: (
			<>
				<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
				<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
			</>
		),
		eye: (
			<>
				<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
				<circle cx="12" cy="12" r="2.5" />
			</>
		),
		model: (
			<>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 3v18M3 12h18M5.6 6.2h12.8M5.6 17.8h12.8" />
			</>
		),
		bulb: (
			<>
				<path d="M9 18h6M10 22h4" />
				<path d="M8.2 15.2A7 7 0 1 1 15.8 15.2C14.7 16 14.2 17 14 18h-4c-.2-1-.7-2-1.8-2.8Z" />
			</>
		),
		copy: (
			<>
				<rect x="8" y="8" width="12" height="12" rx="2" />
				<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
			</>
		),
	};
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{paths[name] ?? null}
		</svg>
	);
}

export type PreviewNavId = "agents" | "skills" | "mcp" | "usage" | "sessions" | "settings";

const PREVIEW_NAV_ITEMS: readonly {
	readonly id: PreviewNavId;
	readonly label: string;
	readonly icon: string;
}[] = [
	{ id: "agents", label: "Agents", icon: "agent" },
	{ id: "skills", label: "Skills", icon: "skills" },
	{ id: "mcp", label: "MCP", icon: "mcp" },
	{ id: "usage", label: "用量", icon: "usage" },
	{ id: "sessions", label: "Session 日志", icon: "sessions" },
	{ id: "settings", label: "设置", icon: "settings" },
];

export function AgentListPreview({
	onCreate,
	onOpen,
	onDelete,
	items = AGENTS,
	loadState = "ready",
	errorMessage,
	onRetry,
	createPending = false,
	embedded = false,
	initialView = "list",
	initialItemId = null,
}: {
	readonly onCreate?: () => void;
	readonly onOpen?: (item: AgentListItem) => void;
	readonly onDelete?: (item: AgentListItem) => void;
	readonly items?: readonly AgentListItem[];
	readonly loadState?: "loading" | "ready" | "error";
	readonly errorMessage?: string;
	readonly onRetry?: () => void;
	readonly createPending?: boolean;
	readonly embedded?: boolean;
	readonly initialView?: "list" | "detail";
	readonly initialItemId?: string | number | null;
}): React.ReactElement {
	const [page, setPage] = useState<"list" | "detail">(initialView);
	const [activeId, setActiveId] = useState<string | number | null>(initialItemId);
	// 侧栏高亮由独立的导航态驱动，不能复用 list/detail 视图态：
	// 否则点击 Agents 只会进入列表态，高亮却永远落在 Chat 上。
	const [nav, setNav] = useState<PreviewNavId>("agents");
	const active = activeId === null ? null : (items.find((it) => it.id === activeId) ?? null);
	const activeNav = PREVIEW_NAV_ITEMS.find((item) => item.id === nav) ?? PREVIEW_NAV_ITEMS[0];
	const selectNav = (id: PreviewNavId): void => {
		setNav(id);
		setPage("list");
		setActiveId(null);
	};
	return (
		<div className={`ard-root${embedded ? " is-embedded" : ""}`}>
			{embedded ? null : (
				<aside className="ard-sidebar" aria-label="侧栏">
					<div className="ard-brand">
						<b>D</b>
						<span>
							<strong>Debussy</strong>
							<small>ADMIN CONSOLE</small>
						</span>
					</div>
					<nav>
						{PREVIEW_NAV_ITEMS.map((item) => (
							<button
								key={item.id}
								type="button"
								className={nav === item.id ? "is-active" : ""}
								aria-current={nav === item.id ? "page" : undefined}
								onClick={() => selectNav(item.id)}
							>
								<Icon name={item.icon} />
								<span>{item.label}</span>
							</button>
						))}
					</nav>
					<div className="ard-user">
						<small>Local Admin</small>
						<strong>管理员</strong>
						<span>
							<i aria-hidden="true" /> 已连接
						</span>
					</div>
				</aside>
			)}
			{nav === "agents" ? (
				page === "list" || active === null ? (
					<AgentListView
						items={items}
						loadState={loadState}
						errorMessage={errorMessage}
						onRetry={onRetry}
						onCreate={onCreate}
						onOpen={(item) => {
							setActiveId(item.id);
							setPage("detail");
							onOpen?.(item);
						}}
						onDelete={onDelete}
						createPending={createPending}
						embedded={embedded}
					/>
				) : (
					<AgentDetailPreview
						onBack={() => {
							setPage("list");
							setActiveId(null);
						}}
						embedded={embedded}
					/>
				)
			) : (
				<PreviewModulePlaceholder label={activeNav.label} embedded={embedded} />
			)}
		</div>
	);
}

function PreviewModulePlaceholder({
	label,
	embedded,
}: {
	readonly label: string;
	readonly embedded: boolean;
}): React.ReactElement {
	return (
		<section className={`ard-list-page${embedded ? " is-embedded" : ""}`} aria-label={`${label} 预览`}>
			<header className="ard-list-header">
				<h1>{label}</h1>
			</header>
			<div className="ard-state">
				<strong>{label} 模块尚未实现</strong>
				<span>本 UI 预览只实现了 Agent 模块，点击侧边栏的 Agents 查看。</span>
			</div>
		</section>
	);
}

function AgentListView({
	items,
	loadState,
	errorMessage,
	onRetry,
	onCreate,
	onOpen,
	onDelete,
	createPending,
	embedded,
}: {
	readonly items: readonly AgentListItem[];
	readonly loadState: "loading" | "ready" | "error";
	readonly errorMessage?: string;
	readonly onRetry?: () => void;
	readonly onCreate?: () => void;
	readonly onOpen: (item: AgentListItem) => void;
	readonly onDelete?: (item: AgentListItem) => void;
	readonly createPending?: boolean;
	readonly embedded?: boolean;
}): React.ReactElement {
	const [keyword, setKeyword] = useState("");
	const [status, setStatus] = useState<"all" | "saved" | "draft">("all");
	const filtered = useMemo(() => {
		const k = keyword.trim().toLowerCase();
		return items.filter((item) => {
			if (status !== "all" && item.status !== status) return false;
			if (k === "") return true;
			return item.name.toLowerCase().includes(k) || item.description.toLowerCase().includes(k);
		});
	}, [items, keyword, status]);
	const filterActive = keyword.trim() !== "" || status !== "all";
	const total = items.length;
	return (
		<section className={`ard-list-page${embedded ? " is-embedded" : ""}`} aria-label="Agents">
			<header className="ard-list-header">
				<h1>Agents</h1>
			</header>
			<div className="ard-toolbar">
				<div className="ard-search">
					<Icon name="search" />
					<input
						type="search"
						aria-label="搜索 Agent"
						placeholder="搜索 Agent 名称或描述"
						value={keyword}
						onChange={(event) => setKeyword(event.currentTarget.value)}
					/>
				</div>
				<div className="ard-select">
					<select
						aria-label="按状态筛选"
						value={status}
						onChange={(event) => setStatus(event.currentTarget.value as "all" | "saved" | "draft")}
					>
						<option value="all">全部状态</option>
						<option value="saved">已保存</option>
						<option value="draft">草稿</option>
					</select>
					<i aria-hidden="true">▾</i>
				</div>
				{onCreate !== undefined ? (
					<button type="button" className="ard-primary" onClick={onCreate} disabled={createPending}>
						<Icon name="plus" />
						<span>{createPending ? "创建中…" : "新建 Agent"}</span>
					</button>
				) : null}
			</div>
			<div className="ard-list-meta">
				<small>{loadState === "ready" ? `共 ${filtered.length} 个 Agent` : "加载中…"}</small>
				{filterActive ? (
					<button
						type="button"
						className="ard-reset"
						onClick={() => {
							setKeyword("");
							setStatus("all");
						}}
					>
						清除筛选
					</button>
				) : null}
			</div>
			{loadState === "loading" ? (
				<div className="ard-state" aria-busy="true">
					<span className="ard-spinner" aria-hidden="true" />
					<strong>正在加载 Agent…</strong>
				</div>
			) : loadState === "error" ? (
				<div className="ard-state is-error" role="alert">
					<strong>加载失败</strong>
					<span>{errorMessage ?? "未知错误"}</span>
					{onRetry !== undefined ? (
						<button type="button" className="ard-ghost" onClick={onRetry}>
							重试
						</button>
					) : null}
				</div>
			) : filtered.length === 0 ? (
				<div className="ard-state">
					<strong>{total === 0 ? "还没有 Agent" : "没有匹配的 Agent"}</strong>
					<span>
						{total === 0
							? "创建第一个 Agent，配置它的能力与发布方式。"
							: "试试更换关键词，或把状态筛选切回「全部状态」。"}
					</span>
				</div>
			) : (
				<div className="ard-agent-grid">
					{filtered.map((item) => (
						<article
							key={item.id}
							className="ard-agent-card"
							onClick={() => onOpen(item)}
							role="button"
							tabIndex={0}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onOpen(item);
								}
							}}
						>
							<span className={`ard-agent-icon tone-${item.tone}`} aria-hidden="true">
								{item.glyph}
							</span>
							<div className="ard-agent-body">
								<div className="ard-agent-title">
									<h2>{item.name}</h2>
									{onDelete !== undefined ? (
										<button
											type="button"
											className="ard-card-menu"
											aria-label={`删除 ${item.name}`}
											onClick={(event) => {
												event.stopPropagation();
												onDelete(item);
											}}
										>
											<svg
												width="15"
												height="15"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="1.7"
												strokeLinecap="round"
											>
												<path d="M4 7h16M10 11v6M14 11v6" />
												<path d="M6 7l1 13h10l1-13" />
												<path d="M9 7V4h6v3" />
											</svg>
										</button>
									) : null}
								</div>
								<p className="ard-agent-desc">{item.description}</p>
								<div className="ard-card-foot">
									<span className={`ard-badge${item.status === "draft" ? " is-draft" : ""}`}>
										<i aria-hidden="true" />
										{item.status === "draft" ? "草稿" : "已保存"} · v{item.version}
									</span>
									<span className="ard-card-time">
										{item.timestampLabel ?? "更新于"} · {item.updatedAt}
									</span>
								</div>
							</div>
						</article>
					))}
				</div>
			)}
		</section>
	);
}

export function AgentDetailPreview({
	onBack,
	onTest,
	onPublish,
	embedded = false,
	data = PREVIEW_DETAIL,
	publishData = PREVIEW_PUBLISH,
	skills = PREVIEW_SKILLS,
	mcpServers = PREVIEW_MCP,
	createdAt,
	createdBy,
	agentId,
	saveEnabled = true,
	identityEditable = true,
	modelEditable = true,
	models,
	modelsLoading = false,
	modelsError,
	onSave,
	onDirtyChange,
	extensionPanel,
	externallyDirty = false,
	onDiscardExternal,
	resourcesLoading = false,
	skillCatalog,
	mcpCatalog,
	hasDraft = false,
}: {
	readonly onBack: () => void;
	readonly onTest?: () => void;
	readonly onPublish?: () => void;
	readonly embedded?: boolean;
	readonly data?: AgentDetailData;
	readonly publishData?: AgentPublishData;
	readonly skills?: readonly AgentResource[];
	readonly mcpServers?: readonly AgentResource[];
	readonly createdAt?: string;
	readonly createdBy?: string;
	readonly agentId?: string;
	readonly saveEnabled?: boolean;
	readonly identityEditable?: boolean;
	readonly modelEditable?: boolean;
	readonly models?: readonly LlmAvailableModel[];
	readonly modelsLoading?: boolean;
	readonly modelsError?: string;
	readonly onSave?: (draft: AgentEditableDraft) => Promise<void>;
	readonly onDirtyChange?: (dirty: boolean) => void;
	readonly extensionPanel?: ReactNode;
	readonly externallyDirty?: boolean;
	readonly onDiscardExternal?: () => void;
	/** Skill / MCP 绑定与目录仍在拉取：此时不要渲染「尚未关联」这种误导文案。 */
	readonly resourcesLoading?: boolean;
	/** 可绑定的 Skill / MCP 目录（用于「添加」选择器）。 */
	readonly skillCatalog?: readonly AgentCatalogEntry[];
	readonly mcpCatalog?: readonly AgentCatalogEntry[];
	/** 服务端存在未发布草稿时在标题旁提示。 */
	readonly hasDraft?: boolean;
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
	// Skill / MCP 绑定草稿：props 只作为初始值（详情页按 revision 重建组件）
	const [draftSkills, setDraftSkills] = useState<readonly AgentResource[]>(skills);
	const [draftMcpServers, setDraftMcpServers] = useState<readonly AgentResource[]>(mcpServers);
	const [pickerOpen, setPickerOpen] = useState<"skill" | "mcp" | null>(null);
	// 目录通常晚于 Agent 详情返回。绑定身份保持不变，只补齐异步到达的名称和状态元数据。
	useEffect(() => {
		setDraftSkills((current) => mergeResourceMetadata(current, skills));
	}, [skills]);
	useEffect(() => {
		setDraftMcpServers((current) => mergeResourceMetadata(current, mcpServers));
	}, [mcpServers]);
	const bindingKey = `${draftSkills.map((item) => `${item.id}@${item.revision ?? 0}`).join(",")}|${draftMcpServers
		.map((item) => `${item.id}@${item.revision ?? 0}`)
		.join(",")}`;
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
			bindings: bindingKey,
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
		bindings: bindingKey,
	});
	const formDirty = savedSnapshot !== "" && snapshot !== savedSnapshot;
	const dirty = formDirty || externallyDirty;
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	const selectedModel = models?.find((item) => item.id === model);
	const reasoningCapability = selectedModel?.parameterCapabilities.reasoning;
	useEffect(() => {
		if (selectedModel === undefined || reasoningCapability?.supported === true) return;
		if (!reasoning && effort === undefined) return;
		setReasoning(false);
		setEffort(undefined);
		setSavedSnapshot((current) => {
			const saved = JSON.parse(current) as Record<string, unknown>;
			return JSON.stringify({ ...saved, reasoning: false, effort: undefined });
		});
	}, [selectedModel, reasoningCapability, reasoning, effort]);
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
					skills: draftSkills
						.filter((item) => item.revision !== undefined)
						.map((item) => ({ skillId: item.id, revision: item.revision as number })),
					mcpServers: draftMcpServers
						.filter((item) => item.revision !== undefined)
						.map((item) => ({
							mcpServerId: item.id,
							revision: item.revision as number,
							toolNames: item.toolNames ?? [],
						})),
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
		setDraftSkills(skills);
		setDraftMcpServers(mcpServers);
		setPickerOpen(null);
		onDiscardExternal?.();
	};
	return (
		<main className={`ard-detail-page${embedded ? " is-embedded" : ""}`}>
			<header className="ard-detail-head">
				<button className="ard-back" type="button" onClick={onBack}>
					<Icon name="back" />
					返回 Agents 列表
				</button>
				<div className="ard-title-row">
					<h1>{name}</h1>
					<button type="button" className="ard-title-edit" aria-label="重命名" title="重命名">
						<Icon name="edit" />
					</button>
					{identityEditable ? <span className="ard-tag">编辑</span> : null}
					{hasDraft ? <span className="ard-tag is-draft-tag">含草稿</span> : null}
					<span className={dirty ? "is-dirty" : ""}>
						<Icon name="check" />
						{dirty ? "未保存" : "已保存"}
					</span>
				</div>
				<div className="ard-meta">
					{description.trim() === "" ? null : <p className="ard-desc">{description}</p>}
					<div className="ard-meta-row">
						{createdAt !== undefined ? <span>创建于 {createdAt}</span> : null}
						{createdBy !== undefined ? (
							<>
								<span className="ard-meta-dot" aria-hidden="true" />
								<span>创建人 {createdBy}</span>
							</>
						) : null}
						{agentId !== undefined ? (
							<>
								<span className="ard-meta-dot" aria-hidden="true" />
								<span>
									ID <code>{agentId}</code>
								</span>
							</>
						) : null}
					</div>
				</div>
				<div className="ard-head-actions">
					<button
						type="button"
						className="ard-secondary"
						onClick={onTest}
						disabled={onTest === undefined}
						title={onTest === undefined ? "Chat 调试入口尚未接入" : undefined}
					>
						<Icon name="message" />
						调试
					</button>
					<button
						type="button"
						className="ard-publish-btn"
						onClick={onPublish}
						disabled={onPublish === undefined}
						title={onPublish === undefined ? "发布入口尚未接入" : undefined}
					>
						<Icon name="send" />
						发布
					</button>
					<button type="button" className="ard-icon-btn" aria-label="更多操作">
						<Icon name="more" />
					</button>
				</div>
			</header>
			<div className="ard-detail-body">
				<form
					className="ard-form"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<section className="ard-instructions">
						<h2>Agent 指令</h2>
						<label>
							<span className="ard-label">System Prompt</span>
							<div className="ard-input">
								<textarea
									className="ard-prompt"
									value={prompt}
									maxLength={6000}
									onChange={(event) => setPrompt(event.currentTarget.value)}
								/>
								<span>{prompt.length} / 6000</span>
							</div>
						</label>
						<div className="ard-prompt-toolbar">
							<button type="button" className="ard-chip">
								<Icon name="template" />
								提示词模板 <Icon name="chevronDown" />
							</button>
							<button type="button" className="ard-chip">
								<Icon name="variable" />
								插入变量
							</button>
							<button type="button" className="ard-chip">
								<Icon name="format" />
								格式化
							</button>
						</div>
					</section>

					<section>
						<h2>模型设置</h2>
						<div className="ard-model-row">
							<div className="ard-model-cell">
								<div className="ard-model-cell-label">模型</div>
								<select
									value={model}
									onChange={(event) => {
										const next = event.currentTarget.value;
										setModel(next);
										setReasoning(false);
										setEffort(undefined);
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
								<a className="ard-model-link" href="#model-detail" onClick={(e) => e.preventDefault()}>
									查看模型详情
									<Icon name="external" />
								</a>
								{modelsLoading ? <small className="ard-field-note">正在加载模型目录…</small> : null}
								{modelsError ? (
									<small className="ard-field-error">模型目录加载失败：{modelsError}</small>
								) : null}
							</div>
							<div className="ard-model-cell">
								<div className="ard-model-cell-label">
									深度思考
									<span className="ard-qmark" aria-label="什么是深度思考？">
										?
									</span>
								</div>
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
								<p className="ard-hint">开启后模型会进行更深入的思考，可能增加响应时间</p>
							</div>
							<div className="ard-model-cell">
								<div className="ard-model-cell-label">
									思考强度
									<span className="ard-qmark" aria-label="什么是思考强度？">
										?
									</span>
								</div>
								<EffortSeg
									value={effort}
									onChange={setEffort}
									capability={reasoningCapability}
									disabled={!modelEditable || !reasoning || reasoningCapability?.supported !== true}
								/>
							</div>
						</div>
					</section>

					<section>
						<h2>对话能力</h2>
						<div className="ard-capabilities">
							<Capability
								title="允许新建对话"
								description="用户可以创建新的对话会话"
								icon="chatBox"
								value={newConversations}
								onChange={setNewConversations}
							/>
							<Capability
								title="附件"
								description="允许用户上传文件作为对话输入"
								icon="attachment"
								value={attachments}
								onChange={setAttachments}
							/>
							<Capability
								title="Avatar"
								description="在对话中展示数字 Avatar"
								icon="avatar"
								value={avatar}
								onChange={setAvatar}
							/>
							<Capability
								title="实验性实时语音"
								description="启用对话中的语音输入与输出（实验性）"
								icon="mic"
								value={speech}
								onChange={setSpeech}
							/>
						</div>
					</section>

					<section>
						<div className="ard-section-head">
							<h2>Skill 能力</h2>
							<button
								type="button"
								className="ard-add-btn"
								onClick={() => setPickerOpen(pickerOpen === "skill" ? null : "skill")}
							>
								<Icon name="plus" />
								添加 Skill
							</button>
							{pickerOpen === "skill" ? (
								<ResourcePicker
									options={(skillCatalog ?? []).filter(
										(entry) => !draftSkills.some((item) => item.id === entry.id),
									)}
									emptyLabel={
										skillCatalog === undefined || skillCatalog.length === 0
											? "Skill 目录为空"
											: "目录中的 Skill 都已关联"
									}
									onPick={(entry) => {
										setDraftSkills((current) => [
											...current,
											{
												id: entry.id,
												name: entry.name,
												version: `v${entry.currentRevision}`,
												revision: entry.currentRevision,
												enabled: entry.enabled ?? true,
												toolCount: entry.toolCount,
											},
										]);
										setPickerOpen(null);
									}}
									onClose={() => setPickerOpen(null)}
								/>
							) : null}
						</div>
						<div className="ard-resource-list">
							{resourcesLoading && draftSkills.length === 0 ? (
								<p className="ard-empty">正在加载 Skill 绑定…</p>
							) : draftSkills.length === 0 ? (
								<p className="ard-empty">尚未关联任何 Skill</p>
							) : (
								draftSkills.map((item) => (
									<ResourceRow
										key={item.id}
										item={item}
										kind="skill"
										onRemove={() => setDraftSkills((current) => current.filter((it) => it.id !== item.id))}
									/>
								))
							)}
						</div>
					</section>

					<section>
						<div className="ard-section-head">
							<h2>MCP 能力</h2>
							<button
								type="button"
								className="ard-add-btn"
								onClick={() => setPickerOpen(pickerOpen === "mcp" ? null : "mcp")}
							>
								<Icon name="plus" />
								添加 MCP
							</button>
							{pickerOpen === "mcp" ? (
								<ResourcePicker
									options={(mcpCatalog ?? []).filter(
										(entry) => !draftMcpServers.some((item) => item.id === entry.id),
									)}
									emptyLabel={
										mcpCatalog === undefined || mcpCatalog.length === 0
											? "MCP 目录为空"
											: "目录中的 MCP Server 都已关联"
									}
									onPick={(entry) => {
										setDraftMcpServers((current) => [
											...current,
											{
												id: entry.id,
												name: entry.name,
												version: `v${entry.currentRevision}`,
												revision: entry.currentRevision,
												enabled: entry.enabled ?? true,
												connectionStatus: entry.connectionStatus,
												toolCount: entry.toolCount,
												toolNames: entry.toolNames ?? [],
											},
										]);
										setPickerOpen(null);
									}}
									onClose={() => setPickerOpen(null)}
								/>
							) : null}
						</div>
						<div className="ard-resource-list">
							{resourcesLoading && draftMcpServers.length === 0 ? (
								<p className="ard-empty">正在加载 MCP 绑定…</p>
							) : draftMcpServers.length === 0 ? (
								<p className="ard-empty">尚未关联任何 MCP Server</p>
							) : (
								draftMcpServers.map((item) => (
									<ResourceRow
										key={item.id}
										item={item}
										kind="mcp"
										onRemove={() =>
											setDraftMcpServers((current) => current.filter((it) => it.id !== item.id))
										}
									/>
								))
							)}
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

				<aside className="ard-side" aria-label="发布信息">
					<PublishStatusCard publishData={publishData} onPublish={onPublish} />
					<PublishedInfoCard
						version={publishData.currentVersion}
						modelName={selectedModel?.name ?? (model === "" ? "未选择" : model)}
						reasoningEnabled={reasoning}
						effort={effort}
						skills={draftSkills}
						mcpServers={draftMcpServers}
						newConversations={newConversations}
						attachments={attachments}
						avatar={avatar}
						liveSpeech={speech}
					/>
					<ExternalAccessCard link={publishData.externalLink} />
					<MoreCard history={publishData.versionHistory} />
				</aside>
			</div>
		</main>
	);
}

function ResourceRow({
	item,
	kind,
	onRemove,
}: {
	readonly item: AgentResource;
	readonly kind: "skill" | "mcp";
	readonly onRemove?: () => void;
}): React.ReactElement {
	const detail: string = [item.description, item.toolCount === undefined ? undefined : `工具 ${item.toolCount} 个`]
		.filter((part): part is string => part !== undefined && part !== "")
		.join(" · ");
	const mcpStatus =
		item.connectionStatus === "connected"
			? { label: "已连接", on: true }
			: item.connectionStatus === "failed"
				? { label: "连接失败", on: false }
				: { label: "未测试", on: false };
	return (
		<div className="ard-resource-item">
			<span className="ard-resource-icon" aria-hidden="true">
				<Icon name={kind === "skill" ? "cube" : "mcp"} />
			</span>
			<span className="ard-resource-body">
				<span className="ard-resource-name">
					{item.name}
					{item.version !== undefined ? <small className="ard-resource-version">{item.version}</small> : null}
					{item.outdated === true ? <small className="ard-resource-outdated">有新版本</small> : null}
				</span>
				{detail === "" ? null : <span className="ard-resource-desc">{detail}</span>}
			</span>
			<span className={`ard-resource-status ${(kind === "mcp" ? mcpStatus.on : item.enabled) ? "is-on" : "is-off"}`}>
				<i aria-hidden="true" />
				{kind === "mcp" ? mcpStatus.label : item.enabled ? "已启用" : "未启用"}
			</span>
			{onRemove === undefined ? null : (
				<button type="button" className="ard-resource-remove" aria-label={`移除 ${item.name}`} onClick={onRemove}>
					移除
				</button>
			)}
		</div>
	);
}

function mergeResourceMetadata(
	current: readonly AgentResource[],
	incoming: readonly AgentResource[],
): readonly AgentResource[] {
	let changed = false;
	const merged = current.map((item) => {
		const metadata = incoming.find((candidate) => candidate.id === item.id);
		if (metadata === undefined) return item;
		const next = {
			...item,
			name: metadata.name,
			description: metadata.description,
			enabled: metadata.enabled,
			connectionStatus: metadata.connectionStatus,
			toolCount: metadata.toolCount,
			outdated: metadata.outdated,
		};
		if (
			next.name === item.name &&
			next.description === item.description &&
			next.enabled === item.enabled &&
			next.connectionStatus === item.connectionStatus &&
			next.toolCount === item.toolCount &&
			next.outdated === item.outdated
		)
			return item;
		changed = true;
		return next;
	});
	return changed ? merged : current;
}

/** 目录选择 popover：只列出尚未绑定的条目。 */
function ResourcePicker({
	options,
	emptyLabel,
	onPick,
	onClose,
}: {
	readonly options: readonly AgentCatalogEntry[];
	readonly emptyLabel: string;
	readonly onPick: (entry: AgentCatalogEntry) => void;
	readonly onClose: () => void;
}): React.ReactElement {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onPointerDown = (event: MouseEvent): void => {
			const target = event.target as Element | null;
			if (target !== null && target.closest(".ard-resource-picker, .ard-add-btn") !== null) return;
			onClose();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [onClose]);
	return (
		<div className="ard-resource-picker" ref={ref} role="listbox" aria-label="可添加的资源">
			{options.length === 0 ? (
				<p className="ard-picker-empty">{emptyLabel}</p>
			) : (
				options.map((entry) => (
					<button key={entry.id} type="button" role="option" aria-selected="false" onClick={() => onPick(entry)}>
						<span>{entry.name}</span>
						<small>v{entry.currentRevision}</small>
					</button>
				))
			)}
		</div>
	);
}

function PublishStatusCard({
	publishData,
	onPublish,
}: {
	readonly publishData: AgentPublishData;
	readonly onPublish?: () => void;
}): React.ReactElement {
	const statusLabel: Record<PublishStatus, string> = {
		online: "已发布",
		paused: "已暂停",
		draft: "未发布",
	};
	const isCurrent = publishData.status === "online" && publishData.draftRevision === publishData.currentVersion;
	return (
		<section className="ard-side-card ard-publish-status-card" aria-label="发布状态">
			<h3>发布状态</h3>
			<div className="ard-side-status">
				<i aria-hidden="true" className={`is-${publishData.status}`} />
				<strong>{statusLabel[publishData.status]}</strong>
			</div>
			<p className="ard-publish-subtitle">
				{publishData.status === "online" ? "线上版本正在运行" : "当前 Agent 尚未上线"}
			</p>
			<div className="ard-version-compare">
				<div>
					<small>当前（草稿）</small>
					<span>Revision</span>
					<strong>{publishData.draftRevision.replace(/^Revision\s*/, "v")}</strong>
					<span>保存于</span>
					<b>{publishData.draftSavedAt}</b>
				</div>
				<i>VS</i>
				<div>
					<small>线上（已发布）</small>
					<span>Revision</span>
					<strong>
						{publishData.currentVersion === "" ? "—" : publishData.currentVersion.replace(/^Revision\s*/, "v")}
					</strong>
					<span>发布于</span>
					<b>{publishData.lastPublishedAt || "—"}</b>
				</div>
			</div>
			<div className={`ard-publish-sync ${isCurrent ? "is-current" : ""}`}>
				<span>
					<Icon name={isCurrent ? "check" : "history"} />
					<strong>{isCurrent ? "当前配置已与线上版本一致" : "当前配置有更新"}</strong>
					<small>{isCurrent ? "无需重新发布" : "发布后更新线上版本"}</small>
				</span>
				<button type="button" onClick={onPublish} disabled={onPublish === undefined || isCurrent}>
					<Icon name="send" />
					{isCurrent
						? `发布当前版本（${publishData.currentVersion.replace(/^Revision\s*/, "v")}）`
						: "发布当前版本"}
				</button>
			</div>
		</section>
	);
}

function PublishedInfoCard({
	version,
	modelName,
	reasoningEnabled,
	effort,
	skills,
	mcpServers,
	newConversations,
	attachments,
	avatar,
	liveSpeech,
}: {
	readonly version: string;
	readonly modelName: string;
	readonly reasoningEnabled: boolean;
	readonly effort: ReasoningEffort | undefined;
	readonly skills: readonly AgentResource[];
	readonly mcpServers: readonly AgentResource[];
	readonly newConversations: boolean;
	readonly attachments: boolean;
	readonly avatar: boolean;
	readonly liveSpeech: boolean;
}): React.ReactElement {
	const effortDisplay: Record<string, string> = { low: "低", medium: "中", high: "高" };
	return (
		<section className="ard-side-card ard-published-info" aria-label="线上版本信息">
			<div className="ard-side-card-head">
				<h3>线上版本信息（{version === "" ? "—" : version.replace(/^Revision\s*/, "v")}）</h3>
				<span>
					<Icon name="eye" /> 预览
				</span>
			</div>
			<div className="ard-published-grid">
				<InfoTile icon="model" title="模型">
					<strong>{modelName}</strong>
				</InfoTile>
				<InfoTile icon="bulb" title="思考设置">
					<span>
						深度思考：<b>{reasoningEnabled ? "开启" : "关闭"}</b>
					</span>
					<span>
						思考强度：<b>{effort === undefined ? "—" : (effortDisplay[effort] ?? effort)}</b>
					</span>
				</InfoTile>
				<InfoTile icon="cube" title={`技能（${skills.length}）`}>
					<strong>{skills.length === 0 ? "未绑定" : skills.map((item) => item.name).join("、")}</strong>
					<span className={skills.some((item) => item.enabled) ? "is-positive" : ""}>
						{skills.some((item) => item.enabled) ? "已启用" : "未启用"}
					</span>
				</InfoTile>
				<InfoTile icon="mcp" title={`MCP Server（${mcpServers.length}）`}>
					<strong>{mcpServers.length === 0 ? "未绑定" : mcpServers.map((item) => item.name).join("、")}</strong>
					<span className={mcpServers.some((item) => item.connectionStatus === "connected") ? "is-positive" : ""}>
						{mcpServers.some((item) => item.connectionStatus === "connected") ? "已连接" : "未连接"}
					</span>
				</InfoTile>
				<InfoTile icon="chatBox" title="对话能力">
					<span>
						新建对话：<b>{newConversations ? "允许" : "关闭"}</b>
					</span>
					<span>
						附件：<b>{attachments ? "允许" : "关闭"}</b>
					</span>
					<span>
						Avatar：<b>{avatar ? "开启" : "关闭"}</b>
					</span>
					<span>
						实时语音：<b>{liveSpeech ? "开启" : "关闭"}</b>
					</span>
				</InfoTile>
				<InfoTile icon="spark" title="其他能力">
					<span>
						实验性功能：<b>{liveSpeech ? "开启" : "关闭"}</b>
					</span>
					<span>
						预设建议：<b>关闭</b>
					</span>
				</InfoTile>
			</div>
		</section>
	);
}

function InfoTile({
	icon,
	title,
	children,
}: {
	readonly icon: string;
	readonly title: string;
	readonly children: ReactNode;
}): React.ReactElement {
	return (
		<article className="ard-info-tile">
			<h4>
				<Icon name={icon} />
				{title}
			</h4>
			<div>{children}</div>
		</article>
	);
}

function ExternalAccessCard({ link }: { readonly link?: string }): React.ReactElement {
	const [copied, setCopied] = useState(false);
	const copy = async (): Promise<void> => {
		if (link === undefined) return;
		await navigator.clipboard.writeText(link);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	};
	return (
		<section className="ard-side-card ard-external-card" aria-label="对外访问">
			<h3>对外访问</h3>
			<div>
				<code>{link ?? "尚未发布，暂无访问地址"}</code>
				<button type="button" disabled={link === undefined} onClick={() => void copy()} aria-label="复制访问地址">
					<Icon name={copied ? "check" : "copy"} />
				</button>
			</div>
			{link === undefined ? null : (
				<a href={link} target="_blank" rel="noreferrer">
					打开 Public Chat <Icon name="external" />
				</a>
			)}
		</section>
	);
}

function MoreCard({ history }: { readonly history: readonly VersionHistoryItem[] }): React.ReactElement {
	return (
		<section className="ard-side-card ard-more-card" aria-label="更多">
			<h3>更多</h3>
			<details>
				<summary>
					查看版本历史 <Icon name="chevron" />
				</summary>
				{history.length === 0 ? (
					<p className="ard-side-empty">还没有 Revision</p>
				) : (
					<div className="ard-version-list">
						{history.map((item) => (
							<button type="button" className="ard-version-item" key={item.version}>
								<span className="ard-instance-icon" aria-hidden="true">
									<Icon name="history" />
								</span>
								<span className="ard-instance-body">
									<span className="ard-version-name">
										{item.version}
										{item.isCurrent ? <small className="ard-version-current">当前版本</small> : null}
									</span>
									<span className="ard-version-meta">
										{item.createdAt} · {item.author}
									</span>
								</span>
								<Icon name="chevron" />
							</button>
						))}
					</div>
				)}
			</details>
			<button type="button" disabled title="发布日志暂未开放">
				查看发布日志 <Icon name="chevron" />
			</button>
		</section>
	);
}

/**
 * Thinking-intensity segmented control — always renders three buttons
 * (低 / 中 / 高). If the selected model declares a specific effort list,
 * unsupported values are disabled; otherwise all three are enabled.
 */
function EffortSeg({
	value,
	onChange,
	capability,
	disabled,
}: {
	readonly value: ReasoningEffort | undefined;
	readonly onChange: (next: ReasoningEffort) => void;
	readonly capability: LlmAvailableModel["parameterCapabilities"]["reasoning"] | undefined;
	readonly disabled: boolean;
}): React.ReactElement {
	const options: readonly { readonly label: string; readonly value: ReasoningEffort }[] = [
		{ label: "低", value: "low" },
		{ label: "中", value: "medium" },
		{ label: "高", value: "high" },
	];
	const supported: ReadonlySet<ReasoningEffort> = new Set(capability?.supported ? capability.efforts : []);
	return (
		<div className="ard-seg" role="radiogroup" aria-label="思考强度">
			{options.map(({ label, value: optionValue }) => {
				const isActive = value === optionValue;
				const isSupported = supported.has(optionValue);
				return (
					<button
						key={optionValue}
						type="button"
						role="radio"
						aria-checked={isActive}
						className={isActive ? "is-active" : ""}
						onClick={() => onChange(optionValue)}
						disabled={disabled || !isSupported}
					>
						{label}
					</button>
				);
			})}
		</div>
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

/**
 * Standalone preview entry used by `/ui-preview/agent-redesign` (no shell, no auth).
 * Backed by the built-in mock data so the page works without a Control API.
 */
export function AgentRedesignPreview(): React.ReactElement {
	return (
		<AgentListPreview
			onOpen={() => {}}
			onCreate={() => {}}
			initialView="detail"
			initialItemId={AGENTS[0]?.id ?? null}
		/>
	);
}

function Capability({
	title,
	description,
	icon,
	value,
	onChange,
}: {
	readonly title: string;
	readonly description: string;
	readonly icon: string;
	readonly value: boolean;
	readonly onChange: (value: boolean) => void;
}): React.ReactElement {
	return (
		<div className="ard-capability">
			<span className="ard-cap-icon" aria-hidden="true">
				<Icon name={icon} />
			</span>
			<span className="ard-cap-text">
				<b>{title}</b>
				<small>{description}</small>
			</span>
			<Switch checked={value} onChange={onChange} />
		</div>
	);
}
