/**
 * Agent List — 设计收口（设计稿基于 mock data 锁定信息架构）。
 *
 * 字段结构沿用既有约定：
 *   name / description / modelId / tools / revision / status / updatedAt / updatedBy
 *
 * 后续接入 Control API 时，把 MOCK_AGENTS 替换为对 AgentApi.listAgents
 * + AgentApi.getAgentDetail 的并发请求即可，行结构保持稳定。
 */
import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { useMemo, useState } from "react";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { FilterBar, FilterSearch, FilterSelect } from "../components/FilterBar.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { Table, type TableColumn } from "../components/Table.tsx";
import { navigate } from "../router.ts";

type AgentStatus = "active" | "draft" | "archived";

interface AgentRow {
	readonly id: AgentPublicId;
	readonly name: string;
	readonly description: string;
	readonly modelId: string;
	readonly tools: readonly string[];
	readonly revision: number;
	readonly status: AgentStatus;
	readonly updatedAt: string;
	readonly updatedBy: string;
}

const MOCK_AGENTS: readonly AgentRow[] = [
	{
		id: "agent_demo_customer_service" as AgentPublicId,
		name: "客服 Agent",
		description: "面向 C 端用户的智能客服，整合知识库检索与多轮上下文。",
		modelId: "claude-sonnet-4.5",
		tools: ["知识库检索", "工单创建", "退款查询", "意图识别", "多轮上下文"],
		revision: 12,
		status: "active",
		updatedAt: "2026-08-15 10:32",
		updatedBy: "alice@example.com",
	},
	{
		id: "agent_demo_contract_review" as AgentPublicId,
		name: "合同审查 Agent",
		description: "法务助手，自动审查合同条款、识别潜在风险并给出修订建议。",
		modelId: "claude-opus-5",
		tools: ["条款比对", "风险条款识别", "修订建议生成"],
		revision: 8,
		status: "active",
		updatedAt: "2026-08-12 09:14",
		updatedBy: "bob@example.com",
	},
	{
		id: "agent_demo_data_analyst" as AgentPublicId,
		name: "数据分析 Agent",
		description: "支持自然语言查询数据库，输出 SQL 与可视化图表。",
		modelId: "claude-sonnet-4.5",
		tools: ["SQL 生成", "Schema 检索", "可视化图表", "数据采样", "异常检测", "导出 CSV", "报表模板"],
		revision: 21,
		status: "draft",
		updatedAt: "2026-08-16 18:01",
		updatedBy: "carol@example.com",
	},
	{
		id: "agent_demo_knowledge_qa" as AgentPublicId,
		name: "知识问答 Agent",
		description: "基于内部知识库的语义检索与回答。",
		modelId: "claude-haiku-4.5",
		tools: ["语义检索", "引用标注"],
		revision: 5,
		status: "active",
		updatedAt: "2026-08-10 14:48",
		updatedBy: "alice@example.com",
	},
	{
		id: "agent_demo_sales" as AgentPublicId,
		name: "销售助手",
		description: "辅助销售跟进客户、生成报价与会议纪要。",
		modelId: "claude-sonnet-4.5",
		tools: ["客户画像", "报价生成", "会议纪要", "邮件草稿"],
		revision: 9,
		status: "active",
		updatedAt: "2026-08-09 16:22",
		updatedBy: "dave@example.com",
	},
	{
		id: "agent_demo_internal_assistant" as AgentPublicId,
		name: "内部知识助手",
		description: "面向员工，集成 wiki / 工单 / 表单检索。",
		modelId: "claude-haiku-4.5",
		tools: ["Wiki 检索", "工单创建", "日历读取"],
		revision: 3,
		status: "archived",
		updatedAt: "2026-06-30 11:11",
		updatedBy: "alice@example.com",
	},
];

const STATUS_LABEL: Record<AgentStatus, string> = {
	active: "已发布",
	draft: "有草稿",
	archived: "已归档",
};

const STATUS_FILTER_OPTIONS: readonly { value: AgentStatus | "all"; label: string }[] = [
	{ value: "all", label: "全部状态" },
	{ value: "active", label: "已发布" },
	{ value: "draft", label: "有草稿" },
	{ value: "archived", label: "已归档" },
];

