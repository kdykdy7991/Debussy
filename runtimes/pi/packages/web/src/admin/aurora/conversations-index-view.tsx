/**
 * Session 日志 — 管理端会话列表页。
 *
 * 数据全部来自 `GET /api/control/v1/conversations`：服务端按 last_active_at
 * 倒序、cursor 分页，并承担搜索与筛选。页面不做前端全集过滤，也不回退到
 * 示例数据；失败时展示错误与重试。
 *
 * `status` 表示会话生命周期，`executionState` 来自 Run 或最近 Turn 的事件。
 */
import type { ConversationAdminSummary } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConversationListArgs, ConversationsApi } from "../api/conversations-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { beijingBoundary, beijingDate, beijingDay, formatBeijing } from "../beijing-time.ts";
import { useDialogs } from "../components/use-dialogs.tsx";
import { WORK_STATUS } from "../pages/orchestration-ui.ts";
import { navigate } from "../router.ts";
import { readInitialQueryParam } from "../user-conversations/query-params.ts";
import styles from "./conversations-index-view.module.css";
import { AuroraSearchBox } from "./index.ts";
import {
	compactSessionId,
	type SessionLifecycleTone,
	sessionLifecycleView,
	sessionOriginLabel,
	shortAgentLabel,
	summarizeSessionPage,
} from "./session-list-model.ts";

type ListState =
	| { kind: "loading" }
	| {
			kind: "loaded";
			data: { readonly items: readonly ConversationAdminSummary[]; readonly nextCursor: string | null };
	  }
	| { kind: "error"; message: string };

type RangePreset = "all" | "today" | "7d" | "30d" | "90d" | "custom";

const RANGE_PRESETS: readonly { readonly value: RangePreset; readonly label: string }[] = [
	{ value: "today", label: "今天" },
	{ value: "7d", label: "近 7 天" },
	{ value: "30d", label: "近 30 天" },
	{ value: "90d", label: "近 90 天" },
	{ value: "all", label: "不限" },
];

type StatusTab = "all" | "active" | "archived" | "deleted";
type OriginTab = "all" | "chat" | "integration" | "aaas_key";

const STATUS_TAB_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
	{ value: "all", label: "全部状态" },
	{ value: "active", label: "未关闭" },
	{ value: "archived", label: "已归档" },
	{ value: "deleted", label: "已删除" },
];

const ORIGIN_TAB_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
	{ value: "all", label: "全部来源" },
	{ value: "integration", label: "Integration" },
	{ value: "aaas_key", label: "AaaS Key" },
	{ value: "chat", label: "Chat" },
];

const PUBLIC_ID_PATTERN: Record<"app" | "agent", RegExp> = {
	app: /^app_[0-9a-fA-F-]{36}$/,
	agent: /^agent_[0-9a-fA-F-]{36}$/,
};

function toDateValue(date: Date): string {
	return beijingDay(date);
}

function presetRange(preset: Exclude<RangePreset, "all" | "custom">): { readonly from: string; readonly to: string } {
	const to = new Date();
	const from = new Date();
	if (preset === "today") return { from: toDateValue(to), to: toDateValue(to) };
	if (preset === "7d") from.setTime(from.getTime() - 6 * 86400000);
	if (preset === "90d") from.setTime(from.getTime() - 89 * 86400000);
	if (preset === "30d") from.setTime(from.getTime() - 29 * 86400000);
	return { from: toDateValue(from), to: toDateValue(to) };
}

/** Date inputs are Beijing calendar dates; API bounds remain UTC instants. */
function toIsoBoundary(date: string, endOfDay: boolean): string | undefined {
	return beijingBoundary(date, endOfDay);
}

function formatTimestamp(iso: string): string {
	return formatBeijing(iso);
}

function formatShortTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const local = beijingDate(date);
	const month = String(local.getUTCMonth() + 1).padStart(2, "0");
	const day = String(local.getUTCDate()).padStart(2, "0");
	const hour = String(local.getUTCHours()).padStart(2, "0");
	const minute = String(local.getUTCMinutes()).padStart(2, "0");
	return `${month}/${day} ${hour}:${minute}`;
}

function relativeTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const diff = Date.now() - date.getTime();
	if (diff < 60_000) return "刚刚";
	const min = Math.floor(diff / 60_000);
	if (min < 60) return `${min} 分钟前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr} 小时前`;
	const day = Math.floor(hr / 24);
	return day < 30 ? `${day} 天前` : "";
}

function lifecycleClass(tone: SessionLifecycleTone): string {
	if (tone === "open") return styles.statusOpen;
	if (tone === "archived") return styles.statusArchived;
	if (tone === "deleted") return styles.statusDeleted;
	return styles.statusUnknown;
}

function statusBadge(status: string): React.ReactNode {
	const view = sessionLifecycleView(status);
	return (
		<span className={`${styles.status} ${lifecycleClass(view.tone)}`} title={view.hint}>
			<i aria-hidden="true" />
			{view.label}
		</span>
	);
}

export function AdminConversationsIndexView({
	source,
	navigation,
}: { source?: "chat" | "aaas_key"; navigation?: React.ReactNode } = {}): React.ReactElement {
	const { dialog, ...dialogs } = useDialogs();
	const { controller } = useAdminAuth();
	const api = useRef(new ConversationsApi({ auth: controller })).current;
	const requestSequence = useRef(0);
	const copyTimer = useRef<number | null>(null);
	const actionMenuRef = useRef<HTMLDivElement | null>(null);

	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [statusTab, setStatusTab] = useState<StatusTab>("all");
	const [originTab, setOriginTab] = useState<OriginTab>("all");
	const [executionState, setExecutionState] = useState("");
	const [appFilter, setAppFilter] = useState(() => readInitialQueryParam("appId"));
	const [agentFilter, setAgentFilter] = useState("");
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [rangePreset, setRangePreset] = useState<RangePreset>("all");
	const [dateFrom, setDateFrom] = useState("");
	const [dateTo, setDateTo] = useState("");
	const [rangeOpen, setRangeOpen] = useState(false);
	const [draftFrom, setDraftFrom] = useState("");
	const [draftTo, setDraftTo] = useState("");
	const rangeRef = useRef<HTMLDivElement | null>(null);
	const [pageSize, setPageSize] = useState(10);
	const [cursorStack, setCursorStack] = useState<readonly (string | null)[]>([null]);
	const [pageIndex, setPageIndex] = useState(0);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null);
	const [openMenuId, setOpenMenuId] = useState<string | null>(null);

	useEffect(
		() => () => {
			if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
		},
		[],
	);

	const resetPaging = useCallback((): void => {
		setCursorStack((prev) => (prev.length === 1 && prev[0] === null ? prev : [null]));
		setPageIndex((prev) => (prev === 0 ? prev : 0));
	}, []);

	// Search is applied on the server after a short pause; stale responses are
	// dropped by requestSequence in load().
	useEffect(() => {
		const trimmed = query.trim();
		const timer = window.setTimeout(() => {
			setSearch(trimmed);
			resetPaging();
		}, 300);
		return () => window.clearTimeout(timer);
	}, [query, resetPaging]);

	const load = useCallback(
		(args: ConversationListArgs) => {
			const request = ++requestSequence.current;
			setState({ kind: "loading" });
			setOpenMenuId(null);
			void api.list(args).then(
				(data) => {
					if (request === requestSequence.current) {
						setState({
							kind: "loaded",
							data: { items: data.items, nextCursor: data.nextCursor },
						});
					}
				},
				(error: Error) => {
					if (request === requestSequence.current) setState({ kind: "error", message: error.message });
				},
			);
		},
		[api],
	);

	const appId = appFilter.trim();
	const agentId = agentFilter.trim();
	const appIdValid = appId === "" || PUBLIC_ID_PATTERN.app.test(appId);
	const agentIdValid = agentId === "" || PUBLIC_ID_PATTERN.agent.test(agentId);
	const cursor = cursorStack[pageIndex] ?? null;

	const apiFilters = useMemo<ConversationListArgs>(
		() => ({
			limit: pageSize,
			cursor: cursor ?? undefined,
			status: statusTab === "all" ? undefined : statusTab,
			origin: source ?? (originTab === "all" ? undefined : originTab),
			executionState: executionState || undefined,
			appId: appIdValid ? appId : undefined,
			agentId: agentIdValid ? agentId : undefined,
			search,
			lastActiveAfter: toIsoBoundary(dateFrom, false),
			lastActiveBefore: toIsoBoundary(dateTo, true),
		}),
		[pageSize, cursor, statusTab, originTab, source, executionState, appId, agentId, appIdValid, agentIdValid, search, dateFrom, dateTo],
	);

	useEffect(() => {
		// An incomplete public id is only a local draft: do not send an
		// invalid request on every keystroke.
		if (!appIdValid || !agentIdValid) return;
		load(apiFilters);
	}, [apiFilters, appIdValid, agentIdValid, load]);

	const applyRangePreset = useCallback(
		(next: RangePreset): void => {
			setRangePreset(next);
			resetPaging();
			if (next === "custom") return;
			if (next === "all") {
				setDateFrom("");
				setDateTo("");
				return;
			}
			const range = presetRange(next);
			setDateFrom(range.from);
			setDateTo(range.to);
		},
		[resetPaging],
	);

	const rangeHint = useMemo(() => {
		if (dateFrom === "" && dateTo === "") return undefined;
		const crossYear = dateFrom.slice(0, 4) !== dateTo.slice(0, 4);
		const short = (value: string): string => (value === "" || crossYear ? value : value.slice(5));
		if (dateFrom !== "" && dateTo !== "") {
			return dateFrom === dateTo ? short(dateFrom) : `${short(dateFrom)} ~ ${short(dateTo)}`;
		}
		return dateFrom !== "" ? `≥ ${short(dateFrom)}` : `≤ ${short(dateTo)}`;
	}, [dateFrom, dateTo]);

	const rangeSummary = useMemo(() => {
		if (rangePreset === "all") return "不限";
		if (rangePreset === "custom") return rangeHint ?? "自定义";
		return RANGE_PRESETS.find((option) => option.value === rangePreset)?.label ?? "不限";
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
		resetPaging();
		setRangeOpen(false);
	}, [draftFrom, draftTo, resetPaging]);

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
		if (openMenuId === null) return;
		const onPointerDown = (event: MouseEvent): void => {
			const node = actionMenuRef.current;
			if (node !== null && !node.contains(event.target as Node)) setOpenMenuId(null);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpenMenuId(null);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openMenuId]);

	const items = state.kind === "loaded" ? state.data.items : [];
	const nextCursor = state.kind === "loaded" ? state.data.nextCursor : null;
	const overview = useMemo(() => summarizeSessionPage(items), [items]);
	const latest = overview.latest;
	const latestActivity =
		latest === null ? "—" : relativeTime(latest.lastActiveAt) || formatShortTimestamp(latest.lastActiveAt);
	const hasFilters =
		search !== "" ||
		statusTab !== "all" ||
		executionState !== "" ||
		originTab !== "all" ||
		appId !== "" ||
		agentId !== "" ||
		dateFrom !== "" ||
		dateTo !== "";

	const clearFilters = (): void => {
		setQuery("");
		setSearch("");
		setStatusTab("all");
		setExecutionState("");
		setOriginTab("all");
		setAppFilter("");
		setAgentFilter("");
		setRangePreset("all");
		setDateFrom("");
		setDateTo("");
		resetPaging();
	};

	const openDetail = (id: string): void => navigate(`/conversations/${id}`);

	const goNext = (): void => {
		if (nextCursor === null || nextCursor === "") return;
		setCursorStack((prev) => [...prev.slice(0, pageIndex + 1), nextCursor]);
		setPageIndex(pageIndex + 1);
	};
	const goPrev = (): void => setPageIndex((prev) => Math.max(0, prev - 1));

	const copyId = async (id: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(id);
			setCopiedId(id);
			if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
			copyTimer.current = window.setTimeout(() => setCopiedId(null), 1600);
		} catch {
			await dialogs.alert("复制失败，请手动选择 Session ID。");
		}
	};

	const updateLifecycle = async (row: ConversationAdminSummary): Promise<void> => {
		if (row.status === "deleted") return;
		const archive = row.status === "active";
		const message = archive
			? "归档后会话不再接受新消息；该操作不会中止正在执行的任务。确定归档吗？"
			: "删除后会话将从列表移除（软删除），审计记录仍保留。确定删除吗？";
		if (
			!(await dialogs.confirm(message, {
				title: archive ? "归档会话" : "删除会话",
				confirmLabel: archive ? "确认归档" : "确认删除",
				destructive: true,
			}))
		)
			return;
		setLifecycleBusy(row.id);
		try {
			if (archive) await api.archive(row.id);
			else await api.delete(row.id);
			load(apiFilters);
		} catch (error) {
			await dialogs.alert(error instanceof Error ? error.message : String(error));
		} finally {
			setLifecycleBusy(null);
		}
	};

	const metricValue = (value: number): React.ReactNode => (state.kind === "loading" ? "—" : value);

	return (
		<section className={styles.shell} aria-label="执行记录">
			{dialog}
			{navigation && <div className={styles.sourceNav}>{navigation}</div>}
			<header className={styles.header}>
				<div className={styles.titleBlock}>
					<h1>执行记录</h1>
					<p className={styles.subtitle}>{source === "aaas_key" ? "旧 AaaS Run 与关联会话" : "查看会话状态、任务摘要与最近活动"}</p>
				</div>
			</header>

			<section className={styles.overview} aria-label="当前页 Session 概览">
				<article className={`${styles.metricCard} ${styles.metricPrimary}`}>
					<p className={styles.metricLabel}>当前页未关闭</p>
					<div className={styles.metricValue}>{metricValue(overview.openCount)}</div>
					<p className={styles.metricHint}>会话生命周期状态 · 仅当前页</p>
				</article>
				<article className={styles.metricCard}>
					<p className={styles.metricLabel}>今日新增</p>
					<div className={styles.metricValue}>{metricValue(overview.createdTodayCount)}</div>
					<p className={styles.metricHint}>按创建时间统计 · 仅当前页</p>
				</article>
				<article className={styles.metricCard}>
					<p className={styles.metricLabel}>异常会话</p>
					<div className={styles.metricValue}>{metricValue(overview.withErrorsCount)}</div>
					<p className={styles.metricHint}>存在错误事件 · 非运行结果</p>
				</article>
				<article className={styles.metricCard}>
					<p className={styles.metricLabel}>最近活动</p>
					<div className={`${styles.metricValue} ${styles.metricValueText}`}>{latestActivity}</div>
					<p className={styles.metricHint} title={latest?.appName}>
						{latest === null
							? "暂无可展示记录"
							: `${latest.appName || "未命名应用"} · ${shortAgentLabel(latest)}`}
					</p>
				</article>
				<article className={styles.noticeCard}>
					<p className={styles.noticeTitle}>阅读提示</p>
					<p>{source === "aaas_key" ? "Run 状态与会话生命周期独立记录。" : "最近一轮状态来自已记录的执行事件。"}</p>
					<p>错误事件计数来自列表 API；查看轨迹与用量请进入详情。</p>
				</article>
			</section>

			<div className={styles.filterBar}>
				<div className={styles.searchField}>
					<AuroraSearchBox
						value={query}
						onChange={setQuery}
						placeholder={source === "aaas_key" ? "搜索 Run、Key、Session ID 或任务摘要" : "搜索 Session ID、任务摘要、应用或用户标识"}
					/>
				</div>
				<label className={styles.filterInput}>
					<span>应用 ID</span>
					<input
						value={appFilter}
						onChange={(e) => {
							setAppFilter(e.currentTarget.value);
							resetPaging();
						}}
						placeholder="全部应用"
						aria-label="应用 ID 筛选"
						aria-invalid={!appIdValid}
						title={appIdValid ? undefined : "应用 ID 格式为 app_<uuid>"}
					/>
				</label>
				<label className={styles.filterInput}>
					<span>Agent ID</span>
					<input
						value={agentFilter}
						onChange={(e) => {
							setAgentFilter(e.currentTarget.value);
							resetPaging();
						}}
						placeholder="全部 Agent"
						aria-label="Agent ID 筛选"
						aria-invalid={!agentIdValid}
						title={agentIdValid ? undefined : "Agent ID 格式为 agent_<uuid>"}
					/>
				</label>
				<SelectMenu
					label="状态筛选"
					caption="状态"
					value={statusTab}
					options={STATUS_TAB_OPTIONS}
					onChange={(next) => {
						setStatusTab(next as StatusTab);
						resetPaging();
					}}
				/>
				{source && <SelectMenu
					label={source === "aaas_key" ? "Run 状态筛选" : "最近一轮状态筛选"}
					caption={source === "aaas_key" ? "Run 状态" : "最近一轮状态"}
					value={executionState}
					options={[{ value: "", label: "全部执行状态" }, ...Object.entries(WORK_STATUS)
						.filter(([value]) => source === "aaas_key" || value !== "queued")
						.map(([value, status]) => ({ value, label: source === "chat" && value === "running" ? "已开始" : status.label }))]}
					onChange={(next) => {
						setExecutionState(next);
						resetPaging();
					}}
				/>}
				{!source && <SelectMenu
					label="来源筛选"
					caption="来源"
					value={originTab}
					options={ORIGIN_TAB_OPTIONS}
					onChange={(next) => {
						setOriginTab(next as OriginTab);
						resetPaging();
					}}
				/>}
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
							<span className={styles.rangeLabel}>最近活动</span>
							<strong>{rangeSummary}</strong>
							<Icon name="chevronDown" />
						</button>
						{rangeOpen ? (
							<div className={styles.rangePanel} role="dialog" aria-label="选择最近活动时间范围">
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
										<button type="button" className={styles.rangeGhost} onClick={() => setRangeOpen(false)}>
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
				<div className={styles.filterActions}>
					{hasFilters ? (
						<button type="button" className={styles.clearButton} onClick={clearFilters}>
							清除
						</button>
					) : null}
					<button type="button" className={styles.refresh} onClick={() => load(apiFilters)}>
						<Icon name="refresh" />
						刷新
					</button>
				</div>
			</div>

			<section className={styles.listCard} aria-label="Session 列表">
				<header className={styles.listHeader}>
					<div>
						<h2>Session 列表</h2>
						<p>
							{state.kind === "loaded"
								? `当前页 ${overview.pageCount.toLocaleString()} 条会话 · 第 ${pageIndex + 1} 页`
								: "正在读取会话…"}
						</p>
					</div>
					<span className={styles.lifecycleNote}>点击任意行查看详情、轨迹与用量</span>
				</header>

				{state.kind === "loading" ? <p className={styles.loading}>正在加载 Session…</p> : null}
				{state.kind === "error" ? (
					<div className={styles.errorPanel} role="alert">
						<div className={styles.emptyTitle}>Session 列表加载失败</div>
						<div className={styles.emptyDesc}>{state.message}</div>
						<button type="button" className={styles.errorRetry} onClick={() => load(apiFilters)}>
							重试
						</button>
					</div>
				) : null}
				{state.kind === "loaded" && items.length === 0 ? (
					<div className={styles.empty}>
						<div className={styles.emptyTitle}>{hasFilters ? "没有匹配的 Session" : "暂无 Session 记录"}</div>
						<div className={styles.emptyDesc}>
							{hasFilters ? "尝试调整搜索关键词或筛选条件。" : "新的会话运行后会自动出现在这里。"}
						</div>
						{hasFilters ? (
							<button type="button" className={styles.errorRetry} onClick={clearFilters}>
								清除筛选
							</button>
						) : null}
					</div>
				) : null}

				{state.kind === "loaded" && items.length > 0 ? (
					<div className={styles.tableWrap}>
						<table>
							<thead>
								<tr>
									<th>最近活动</th>
									<th>应用 / Agent</th>
									<th>来源</th>
									<th>Session ID</th>
									<th>最近任务摘要</th>
									<th>
										当前状态 <span title="只表示会话生命周期，不代表最近一次执行结果">ⓘ</span>
									</th>
									<th>Turn 数</th>
									<th className={styles.actionColumn}>操作</th>
								</tr>
							</thead>
							<tbody>
								{items.map((row) => {
									const relative = relativeTime(row.lastActiveAt);
									const view = sessionLifecycleView(row.status);
									return (
										<tr
											key={row.id}
											onClick={() => openDetail(row.id)}
											tabIndex={0}
											onKeyDown={(event) => {
												if (event.target !== event.currentTarget) return;
												if (event.key === "Enter") openDetail(row.id);
											}}
										>
											<td>
												<div className={styles.primaryText} title={formatTimestamp(row.lastActiveAt)}>
													{formatShortTimestamp(row.lastActiveAt)}
												</div>
												<div className={styles.secondaryText}>
													{relative || formatTimestamp(row.lastActiveAt)}
												</div>
											</td>
											<td>
												<div className={styles.primaryText} title={row.appName}>
													{row.appName || "未命名应用"}
												</div>
												<div className={styles.secondaryText}>{shortAgentLabel(row)}</div>
												</td>
												<td>
												<span className={styles.status} title={`来源：${sessionOriginLabel(row)}`}>
													{sessionOriginLabel(row)}
												</span>
												{row.runId ? (
													<div className={styles.secondaryText} title={row.runId}>
														Run {compactSessionId(row.runId)}
													</div>
												) : null}
												</td>
												<td>
												<div className={styles.sessionCell}>
													<span className={styles.sessionId} title={row.id}>
														{compactSessionId(row.id)}
													</span>
													<button
														type="button"
														className={styles.copyButton}
														aria-label={`复制 Session ID ${row.id}`}
														onClick={(event) => {
															event.stopPropagation();
															void copyId(row.id);
														}}
													>
														<Icon name="copy" />
														{copiedId === row.id ? "已复制" : ""}
													</button>
												</div>
											</td>
											<td>
												<div className={styles.taskCell} title={row.title || undefined}>
													{row.title || <span className={styles.mutedText}>暂无任务摘要</span>}
												</div>
											</td>
											<td>
												{row.executionState && <div className={styles.primaryText}>
													{row.runId ? "Run" : "最近一轮"} · {row.executionState === "running" && !row.runId ? "已开始" : WORK_STATUS[row.executionState as keyof typeof WORK_STATUS]?.label ?? row.executionState}
												</div>}
												<div>{statusBadge(row.status)}</div>
												{row.errorCount > 0 ? (
													<div
														className={styles.errorEvents}
														title="列表 API 统计到的错误事件数，不代表执行结果"
													>
														<Icon name="warning" />
														{row.errorCount} 个错误事件
													</div>
												) : null}
											</td>
											<td className={styles.turnCell}>
												{row.turnCount === undefined ? "—" : row.turnCount}
											</td>
											<td className={styles.actionCell}>
												<div className={styles.actionButtons}>
													<button
														type="button"
														className={styles.detailButton}
														onClick={(event) => {
															event.stopPropagation();
															openDetail(row.id);
														}}
													>
														查看详情
													</button>
													<div className={styles.actionMenuWrap}>
														<button
															type="button"
															className={styles.moreButton}
															aria-label={`更多操作：${view.label} ${row.id}`}
															aria-haspopup="menu"
															aria-expanded={openMenuId === row.id}
															onClick={(event) => {
																event.stopPropagation();
																setOpenMenuId((current) => (current === row.id ? null : row.id));
															}}
														>
															<Icon name="more" />
														</button>
														{openMenuId === row.id ? (
															<div className={styles.actionMenu} role="menu" ref={actionMenuRef}>
																<button
																	type="button"
																	role="menuitem"
																	onClick={(event) => {
																		event.stopPropagation();
																		setOpenMenuId(null);
																		void copyId(row.id);
																	}}
																>
																	复制 Session ID
																</button>
																<button
																	type="button"
																	role="menuitem"
																	onClick={(event) => {
																		event.stopPropagation();
																		openDetail(row.id);
																	}}
																>
																	查看详情
																</button>
																{row.status === "active" ? (
																	<button
																		type="button"
																		role="menuitem"
																		disabled={lifecycleBusy !== null}
																		onClick={(event) => {
																			event.stopPropagation();
																			setOpenMenuId(null);
																			void updateLifecycle(row);
																		}}
																	>
																		归档会话
																	</button>
																) : null}
																{row.status === "archived" ? (
																	<button
																		type="button"
																		role="menuitem"
																		disabled={lifecycleBusy !== null}
																		onClick={(event) => {
																			event.stopPropagation();
																			setOpenMenuId(null);
																			void updateLifecycle(row);
																		}}
																	>
																		删除会话（软删除）
																	</button>
																) : null}
															</div>
														) : null}
													</div>
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				) : null}

				<footer className={styles.listFooter}>
					<span className={styles.pageStatus}>
						{state.kind === "loaded"
							? nextCursor === null || nextCursor === ""
								? "已到最后一页"
								: "可继续查看下一页"
							: "—"}
					</span>
					<div className={styles.pager}>
						<button
							type="button"
							className={styles.pageBtn}
							disabled={pageIndex === 0}
							onClick={goPrev}
							aria-label="上一页"
						>
							‹
						</button>
						<span className={styles.pageCurrent}>{pageIndex + 1}</span>
						<button
							type="button"
							className={styles.pageBtn}
							disabled={nextCursor === null || nextCursor === ""}
							onClick={goNext}
							aria-label="下一页"
						>
							›
						</button>
					</div>
					<label className={styles.pageSize}>
						每页
						<select
							value={pageSize}
							onChange={(e) => {
								setPageSize(Number(e.currentTarget.value));
								resetPaging();
							}}
						>
							{[10, 20, 50, 100].map((size) => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
						条
					</label>
				</footer>
			</section>
		</section>
	);
}

/** 自绘下拉菜单，宽度随当前项收缩。 */
function SelectMenu({
	label,
	caption,
	value,
	options,
	onChange,
}: {
	readonly label: string;
	readonly caption?: string;
	readonly value: string;
	readonly options: readonly { readonly value: string; readonly label: string }[];
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
				{caption ? <span className={styles.selectCaption}>{caption}</span> : null}
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
	name: "calendar" | "refresh" | "warning" | "copy" | "more" | "chevronDown";
}): React.ReactElement {
	const paths = {
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
		copy: (
			<>
				<rect x="9" y="9" width="11" height="11" rx="2" />
				<path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
			</>
		),
		more: (
			<>
				<circle cx="5" cy="12" r="1.4" />
				<circle cx="12" cy="12" r="1.4" />
				<circle cx="19" cy="12" r="1.4" />
			</>
		),
		chevronDown: <path d="m6 9 6 6 6-6" />,
	};
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			{paths[name]}
		</svg>
	);
}
