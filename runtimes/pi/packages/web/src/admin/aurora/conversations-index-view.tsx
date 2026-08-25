/**
 * 用户会话列表 — Aurora 视觉迁移（与 Agent List / Apps 共用同一 Design System）。
 *
 * 视觉：PageHeader + 工具行（SearchBox + chip 行） + AuroraMetricGrid（6 指标）
 * + PillTabs（按状态过滤） + 会话 SessionRow 列表 + Pagination。
 *
 * 数据：保留原 ConversationsApi 拉取链路 + mock fallback。过滤器（status /
 * app / agent / channel / date / query）的所有组合语义不变；只是把 11 列
 * 表格替换为紧凑的 SessionRow 形式（来自 direction-b-aurora 的 .session-row），
 * 保留用户、agent、对话预览、状态、token、响应时间等关键信息。
 */
import type { ConversationAdminListResponse } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConversationListArgs, ConversationsApi } from "../api/conversations-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import { readInitialQueryParam } from "../user-conversations/query-params.ts";
import styles from "./conversations-index-view.module.css";
import {
	AuroraButton,
	AuroraChip,
	AuroraPageHeader,
	AuroraPagination,
	AuroraPill,
	type AuroraPillTabItem,
	AuroraPillTabs,
	AuroraSearchBox,
	AuroraSessionRow,
} from "./index.ts";

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
		agentName: "客服 Agent",
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
		agentName: "客服 Agent",
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
		agentName: "产品助手 Agent",
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
		agentName: "销售 Agent",
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
		agentName: "客服 Agent",
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
		agentName: "客服 Agent",
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
		agentName: "产品助手 Agent",
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
		agentName: "销售 Agent",
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
		agentName: "客服 Agent",
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
		agentName: "客服 Agent",
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
		agentName: "知识问答 Agent",
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
		agentName: "数据分析 Agent",
		status: "active",
		messageCount: 27,
		errorCount: 3,
		tokenTotal: 5210,
		avgResponseMs: 1850,
		channel: "API",
		lastActiveAt: "2026-08-19 07:42",
	},
];

const CHANNEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "", label: "全部渠道" },
	{ value: "Web Embed", label: "Web Embed" },
	{ value: "API", label: "API" },
	{ value: "Direct", label: "Direct" },
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

type StatusTab = "all" | "active" | "archived" | "deleted";

const STATUS_LABEL: Record<StatusTab, string> = {
	all: "全部",
	active: "进行中",
	archived: "已归档",
	deleted: "已删除",
};

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