function statusToBadgeVariant(status: AgentStatus): "active" | "draft" | "archived" {
	return status;
}

function ModelCell({ modelId }: { modelId: string }): React.ReactElement {
	return <span style={modelCellStyle}>{modelId}</span>;
}

const modelCellStyle: React.CSSProperties = {
	fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
	fontSize: 12,
	color: "var(--admin-text-secondary)",
};

function NameCell({ row }: { row: AgentRow }): React.ReactElement {
	const initial = row.name.charAt(0);
	return (
		<div style={nameCellWrap}>
			<span style={glyphStyle} aria-hidden="true">
				{initial}
			</span>
			<div style={nameBlockStyle}>
				<button
					type="button"
					style={nameButtonStyle}
					onClick={(e) => {
						e.stopPropagation();
						navigate(`/agents/${row.id}`);
					}}
				>
					{row.name}
				</button>
				<span style={idSubStyle}>id: {row.id}</span>
			</div>
		</div>
	);
}

const nameCellWrap: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 12,
	minWidth: 0,
};

const glyphStyle: React.CSSProperties = {
	width: 32,
	height: 32,
	borderRadius: 8,
	background: "var(--admin-accent-soft)",
	color: "var(--admin-accent-strong)",
	display: "grid",
	placeItems: "center",
	fontWeight: 600,
	fontSize: 13,
	flexShrink: 0,
};

const nameBlockStyle: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 2,
	minWidth: 0,
};

const nameButtonStyle: React.CSSProperties = {
	background: "transparent",
	border: 0,
	padding: 0,
	color: "var(--admin-text-primary)",
	fontWeight: 600,
	fontSize: 14,
	textAlign: "left",
	cursor: "pointer",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
};

const idSubStyle: React.CSSProperties = {
	fontSize: 11,
	color: "var(--admin-text-faint)",
	fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
};

function ToolsCell({ tools }: { tools: readonly string[] }): React.ReactElement {
	if (tools.length === 0) return <span style={{ color: "var(--admin-text-muted)" }}>未配置</span>;
	const visible = tools.slice(0, 3);
	const extra = tools.length - visible.length;
	return (
		<div style={toolsWrap}>
			{visible.map((tool) => (
				<span key={tool} style={chipStyle} title={tool}>
					{tool}
				</span>
			))}
			{extra > 0 ? <span style={chipMoreStyle}>+{extra}</span> : null}
		</div>
	);
}

const toolsWrap: React.CSSProperties = {
	display: "flex",
	flexWrap: "wrap",
	gap: 4,
	maxWidth: 280,
};

const chipStyle: React.CSSProperties = {
	fontSize: 11,
	padding: "2px 8px",
	borderRadius: 999,
	background: "var(--admin-bg-inset)",
	color: "var(--admin-text-secondary)",
	lineHeight: 1.5,
};

const chipMoreStyle: React.CSSProperties = {
	...chipStyle,
	background: "transparent",
	color: "var(--admin-text-muted)",
};

function UpdatedCell({ row }: { row: AgentRow }): React.ReactElement {
	return (
		<div style={updatedWrap}>
			<span>{row.updatedAt}</span>
			<span style={updatedByStyle}>by {row.updatedBy}</span>
		</div>
	);
}

const updatedWrap: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 2,
	fontSize: 13,
};

const updatedByStyle: React.CSSProperties = {
	fontSize: 12,
	color: "var(--admin-text-muted)",
};

