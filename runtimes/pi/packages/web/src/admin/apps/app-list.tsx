/**
 * App List — 设计收口（设计稿基于 mock data 锁定信息架构）。
 *
 * 字段结构沿用既有约定：name / boundAgent / boundAgentRevision / accessMode /
 * status / updatedAt / updatedBy。
 */
import { useMemo, useState } from "react";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { FilterBar, FilterSearch, FilterSelect } from "../components/FilterBar.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { Table, type TableColumn } from "../components/Table.tsx";
import { navigate } from "../router.ts";

type AppStatus = "active" | "draft" | "suspended" | "archived";
type AccessMode = "anonymous" | "signed_user" | "mixed";

interface AppRow {
	readonly id: string;
	readonly name: string;
	readonly publicAppId: string;
	readonly boundAgentName: string;
	readonly boundAgentId: string;
	readonly boundAgentRevision: number;
	readonly accessMode: AccessMode;
	readonly status: AppStatus;
	readonly updatedAt: string;
	readonly updatedBy: string;
}

const MOCK_APPS: readonly AppRow[] = [
	{
		id: "app_demo_001",
		name: "官网客服",
		publicAppId: "app_pub_8f3c1e2a",
		boundAgentName: "客服 Agent",
		boundAgentId: "agent_demo_customer_service",
		boundAgentRevision: 12,
		accessMode: "anonymous",
		status: "active",
		updatedAt: "2026-08-15 10:32",
		updatedBy: "alice@example.com",
	},
	{
		id: "app_demo_002",
		name: "内部客服工作台",
		publicAppId: "app_pub_4a92be71",
		boundAgentName: "客服 Agent",
		boundAgentId: "agent_demo_customer_service",
		boundAgentRevision: 11,
		accessMode: "signed_user",
		status: "active",
		updatedAt: "2026-08-10 14:48",
		updatedBy: "bob@example.com",
	},
	{
		id: "app_demo_003",
		name: "客服测试环境预览",
		publicAppId: "app_pub_2c7dfa09",
		boundAgentName: "客服 Agent",
		boundAgentId: "agent_demo_customer_service",
		boundAgentRevision: 13,
		accessMode: "anonymous",
		status: "draft",
		updatedAt: "2026-08-16 18:01",
		updatedBy: "alice@example.com",
	},
	{
		id: "app_demo_004",
		name: "合同审查控制台",
		publicAppId: "app_pub_6e1b09dc",
		boundAgentName: "合同审查 Agent",
		boundAgentId: "agent_demo_contract_review",
		boundAgentRevision: 8,
		accessMode: "signed_user",
		status: "active",
		updatedAt: "2026-08-12 09:14",
		updatedBy: "bob@example.com",
	},
	{
		id: "app_demo_005",
		name: "数据分析控制台",
		publicAppId: "app_pub_71b2ce40",
		boundAgentName: "数据分析 Agent",
		boundAgentId: "agent_demo_data_analyst",
		boundAgentRevision: 21,
		accessMode: "signed_user",
		status: "suspended",
		updatedAt: "2026-07-28 11:05",
		updatedBy: "carol@example.com",
	},
	{
		id: "app_demo_006",
		name: "知识库检索",
		publicAppId: "app_pub_09c4f812",
		boundAgentName: "知识问答 Agent",
		boundAgentId: "agent_demo_knowledge_qa",
		boundAgentRevision: 5,
		accessMode: "anonymous",
		status: "active",
		updatedAt: "2026-08-10 14:48",
		updatedBy: "alice@example.com",
	},
	{
		id: "app_demo_007",
		name: "销售助手嵌入",
		publicAppId: "app_pub_a2b7c4f1",
		boundAgentName: "销售助手",
		boundAgentId: "agent_demo_sales",
		boundAgentRevision: 9,
		accessMode: "mixed",
		status: "active",
		updatedAt: "2026-08-09 16:22",
		updatedBy: "dave@example.com",
	},
	{
		id: "app_demo_008",
		name: "内部知识助手（停用）",
		publicAppId: "app_pub_4d8e2a17",
		boundAgentName: "内部知识助手",
		boundAgentId: "agent_demo_internal_assistant",
		boundAgentRevision: 3,
		accessMode: "signed_user",
		status: "archived",
		updatedAt: "2026-06-30 11:11",
		updatedBy: "alice@example.com",
	},
];

const STATUS_LABEL: Record<AppStatus, string> = {
	active: "已发布",
	draft: "未发布",
	suspended: "已暂停",
	archived: "已归档",
};

const ACCESS_LABEL: Record<AccessMode, string> = {
	anonymous: "匿名访问",
	signed_user: "登录用户",
	mixed: "混合",
};

const STATUS_FILTER_OPTIONS: readonly { value: AppStatus | "all"; label: string }[] = [
	{ value: "all", label: "全部状态" },
	{ value: "active", label: "已发布" },
	{ value: "draft", label: "未发布" },
	{ value: "suspended", label: "已暂停" },
	{ value: "archived", label: "已归档" },
];