function formatRelativeTime(s: string): string {
	// 极简的"X 分钟前"显示，输入形如 "2026-08-19 16:48"。
	const date = new Date(s.replace(" ", "T"));
	if (Number.isNaN(date.getTime())) return s;
	const diff = Date.now() - date.getTime();
	const min = Math.round(diff / 60000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr} 小时前`;
	const day = Math.round(hr / 24);
	return `${day} 天前`;
}

interface DisplayConversation {
	readonly id: string;
	readonly lastActiveAt: string;
	readonly lastRelative: string;
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
	const now = Date.now();
	return items.map((item) => {
		const d = new Date(item.lastActiveAt);
		const diff = now - d.getTime();
		const min = Math.round(diff / 60000);
		const rel =
			Number.isNaN(d.getTime()) || diff < 0
				? item.lastActiveAt
				: min < 60
					? `${Math.max(0, min)} 分钟前`
					: `${Math.round(min / 60)} 小时前`;
		return {
			id: item.id,
			lastActiveAt: d.toLocaleString(),
			lastRelative: rel,
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
		};
	});
}

function mockToDisplay(items: readonly MockConversation[]): readonly DisplayConversation[] {
	return items.map((item) => ({
		id: item.id,
		lastActiveAt: item.lastActiveAt,
		lastRelative: formatRelativeTime(item.lastActiveAt),
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

function statusBadge(status: string): React.ReactNode {
	if (status === "active") return <AuroraPill tone="live">进行中</AuroraPill>;
	if (status === "archived") return <AuroraPill tone="neutral">已归档</AuroraPill>;
	return <AuroraPill tone="red">已删除</AuroraPill>;
}

export function AdminConversationsIndexView(): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useRef(new ConversationsApi({ auth: controller })).current;
	const requestSequence = useRef(0);
	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [statusTab, setStatusTab] = useState<StatusTab>("all");
	const [statusFilter, setStatusFilter] = useState("");
	const [appFilter, setAppFilter] = useState(() => readInitialQueryParam("appId"));
	const [agentFilter, setAgentFilter] = useState("");
	const [channelFilter, setChannelFilter] = useState("");
	const [query, setQuery] = useState("");
	const [dateFrom, setDateFrom] = useState("");
	const [dateTo, setDateTo] = useState("");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(8);
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
			limit: 100,
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
				if (statusTab !== "all" && m.status !== statusTab) return false;
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
		const apiRows = mapApiToDisplay(state.data.items).filter((item) => {
			if (statusTab !== "all" && item.status !== statusTab) return false;
			if (needle === "") return true;
			return (
				item.title.toLowerCase().includes(needle) ||
				item.principalDisplayId.toLowerCase().includes(needle) ||
				item.appName.toLowerCase().includes(needle)
			);
		});
		return apiRows;
	}, [useMock, state, query, statusTab, statusFilter, appFilter, agentFilter, channelFilter, dateFrom, dateTo]);

	// 分页
	const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
	const safePage = Math.min(page, totalPages);
	const pagedRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

	// PillTabs 按状态过滤
	const statusTabs: AuroraPillTabItem<StatusTab>[] = [
		{ value: "all", label: STATUS_LABEL.all },
		{ value: "active", label: STATUS_LABEL.active },
		{ value: "archived", label: STATUS_LABEL.archived },
		{ value: "deleted", label: STATUS_LABEL.deleted },
	];

	return (
		<section className={styles.shell} aria-label="用户会话列表">
			<AuroraPageHeader
				title="Session 日志"
				description="检索发布后企业用户产生的会话，并追溯固定版本、事件与错误。"
				meta={useMock ? "示例数据" : undefined}
				actions={
					<AuroraButton
						variant="default"
						size="md"
						onClick={() => {
							setQuery("");
							setStatusFilter("");
							setStatusTab("all");
							setAppFilter("");
							setAgentFilter("");
							setChannelFilter("");
							setDateFrom("");
							setDateTo("");
						}}
					>
						重置筛选
					</AuroraButton>
				}
			/>

			<div className={styles.toolbar}>
				<AuroraSearchBox value={query} onChange={setQuery} placeholder="搜索用户、会话 ID、关键词…" />
				<div className={styles.toolbarRight}>
					<select
						className={styles.select}
						value={appFilter}
						onChange={(e) => setAppFilter(e.currentTarget.value)}
						aria-label="应用筛选"
					>
						{APP_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
					<select
						className={styles.select}
						value={agentFilter}
						onChange={(e) => setAgentFilter(e.currentTarget.value)}
						aria-label="Agent 筛选"
					>
						{AGENT_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
					<select
						className={styles.select}
						value={channelFilter}
						onChange={(e) => setChannelFilter(e.currentTarget.value)}
						aria-label="渠道筛选"
					>
						{CHANNEL_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
					<input
						type="date"
						className={styles.date}
						value={dateFrom}
						onChange={(e) => setDateFrom(e.currentTarget.value)}
						aria-label="起始日期"
					/>
					<input
						type="date"
						className={styles.date}
						value={dateTo}
						onChange={(e) => setDateTo(e.currentTarget.value)}
						aria-label="结束日期"
					/>
				</div>
			</div>

			<div className={styles.tabRow}>
				<AuroraPillTabs<StatusTab>
					value={statusTab}
					onChange={setStatusTab}
					items={statusTabs}
					ariaLabel="按状态切换"
				/>
				<div className={styles.tabRight}>
					<AuroraChip active>视图：对话</AuroraChip>
					<AuroraChip>视图：表格</AuroraChip>
				</div>
			</div>

			{state.kind === "loading" && !useMock ? <p className={styles.loading}>加载中…</p> : null}

			{pagedRows.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>没有匹配的会话</div>
					<div className={styles.emptyDesc}>尝试调整搜索关键词或筛选条件。</div>
				</div>
			) : (
				<div className={styles.list}>
					{pagedRows.map((row) => (
						<AuroraSessionRow
							key={row.id}
							when={row.lastRelative}
							user={row.principalDisplayId}
							agentBadge={<AuroraPill tone="accent">{row.agentName}</AuroraPill>}
							channel={`via ${row.appName} · ${row.channel}`}
							statusBadge={statusBadge(row.status)}
							userPreview={`${row.title}（${row.principalType}）`}
							agentPreview={summarizeAgentReply(row)}
							meta={
								<>
									<span>{row.messageCount} 轮</span>
									<span>{row.tokenTotal > 0 ? formatTokens(row.tokenTotal) : "—"} token</span>
									<span>{row.avgResponseMs > 0 ? formatMs(row.avgResponseMs) : "—"} 响应</span>
									{row.errorCount > 0 ? (
										<span style={{ color: "var(--aurora-red)" }}>{row.errorCount} 次错误</span>
									) : null}
								</>
							}
							onClick={() => navigate(`/conversations/${row.id}`)}
							ariaLabel={`打开会话 ${row.id}`}
						/>
					))}
				</div>
			)}

			<footer className={styles.footer}>
				<div className={styles.totalCount}>
					共 <strong>{rows.length}</strong> 条会话
				</div>
				<AuroraPagination
					page={safePage}
					totalPages={totalPages}
					pageSize={pageSize}
					pageSizeOptions={[8, 12, 24, 48]}
					onPageChange={setPage}
					onPageSizeChange={(s) => {
						setPageSize(s);
						setPage(1);
					}}
				/>
			</footer>
		</section>
	);
}

function summarizeAgentReply(row: DisplayConversation): string {
	// 把核心数字拼成一句模拟回复，避免单纯"agent: …"过空。
	if (row.status === "deleted") return "[会话已删除]";
	if (row.status === "archived") {
		return `已结算 · ${row.messageCount} 轮 · ${row.tokenTotal > 0 ? formatTokens(row.tokenTotal) : "—"} token`;
	}
	return `响应中 · 当前 ${row.messageCount} 轮 · 平均 ${row.avgResponseMs > 0 ? formatMs(row.avgResponseMs) : "—"}`;
}