export function AgentListView(): React.ReactElement {
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<AgentStatus | "all">("all");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(10);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return MOCK_AGENTS.filter((row) => {
			if (statusFilter !== "all" && row.status !== statusFilter) return false;
			if (needle === "") return true;
			return (
				row.name.toLowerCase().includes(needle) ||
				row.description.toLowerCase().includes(needle) ||
				row.modelId.toLowerCase().includes(needle) ||
				row.tools.some((tool) => tool.toLowerCase().includes(needle))
			);
		});
	}, [query, statusFilter]);

	const totalCount = MOCK_AGENTS.length;
	const draftCount = MOCK_AGENTS.filter((r) => r.status === "draft").length;
	const totalTools = MOCK_AGENTS.reduce((sum, r) => sum + r.tools.length, 0);

	const columns: readonly TableColumn<AgentRow>[] = [
		{
			key: "name",
			header: "名称",
			render: (row) => <NameCell row={row} />,
			width: 260,
		},
		{
			key: "description",
			header: "描述",
			render: (row) => (
				<span
					style={{
						display: "-webkit-box",
						WebkitLineClamp: 2,
						WebkitBoxOrient: "vertical",
						overflow: "hidden",
						color: "var(--admin-text-secondary)",
						lineHeight: 1.5,
						maxWidth: 320,
					}}
				>
					{row.description}
				</span>
			),
		},
		{
			key: "model",
			header: "模型",
			render: (row) => <ModelCell modelId={row.modelId} />,
		},
		{
			key: "tools",
			header: "Tools",
			render: (row) => <ToolsCell tools={row.tools} />,
		},
		{
			key: "revision",
			header: "Revision",
			render: (row) => <span style={modelCellStyle}>v{row.revision}</span>,
		},
		{
			key: "status",
			header: "状态",
			render: (row) => (
				<Badge variant={statusToBadgeVariant(row.status)} dot={row.status === "active"}>
					{STATUS_LABEL[row.status]}
				</Badge>
			),
		},
		{
			key: "updated",
			header: "更新时间",
			render: (row) => <UpdatedCell row={row} />,
		},
		{
			key: "actions",
			header: "操作",
			render: (row) => (
				<div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
					<Button size="sm" variant="ghost" onClick={() => navigate(`/agents/${row.id}`)}>
						编辑
					</Button>
					<Button size="sm" variant="ghost">
						修订
					</Button>
				</div>
			),
			cellClassName: "col-actions",
			align: "right",
		},
	];

	return (
		<section aria-label="Agent 列表">
			<PageHeader
				title="Agent"
				subtitle="一个 Agent 代表可复用、可版本化的 AI 能力单元：模型、提示词、工具、知识库与运行参数。每次保存都会生成不可变的 Revision，发布给用户时再绑定到具体的应用。"
				actions={
					<Button variant="primary" onClick={() => navigate("/agents")}>
						+ 创建 Agent
					</Button>
				}
			/>

			<FilterBar
				left={
					<>
						<FilterSearch placeholder="按名称 / 描述 / 模型 / 工具搜索" value={query} onChange={setQuery} />
						<FilterSelect
							ariaLabel="状态筛选"
							value={statusFilter}
							onChange={(v) => setStatusFilter(v as AgentStatus | "all")}
							options={STATUS_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
						/>
					</>
				}
				right={
					<>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setQuery("");
								setStatusFilter("all");
							}}
						>
							重置
						</Button>
						<Button variant="secondary" size="sm">
							导出
						</Button>
					</>
				}
			/>

			<div
				style={{
					display: "flex",
					gap: 24,
					padding: "0 4px",
					margin: "0 0 12px",
					color: "var(--admin-text-secondary)",
					fontSize: 13,
				}}
			>
				<span>
					<strong style={{ color: "var(--admin-text-primary)", fontWeight: 600, marginRight: 4 }}>
						{totalCount}
					</strong>
					个 Agent
				</span>
				<span>
					<strong style={{ color: "var(--admin-text-primary)", fontWeight: 600, marginRight: 4 }}>
						{draftCount}
					</strong>
					个有未保存草稿
				</span>
				<span>
					<strong style={{ color: "var(--admin-text-primary)", fontWeight: 600, marginRight: 4 }}>
						{totalTools}
					</strong>
					个 Tool 总数
				</span>
			</div>

			<Table<AgentRow>
				columns={columns}
				rows={filtered}
				rowKey={(row) => row.id}
				emptyTitle="没有匹配的 Agent"
				emptyDescription="尝试调整搜索关键词或筛选条件。"
			/>

			<Pagination
				total={filtered.length}
				page={page}
				pageSize={pageSize}
				onPageChange={setPage}
				onPageSizeChange={(s) => {
					setPageSize(s);
					setPage(1);
				}}
			/>
		</section>
	);
}