const monoStyle: React.CSSProperties = {
	fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
	fontSize: 12,
	color: "var(--admin-text-secondary)",
};

function NameCell({ row }: { row: AppRow }): React.ReactElement {
	const initial = row.name.charAt(0);
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
			<span
				aria-hidden="true"
				style={{
					width: 32,
					height: 32,
					borderRadius: 8,
					background: "var(--admin-info-soft)",
					color: "var(--admin-info)",
					display: "grid",
					placeItems: "center",
					fontWeight: 600,
					fontSize: 13,
					flexShrink: 0,
				}}
			>
				{initial}
			</span>
			<div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
				<button
					type="button"
					style={{
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
					}}
					onClick={() => navigate(`/apps/${row.id}`)}
				>
					{row.name}
				</button>
				<span
					style={{
						fontSize: 11,
						color: "var(--admin-text-faint)",
						fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
					}}
				>
					{row.publicAppId}
				</span>
			</div>
		</div>
	);
}

function UpdatedCell({ row }: { row: AppRow }): React.ReactElement {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
			<span>{row.updatedAt}</span>
			<span style={{ fontSize: 12, color: "var(--admin-text-muted)" }}>by {row.updatedBy}</span>
		</div>
	);
}

export function AppListView(): React.ReactElement {
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<AppStatus | "all">("all");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(10);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return MOCK_APPS.filter((row) => {
			if (statusFilter !== "all" && row.status !== statusFilter) return false;
			if (needle === "") return true;
			return (
				row.name.toLowerCase().includes(needle) ||
				row.publicAppId.toLowerCase().includes(needle) ||
				row.boundAgentName.toLowerCase().includes(needle)
			);
		});
	}, [query, statusFilter]);

	const totalCount = MOCK_APPS.length;
	const activeCount = MOCK_APPS.filter((r) => r.status === "active").length;
	const agentCount = new Set(MOCK_APPS.map((r) => r.boundAgentId)).size;
	const revisionBindingCount = new Set(MOCK_APPS.map((r) => `${r.boundAgentId}#${r.boundAgentRevision}`)).size;

	const columns: readonly TableColumn<AppRow>[] = [
		{
			key: "name",
			header: "名称",
			render: (row) => <NameCell row={row} />,
			width: 280,
		},
		{
			key: "agent",
			header: "绑定 Agent",
			render: (row) => (
				<button
					type="button"
					style={{
						background: "transparent",
						border: 0,
						padding: 0,
						color: "var(--admin-text-primary)",
						fontWeight: 500,
						cursor: "pointer",
					}}
					onClick={() => navigate(`/agents/${row.boundAgentId}`)}
				>
					{row.boundAgentName}
				</button>
			),
		},
		{
			key: "revision",
			header: "Revision",
			render: (row) => <span style={monoStyle}>v{row.boundAgentRevision}</span>,
		},
		{
			key: "access",
			header: "访问类型",
			render: (row) => <Badge variant="info">{ACCESS_LABEL[row.accessMode]}</Badge>,
		},
		{
			key: "status",
			header: "状态",
			render: (row) => (
				<Badge
					variant={
						row.status === "active"
							? "active"
							: row.status === "draft"
								? "draft"
								: row.status === "suspended"
									? "suspended"
									: "archived"
					}
					dot={row.status === "active"}
				>
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
					<Button size="sm" variant="ghost" disabled={row.status !== "active"}>
						预览
					</Button>
					<Button size="sm" variant="ghost">
						设置
					</Button>
				</div>
			),
			align: "right",
		},
	];

	return (
		<section aria-label="应用列表">
			<PageHeader
				title="应用"
				actions={
					<Button variant="primary" onClick={() => navigate("/apps")}>
						+ 创建应用
					</Button>
				}
			/>

			<FilterBar
				left={
					<>
						<FilterSearch placeholder="按名称 / 绑定 Agent / Public ID 搜索" value={query} onChange={setQuery} />
						<FilterSelect
							ariaLabel="状态筛选"
							value={statusFilter}
							onChange={(v) => setStatusFilter(v as AppStatus | "all")}
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
					个应用
				</span>
				<span>
					<strong style={{ color: "var(--admin-text-primary)", fontWeight: 600, marginRight: 4 }}>
						{activeCount}
					</strong>
					个已发布
				</span>
				<span>
					<strong style={{ color: "var(--admin-text-primary)", fontWeight: 600, marginRight: 4 }}>
						{agentCount}
					</strong>
					个 Agent 被发布
				</span>
				<span>
					<strong style={{ color: "var(--admin-text-primary)", fontWeight: 600, marginRight: 4 }}>
						{revisionBindingCount}
					</strong>
					条 Agent × Revision 绑定
				</span>
			</div>

			<Table<AppRow>
				columns={columns}
				rows={filtered}
				rowKey={(row) => row.id}
				emptyTitle="没有匹配的应用"
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
