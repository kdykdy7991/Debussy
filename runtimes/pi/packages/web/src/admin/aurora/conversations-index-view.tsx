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
import { AuroraPagination } from "./index.ts";

type ListState =
	| { kind: "loading" }
	| { kind: "loaded"; data: ConversationAdminListResponse }
	| { kind: "error"; message: string };

/**
 * 时间范围：起止日期常驻 + 右侧快捷预设（Grafana / CloudWatch 的常见组合）。
 *
 * 默认落在「近 30 天」而不是空区间：原生 input[type=date] 空值时会显示
 * yyyy/mm/dd 占位，对使用者不友好；给一个默认区间即可避开。
 */
type RangePreset = "all" | "today" | "7d" | "30d" | "90d" | "custom";

const DEFAULT_RANGE: "today" | "7d" | "30d" | "90d" = "30d";

const RANGE_PRESETS: readonly { readonly value: RangePreset; readonly label: string }[] = [
	{ value: "today", label: "今天" },
	{ value: "7d", label: "近 7 天" },
	{ value: "30d", label: "近 30 天" },
	{ value: "90d", label: "近 90 天" },
	{ value: "all", label: "不限" },
];

function toDateValue(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function presetRange(preset: "today" | "7d" | "30d" | "90d"): { readonly from: string; readonly to: string } {
	const to = new Date();
	const from = new Date();
	if (preset === "7d") from.setDate(from.getDate() - 6);
	if (preset === "90d") from.setDate(from.getDate() - 89);
	if (preset === "30d") from.setDate(from.getDate() - 29);
	return { from: toDateValue(from), to: toDateValue(to) };
}

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

const STATUS_TAB_OPTIONS: ReadonlyArray<{ value: string; label: string }> = (
	Object.entries(STATUS_LABEL) as [StatusTab, string][]
).map(([value, label]) => ({ value, label: label === "全部" ? "全部状态" : label }));

type SelectOption = { readonly value: string; readonly label: string };

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
	if (status === "active") return <span className={`${styles.status} ${styles.statusActive}`}>进行中</span>;
	if (status === "archived") return <span className={styles.status}>已结束</span>;
	if (status === "deleted") return <span className={`${styles.status} ${styles.statusFailed}`}>已删除</span>;
	return <span className={`${styles.status} ${styles.statusFailed}`}>未知</span>;
}

