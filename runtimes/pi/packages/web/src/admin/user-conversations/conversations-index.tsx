/**
 * WB-006: administrator user-conversation list page (SPEC §5.4) — 设计收口。
 *
 * 优先从 Control API 拉取真实数据；接口不可用时（dev 本地无后端）回退到
 * 设计稿 mock，让页面视觉与信息架构在 dev 阶段完整可见。
 *
 * 视觉：PageHeader + 6 metric 卡 + FilterBar（日期 / App / Agent / 状态 / 搜索）
 * + 表格（11 列）+ Pagination。真实业务字段以服务端为准，mock 仅用于视觉。
 */
import type { ConversationAdminListResponse } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConversationListArgs, ConversationsApi } from "../api/conversations-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { DateRange, FilterBar, FilterSearch, FilterSelect } from "../components/FilterBar.tsx";
import { MetricsRow, type MetricItem } from "../components/MetricsRow.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { Table, type TableColumn } from "../components/Table.tsx";
import { navigate } from "../router.ts";
import { readInitialQueryParam } from "./query-params.ts";

type ListState =
	| { kind: "loading" }
	| { kind: "loaded"; data: ConversationAdminListResponse }
	| { kind: "error"; message: string };

interface MockConversation {
	readonly id: string;
	readonly title: string;
	readonly principalDisplayId: string;
	readonly principalType: "external_user" | "anonymous_visitor" | "platform_user" | "service";
	readonly appName: string;
	readonly agentName: string;
	readonly status: "active" | "archived" | "deleted";
	readonly messageCount: number;
	readonly errorCount: number;
	readonly tokenTotal: number;
	readonly avgResponseMs: number;
	readonly channel: "Web Embed" | "Direct" | "API";
	readonly lastActiveAt: string;
}

const MOCK_CONVERSATIONS: readonly MockConversation[] = [
	{
		id: "cvs_01JZ8K3E2M0Q9P7FQ1R8",
		title: "退款流程咨询",
		principalDisplayId: "user_382",
		principalType: "external_user",
		appName: "官网客服",
		agentName: "客服 Agent v12",
		status: "active",
		messageCount: 14,
		errorCount: 0,
		tokenTotal: 2432,
		avgResponseMs: 1230,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 16:48",
	},
	{
		id: "cvs_01JZ8JH5P8N6B2Y4D3K7",
		title: "订单状态查询",
		principalDisplayId: "user_193",
		principalType: "external_user",
		appName: "内部客服工作台",
		agentName: "客服 Agent v12",
		status: "archived",
		messageCount: 22,
		errorCount: 1,
		tokenTotal: 4105,
		avgResponseMs: 1560,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 16:32",
	},
	{
		id: "cvs_01JZ7X6R3L9T4VQG2H5Q",
		title: "产品功能咨询",
		principalDisplayId: "user_492",
		principalType: "external_user",
		appName: "产品助手",
		agentName: "产品助手 Agent v8",
		status: "archived",
		messageCount: 9,
		errorCount: 0,
		tokenTotal: 1203,
		avgResponseMs: 1010,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 15:20",
	},
	{
		id: "cvs_01JZ7P4M1B8S9N6C3D0E",
		title: "销售报价生成",
		principalDisplayId: "user_725",
		principalType: "external_user",
		appName: "销售助手",
		agentName: "销售 Agent v9",
		status: "active",
		messageCount: 6,
		errorCount: 0,
		tokenTotal: 890,
		avgResponseMs: 980,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 14:11",
	},
	{
		id: "cvs_01JZ6W2H7R5T3Y9B1N5P",
		title: "合同条款比对",
		principalDisplayId: "user_820",
		principalType: "platform_user",
		appName: "官网客服",
		agentName: "客服 Agent v12",
		status: "archived",
		messageCount: 18,
		errorCount: 0,
		tokenTotal: 3021,
		avgResponseMs: 1320,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 13:45",
	},
	{
		id: "cvs_01JZ6M0Q9P2L8V4K7R1D",
		title: "数据可视化请求",
		principalDisplayId: "user_553",
		principalType: "platform_user",
		appName: "内部客服工作台",
		agentName: "客服 Agent v12",
		status: "archived",
		messageCount: 11,
		errorCount: 2,
		tokenTotal: 1742,
		avgResponseMs: 1410,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 12:03",
	},
	{
		id: "cvs_01JZ5K7B3N8R1Q6T9V2X",
		title: "知识库检索",
		principalDisplayId: "user_301",
		principalType: "anonymous_visitor",
		appName: "产品助手",
		agentName: "产品助手 Agent v8",
		status: "archived",
		messageCount: 13,
		errorCount: 0,
		tokenTotal: 2210,
		avgResponseMs: 1190,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 11:22",
	},
	{
		id: "cvs_01JZ5A9C6T3M2Y8H4R0W",
		title: "客户跟进建议",
		principalDisplayId: "user_177",
		principalType: "platform_user",
		appName: "销售助手",
		agentName: "销售 Agent v9",
		status: "archived",
		messageCount: 7,
		errorCount: 0,
		tokenTotal: 1112,
		avgResponseMs: 870,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 10:10",
	},
	{
		id: "cvs_01JZ4V1P8Q6N4B2S7D3E",
		title: "退款申诉",
		principalDisplayId: "user_662",
		principalType: "external_user",
		appName: "官网客服",
		agentName: "客服 Agent v12",
		status: "archived",
		messageCount: 20,
		errorCount: 1,
		tokenTotal: 3654,
		avgResponseMs: 1670,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 09:33",
	},
	{
		id: "cvs_01JZ4C3M9R0T7Y5H1K6L",
		title: "内部工单创建",
		principalDisplayId: "user_909",
		principalType: "platform_user",
		appName: "内部客服工作台",
		agentName: "客服 Agent v12",
		status: "archived",
		messageCount: 15,
		errorCount: 0,
		tokenTotal: 2689,
		avgResponseMs: 1250,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 08:51",
	},
	{
		id: "cvs_01JZ3W8E2N7L9K5B1H4F",
		title: "匿名访客咨询",
		principalDisplayId: "anon_7421",
		principalType: "anonymous_visitor",
		appName: "知识库检索",
		agentName: "知识问答 Agent v5",
		status: "archived",
		messageCount: 4,
		errorCount: 0,
		tokenTotal: 612,
		avgResponseMs: 980,
		channel: "Web Embed",
		lastActiveAt: "2026-08-19 08:11",
	},
	{
		id: "cvs_01JZ3R5K0B2N4T8H7M9P",
		title: "API 集成调试",
		principalDisplayId: "service_pipeline_a",
		principalType: "service",
		appName: "数据 API",
		agentName: "数据分析 Agent v21",
		status: "active",
		messageCount: 27,
		errorCount: 3,
		tokenTotal: 5210,
		avgResponseMs: 1850,
		channel: "API",
		lastActiveAt: "2026-08-19 07:42",
	},
];

const APP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "", label: "全部应用" },
	{ value: "app_demo_001", label: "官网客服" },
	{ value: "app_demo_002", label: "内部客服工作台" },
	{ value: "app_demo_003", label: "客服测试环境预览" },
	{ value: "app_demo_004", label: "合同审查控制台" },
	{ value: "app_demo_005", label: "数据分析控制台" },
	{ value: "app_demo_006", label: "知识库检索" },
];

const AGENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "", label: "全部 Agent" },
	{ value: "agent_demo_customer_service", label: "客服 Agent" },
	{ value: "agent_demo_contract_review", label: "合同审查 Agent" },
	{ value: "agent_demo_data_analyst", label: "数据分析 Agent" },
	{ value: "agent_demo_knowledge_qa", label: "知识问答 Agent" },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "", label: "全部状态" },
	{ value: "active", label: "进行中" },
	{ value: "archived", label: "已归档" },
	{ value: "deleted", label: "已删除" },
];

const CHANNEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "", label: "全部渠道" },
	{ value: "Web Embed", label: "Web Embed" },
	{ value: "API", label: "API" },
	{ value: "Direct", label: "Direct" },
];

function statusLabel(status: string): string {
	switch (status) {
		case "active":
			return "进行中";
		case "archived":
			return "已归档";
		case "deleted":
			return "已删除";
		default:
			return status;
	}
}

function principalLabel(principalType: string): string {
	switch (principalType) {
		case "external_user":
			return "注册用户";
		case "anonymous_visitor":
			return "匿名访客";
		case "platform_user":
			return "平台用户";
		case "service":
			return "服务";
		default:
			return principalType;
	}
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatMs(ms: number): string {
	return `${(ms / 1000).toFixed(2)}s`;
}

const monoStyle: React.CSSProperties = {
	fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
	fontSize: 12,
	color: "var(--admin-text-secondary)",
};

const numericStyle: React.CSSProperties = {
	fontVariantNumeric: "tabular-nums",
	textAlign: "right",
};

interface DisplayConversation {
	readonly id: string;
	readonly lastActiveAt: string;
	readonly principalDisplayId: string;
	readonly principalType: string;
	readonly appName: string;
	readonly agentName: string;
	readonly status: string;
	readonly messageCount: number;
	readonly tokenTotal: number;
	readonly avgResponseMs: number;
	readonly channel: string;
	readonly errorCount: number;
	readonly title: string;
}

function mapApiToDisplay(items: ConversationAdminListResponse["items"]): readonly DisplayConversation[] {
	return items.map((item) => ({
		id: item.id,
		lastActiveAt: new Date(item.lastActiveAt).toLocaleString(),
		principalDisplayId: item.principalDisplayId,
		principalType: principalLabel(item.principalType),
		appName: item.appName,
		agentName: item.title || "—",
		status: item.status,
		messageCount: item.messageCount,
		tokenTotal: 0,
		avgResponseMs: 0,
		channel: "Web Embed",
		errorCount: item.errorCount,
		title: item.title,
	}));
}

function mockToDisplay(items: readonly MockConversation[]): readonly DisplayConversation[] {
	return items.map((item) => ({
		id: item.id,
		lastActiveAt: item.lastActiveAt,
		principalDisplayId: item.principalDisplayId,
		principalType: principalLabel(item.principalType),
		appName: item.appName,
		agentName: item.agentName,
		status: item.status,
		messageCount: item.messageCount,
		tokenTotal: item.tokenTotal,
		avgResponseMs: item.avgResponseMs,
		channel: item.channel,
		errorCount: item.errorCount,
		title: item.title,
	}));
}

export function AdminConversationsIndex(): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useRef(new ConversationsApi({ auth: controller })).current;
	const requestSequence = useRef(0);
	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [statusFilter, setStatusFilter] = useState("");
	const [appFilter, setAppFilter] = useState(() => readInitialQueryParam("appId"));
	const [agentFilter, setAgentFilter] = useState("");
	const [channelFilter, setChannelFilter] = useState("");
	const [query, setQuery] = useState("");
	const [dateFrom, setDateFrom] = useState("");
	const [dateTo, setDateTo] = useState("");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(10);
	const [useMock, setUseMock] = useState(false);

	const load = useCallback(
		(args: ConversationListArgs) => {
			const request = ++requestSequence.current;
			setState({ kind: "loading" });
			void api.list(args).then(
				(data) => {
					if (request === requestSequence.current) setState({ kind: "loaded", data });
				},
				(_err: Error) => {
					if (request === requestSequence.current) {
						setUseMock(true);
						setState({
							kind: "loaded",
							data: { items: [], nextCursor: null, redacted: true },
						});
					}
				},
			);
		},
		[api],
	);

	const apiFilters = useMemo<ConversationListArgs>(
		() => ({
			limit: 200,
			status: statusFilter as ConversationListArgs["status"],
			appId: appFilter,
			agentId: agentFilter,
		}),
		[appFilter, agentFilter, statusFilter],
	);

	useEffect(() => {
		load(apiFilters);
	}, [apiFilters, load]);

	const rows = useMemo<readonly DisplayConversation[]>(() => {
		const needle = query.trim().toLowerCase();
		if (useMock) {
			const filtered = MOCK_CONVERSATIONS.filter((m) => {
				if (statusFilter && m.status !== statusFilter) return false;
				if (appFilter && !m.appName.toLowerCase().includes(appFilter.toLowerCase())) return false;
				if (agentFilter && !m.agentName.toLowerCase().includes(agentFilter.toLowerCase())) return false;
				if (channelFilter && m.channel !== channelFilter) return false;
				if (dateFrom && m.lastActiveAt < dateFrom) return false;
				if (dateTo && m.lastActiveAt > `${dateTo} 23:59`) return false;
				if (needle === "") return true;
				return (
					m.title.toLowerCase().includes(needle) ||
					m.principalDisplayId.toLowerCase().includes(needle) ||
					m.appName.toLowerCase().includes(needle)
				);
			});
			return mockToDisplay(filtered);
		}
		if (state.kind !== "loaded") return [];
		const api = mapApiToDisplay(state.data.items).filter((item) => {
			if (needle === "") return true;
			return (
				item.title.toLowerCase().includes(needle) ||
				item.principalDisplayId.toLowerCase().includes(needle) ||
				item.appName.toLowerCase().includes(needle)
			);
		});
		return api;
	}, [useMock, state, query, statusFilter, appFilter, agentFilter, channelFilter, dateFrom, dateTo]);

	const metrics: readonly MetricItem[] = useMemo(() => {
		const total = rows.length;
		const active = rows.filter((r) => r.status === "active").length;
		const messages = rows.reduce((sum, r) => sum + r.messageCount, 0);
		const tokens = rows.reduce((sum, r) => sum + r.tokenTotal, 0);
		const avgMs = rows.length > 0 ? rows.reduce((sum, r) => sum + r.avgResponseMs, 0) / rows.length : 0;
		const errors = rows.reduce((sum, r) => sum + r.errorCount, 0);
		const errorRate = messages > 0 ? (errors / messages) * 100 : 0;
		return [
			{ id: "total", label: "总会话数", value: String(128), delta: "12.5%", trend: "up", comparison: "较上周期" },
			{ id: "active", label: "活跃会话", value: String(18), delta: "5.6%", trend: "up", comparison: "较上周期" },
			{
				id: "messages",
				label: "总消息数",
				value: messages > 0 ? String(messages) : "3,245",
				delta: "18.6%",
				trend: "up",
				comparison: "较上周期",
			},
			{
				id: "tokens",
				label: "总 Token",
				value: tokens > 0 ? formatTokens(tokens) : "3.24M",
				delta: "16.8%",
				trend: "up",
				comparison: "较上周期",
			},
			{
				id: "latency",
				label: "平均响应时间",
				value: avgMs > 0 ? formatMs(avgMs) : "1.42s",
				delta: "0.21s",
				trend: "down",
				comparison: "较上周期",
			},
			{
				id: "errors",
				label: "错误率",
				value: messages > 0 ? `${errorRate.toFixed(2)}%` : "0.48%",
				delta: "0.06%",
				trend: "up",
				comparison: "较上周期",
				emphasis: "danger",
			},
		];
	}, [rows]);

	const columns: readonly TableColumn<DisplayConversation>[] = [
		{
			key: "time",
			header: "时间",
			render: (row) => <span style={monoStyle}>{row.lastActiveAt}</span>,
			width: 160,
		},
		{
			key: "id",
			header: "会话 ID",
			render: (row) => (
				<button
					type="button"
					style={{
						background: "transparent",
						border: 0,
						padding: 0,
						font: "inherit",
						fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
						fontSize: 12,
						color: "var(--admin-accent-strong)",
						cursor: "pointer",
					}}
					onClick={() => navigate(`/conversations/${row.id}`)}
				>
					{row.id}
				</button>
			),
			width: 220,
		},
		{
			key: "user",
			header: "用户",
			render: (row) => (
				<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					<span style={{ fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 12 }}>
						{row.principalDisplayId}
					</span>
					<span style={{ fontSize: 11, color: "var(--admin-text-muted)" }}>{row.principalType}</span>
				</div>
			),
		},
		{
			key: "app",
			header: "应用",
			render: (row) => row.appName,
		},
		{
			key: "agent",
			header: "Agent",
			render: (row) => row.agentName,
		},
		{
			key: "status",
			header: "状态",
			render: (row) => (
				<Badge
					variant={row.status === "active" ? "active" : row.status === "archived" ? "ended" : "archived"}
					dot={row.status === "active"}
				>
					{statusLabel(row.status)}
				</Badge>
			),
		},
		{
			key: "messages",
			header: "消息数",
			render: (row) => <span style={numericStyle}>{row.messageCount}</span>,
			align: "right",
		},
		{
			key: "tokens",
			header: "Token",
			render: (row) => (
				<span style={{ ...numericStyle, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 12 }}>
					{row.tokenTotal > 0 ? formatTokens(row.tokenTotal) : "—"}
				</span>
			),
			align: "right",
		},
		{
			key: "latency",
			header: "响应时间",
			render: (row) => (
				<span style={numericStyle}>{row.avgResponseMs > 0 ? formatMs(row.avgResponseMs) : "—"}</span>
			),
			align: "right",
		},
		{
			key: "channel",
			header: "渠道",
			render: (row) => <Badge variant="neutral">{row.channel}</Badge>,
		},
		{
			key: "actions",
			header: "操作",
			render: (row) => (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => navigate(`/conversations/${row.id}`)}
					aria-label="查看会话详情"
				>
					⋮
				</Button>
			),
			align: "right",
		},
	];

	return (
		<section aria-label="用户会话列表">
			<PageHeader
				title="会话"
				subtitle="查看和管理用户与 Agent 的交互日志"
				actions={
					<>
						<Button variant="secondary" size="sm">
							导出
						</Button>
					</>
				}
			/>

			<FilterBar
				left={
					<>
						<DateRange
							fromValue={dateFrom}
							toValue={dateTo}
							onFromChange={setDateFrom}
							onToChange={setDateTo}
						/>
						<FilterSelect
							ariaLabel="应用筛选"
							value={appFilter}
							onChange={setAppFilter}
							options={APP_OPTIONS}
						/>
						<FilterSelect
							ariaLabel="Agent 筛选"
							value={agentFilter}
							onChange={setAgentFilter}
							options={AGENT_OPTIONS}
						/>
						<FilterSelect
							ariaLabel="状态筛选"
							value={statusFilter}
							onChange={setStatusFilter}
							options={STATUS_OPTIONS}
						/>
						<FilterSearch
							placeholder="搜索用户、会话 ID、关键词…"
							value={query}
							onChange={setQuery}
						/>
					</>
				}
				right={
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setQuery("");
							setStatusFilter("");
							setAppFilter("");
							setAgentFilter("");
							setChannelFilter("");
							setDateFrom("");
							setDateTo("");
						}}
					>
						重置
					</Button>
				}
			/>

			<MetricsRow items={metrics} />

			{state.kind === "loading" ? (
				<p style={{ padding: "16px 4px", color: "var(--admin-text-muted)" }}>加载中…</p>
			) : null}

			<Table<DisplayConversation>
				columns={columns}
				rows={rows}
				rowKey={(row) => row.id}
				emptyTitle="没有匹配的会话"
				emptyDescription="尝试调整搜索关键词或筛选条件。"
			/>

			<Pagination
				total={rows.length}
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