export function AdminConversationsIndexView(): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useRef(new ConversationsApi({ auth: controller })).current;
	const requestSequence = useRef(0);
	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [statusTab, setStatusTab] = useState<StatusTab>("all");
	const [appFilter, setAppFilter] = useState(() => readInitialQueryParam("appId"));
	const [agentFilter, setAgentFilter] = useState("");
	const [query, setQuery] = useState("");
	const [rangePreset, setRangePreset] = useState<RangePreset>(DEFAULT_RANGE);
	const [dateFrom, setDateFrom] = useState(() => presetRange(DEFAULT_RANGE).from);
	const [dateTo, setDateTo] = useState(() => presetRange(DEFAULT_RANGE).to);
	const [rangeOpen, setRangeOpen] = useState(false);
	const [draftFrom, setDraftFrom] = useState(() => presetRange(DEFAULT_RANGE).from);
	const [draftTo, setDraftTo] = useState(() => presetRange(DEFAULT_RANGE).to);
	const rangeRef = useRef<HTMLDivElement | null>(null);
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(20);
	const [useMock, setUseMock] = useState(false);
	const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null);

	const load = useCallback(
		(args: ConversationListArgs) => {
			const request = ++requestSequence.current;
			setState({ kind: "loading" });
			void api.list(args).then(
				(data) => {
					if (request === requestSequence.current) setState({ kind: "loaded", data });
				},
				(error: Error) => {
					if (request === requestSequence.current) {
						setUseMock(true);
						setState({ kind: "error", message: error.message });
					}
				},
			);
		},
		[api],
	);

	const apiFilters = useMemo<ConversationListArgs>(
		() => ({
			limit: 100,
			status: statusTab === "all" ? undefined : statusTab,
			appId: appFilter,
			agentId: agentFilter,
		}),
		[appFilter, agentFilter, statusTab],
	);

	// 选预设 = 把起止输入填成对应区间；手动改日期则自动降级为「自定义」
	const applyRangePreset = useCallback((next: RangePreset): void => {
		setRangePreset(next);
		if (next === "custom") return;
		if (next === "all") {
			setDateFrom("");
			setDateTo("");
			return;
		}
		const range = presetRange(next);
		setDateFrom(range.from);
		setDateTo(range.to);
	}, []);

	const rangeHint = useMemo(() => {
		if (dateFrom === "" && dateTo === "") return undefined;
		const crossYear = dateFrom.slice(0, 4) !== dateTo.slice(0, 4);
		const short = (value: string): string => (value === "" || crossYear ? value : value.slice(5));
		if (dateFrom !== "" && dateTo !== "") {
			return dateFrom === dateTo ? short(dateFrom) : `${short(dateFrom)} ~ ${short(dateTo)}`;
		}
		return dateFrom !== "" ? `≥ ${short(dateFrom)}` : `≤ ${short(dateTo)}`;
	}, [dateFrom, dateTo]);

	// 触发按钮只显示摘要；区间详情收进弹出面板，避免工具条被撑到换行
	const rangeSummary = useMemo(() => {
		if (rangePreset === "all") return "不限";
		if (rangePreset === "custom") return rangeHint ?? "自定义";
		return RANGE_PRESETS.find((option) => option.value === rangePreset)?.label ?? "近 30 天";
	}, [rangePreset, rangeHint]);

	const toggleRangePanel = useCallback((): void => {
		setRangeOpen((open) => {
			if (!open) {
				setDraftFrom(dateFrom);
				setDraftTo(dateTo);
			}
			return !open;
		});
	}, [dateFrom, dateTo]);

	const commitCustomRange = useCallback((): void => {
		setDateFrom(draftFrom);
		setDateTo(draftTo);
		setRangePreset(draftFrom === "" && draftTo === "" ? "all" : "custom");
		setRangeOpen(false);
	}, [draftFrom, draftTo]);

	useEffect(() => {
		if (!rangeOpen) return;
		const onPointerDown = (event: MouseEvent): void => {
			const node = rangeRef.current;
			if (node !== null && !node.contains(event.target as Node)) setRangeOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setRangeOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [rangeOpen]);

	useEffect(() => {
		load(apiFilters);
	}, [apiFilters, load]);

	const rows = useMemo<readonly DisplayConversation[]>(() => {
		const source = useMock
			? mockToDisplay(MOCK_CONVERSATIONS)
			: state.kind === "loaded"
				? mapApiToDisplay(state.data.items)
				: [];
		const needle = query.trim().toLowerCase();
		return source.filter((item) => {
			if (statusTab !== "all" && item.status !== statusTab) return false;
			if (dateFrom && item.lastActiveAt < dateFrom) return false;
			if (dateTo && item.lastActiveAt > `${dateTo} 23:59`) return false;
			return (
				needle === "" ||
				item.id.toLowerCase().includes(needle) ||
				item.title.toLowerCase().includes(needle) ||
				item.principalDisplayId.toLowerCase().includes(needle) ||
				item.appName.toLowerCase().includes(needle)
			);
		});
	}, [useMock, state, query, statusTab, dateFrom, dateTo]);

	const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
	const safePage = Math.min(page, totalPages);
	const pagedRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
	const updateLifecycle = async (row: DisplayConversation) => {
		if (useMock || row.status === "deleted") return;
		const archive = row.status === "active";
		if (!window.confirm(archive ? "确定结束这条会话吗？" : "确定软删除这条会话吗？审计记录仍会保留。")) return;
		setLifecycleBusy(row.id);
		try {
			if (archive) await api.archive(row.id);
			else await api.delete(row.id);
			load(apiFilters);
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
		} finally {
			setLifecycleBusy(null);
		}
	};

	return (
		<section className={styles.shell} aria-label="用户会话列表">
			<header className={styles.header}>
				<div>
					<h1>Session 日志</h1>
				</div>
				<button type="button" className={styles.refresh} onClick={() => load(apiFilters)}>
					<Icon name="refresh" />
					刷新
				</button>
			</header>

			<div className={styles.toolbar}>
				<label className={styles.search}>
					<Icon name="search" />
					<input
						value={query}
						onChange={(e) => setQuery(e.currentTarget.value)}
						placeholder="搜索会话 ID、用户标识或会话内容"
					/>
					<kbd>/</kbd>
				</label>
				<SelectMenu label="应用筛选" value={appFilter} options={APP_OPTIONS} onChange={setAppFilter} />
				<SelectMenu label="Agent 筛选" value={agentFilter} options={AGENT_OPTIONS} onChange={setAgentFilter} />
				<SelectMenu
					label="状态筛选"
					value={statusTab}
					options={STATUS_TAB_OPTIONS}
					onChange={(next) => setStatusTab(next as StatusTab)}
				/>
				<div className={styles.filterField}>
					<div className={styles.rangePicker} ref={rangeRef}>
						<button
							type="button"
							className={styles.rangeTrigger}
							onClick={() => toggleRangePanel()}
							aria-haspopup="dialog"
							aria-expanded={rangeOpen}
						>
							<Icon name="calendar" />
							<span>{rangeSummary}</span>
						</button>
						{rangeOpen ? (
							<div className={styles.rangePanel} role="dialog" aria-label="选择时间范围">
								<div className={styles.rangePresets}>
									{RANGE_PRESETS.map((option) => (
										<button
											key={option.value}
											type="button"
											className={rangePreset === option.value ? "is-active" : ""}
											onClick={() => {
												applyRangePreset(option.value);
												setRangeOpen(false);
											}}
										>
											{option.label}
										</button>
									))}
								</div>
								<div className={styles.rangeCustom}>
									<span>自定义区间</span>
									<div className={styles.rangeInputs}>
										<input
											type="date"
											value={draftFrom}
											onChange={(e) => setDraftFrom(e.currentTarget.value)}
											aria-label="开始日期"
										/>
										<i>→</i>
										<input
											type="date"
											value={draftTo}
											onChange={(e) => setDraftTo(e.currentTarget.value)}
											aria-label="结束日期"
										/>
									</div>
									<div className={styles.rangeActions}>
										<button
											type="button"
											className={styles.rangeGhost}
											onClick={() => setRangeOpen(false)}
										>
											取消
										</button>
										<button type="button" className={styles.rangeApply} onClick={commitCustomRange}>
											应用
										</button>
									</div>
								</div>
							</div>
						) : null}
					</div>
				</div>
			</div>

			<div className={styles.count}>
				共 <strong>{rows.length.toLocaleString()}</strong> 条会话{useMock ? <span>示例数据</span> : null}
			</div>
			{state.kind === "loading" ? <p className={styles.loading}>加载中…</p> : null}
			{state.kind !== "loading" && pagedRows.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>没有匹配的会话</div>
					<div className={styles.emptyDesc}>尝试调整搜索关键词或筛选条件。</div>
				</div>
			) : null}
			{state.kind !== "loading" && pagedRows.length > 0 ? (
				<div className={styles.tableWrap}>
					<table>
						<thead>
							<tr>
								<th>会话 ID</th>
								<th>用户标识</th>
								<th>应用</th>
								<th>Agent</th>
								<th>状态</th>
								<th>消息数</th>
								<th>最后活跃时间</th>
								<th>错误</th>
								<th aria-label="操作" />
							</tr>
						</thead>
						<tbody>
							{pagedRows.map((row) => (
								<tr key={row.id} onClick={() => navigate(`/conversations/${row.id}`)}>
									<td className={styles.sessionId}>
										{row.id}
										<span>»</span>
									</td>
									<td>{row.principalDisplayId}</td>
									<td>{row.appName}</td>
									<td>{row.agentName}</td>
									<td>{statusBadge(row.status)}</td>
									<td>{row.messageCount}</td>
									<td>{row.lastActiveAt}</td>
									<td>
										{row.errorCount > 0 ? (
											<span className={styles.errorIcon} title={`${row.errorCount} 次错误`}>
												<Icon name="warning" />
											</span>
										) : (
											"-"
										)}
									</td>
									<td className={styles.chevron}>
										{row.status !== "deleted" ? (
											<button
												type="button"
												disabled={useMock || lifecycleBusy !== null}
												onClick={(event) => {
													event.stopPropagation();
													void updateLifecycle(row);
												}}
											>
												{lifecycleBusy === row.id ? "处理中" : row.status === "active" ? "结束" : "删除"}
											</button>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}

			<footer className={styles.footer}>
				<div />
				<AuroraPagination
					page={safePage}
					totalPages={totalPages}
					pageSize={pageSize}
					pageSizeOptions={[10, 20, 50, 100]}
					onPageChange={setPage}
					onPageSizeChange={(size) => {
						setPageSize(size);
						setPage(1);
					}}
				/>
			</footer>
		</section>
	);
}

/**
 * 自绘下拉菜单。
 *
 * 不用原生 select：它的宽度按「最长的 option」计算，而当前选中项往往很短，
 * 于是文字与箭头之间会出现大片空白（原生 select 无法跟随当前值收缩）。
 */
function SelectMenu({
	label,
	value,
	options,
	onChange,
}: {
	readonly label: string;
	readonly value: string;
	readonly options: readonly SelectOption[];
	readonly onChange: (value: string) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent): void => {
			const node = ref.current;
			if (node !== null && !node.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const current = options.find((option) => option.value === value);
	return (
		<div className={styles.selectMenu} ref={ref}>
			<button
				type="button"
				className={styles.selectTrigger}
				onClick={() => setOpen((prev) => !prev)}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={label}
			>
				<span>{current?.label ?? value}</span>
				<Icon name="chevronDown" />
			</button>
			{open ? (
				<div className={styles.selectPanel} role="listbox" aria-label={label}>
					{options.map((option) => (
						<button
							key={option.value}
							type="button"
							role="option"
							aria-selected={option.value === value}
							className={option.value === value ? "is-active" : ""}
							onClick={() => {
								onChange(option.value);
								setOpen(false);
							}}
						>
							{option.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

function Icon({
	name,
}: {
	name: "search" | "calendar" | "refresh" | "warning" | "chevron" | "chevronDown";
}): React.ReactElement {
	const paths = {
		search: (
			<>
				<circle cx="11" cy="11" r="7" />
				<path d="m20 20-4-4" />
			</>
		),
		calendar: (
			<>
				<rect x="3" y="5" width="18" height="16" rx="2" />
				<path d="M16 3v4M8 3v4M3 10h18" />
			</>
		),
		refresh: (
			<>
				<path d="M20 11a8 8 0 1 0-2.34 5.66" />
				<path d="M20 5v6h-6" />
			</>
		),
		warning: (
			<>
				<path d="M10.3 3.8 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" />
				<path d="M12 9v4M12 17h.01" />
			</>
		),
		chevron: <path d="m9 18 6-6-6-6" />,
		chevronDown: <path d="m6 9 6 6 6-6" />,
	};
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			{paths[name]}
		</svg>
	);
}
