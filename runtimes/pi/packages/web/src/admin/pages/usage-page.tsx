import {
	type AdminUsageRunRow,
	type AdminUsageSummary,
	type AdminUsageViewStats,
	type AnalysisWorkItem,
	buildUsageViewStats,
	UNKNOWN_MODEL_LABEL,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OrchestrationApi } from "../api/orchestration-api.ts";
import { UsageApi } from "../api/usage-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPageHeader } from "../aurora/PageHeader.tsx";
import { AuroraPillTabs } from "../aurora/PillTabs.tsx";
import { AuroraSearchBox } from "../aurora/SearchBox.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import { errorMessage, WORK_STATUS } from "./orchestration-ui.ts";
import { OrchestrationWorkDetail } from "./orchestration-work-detail.tsx";
import {
	downloadCsv,
	EMPTY_FILTERS,
	filterUsageRuns,
	formatCompact,
	formatCoveragePercent,
	formatRunTime,
	shortId,
	sortUsageRuns,
	type UsageFilters,
	type UsageSort,
	type UsageSortKey,
	type UsageTab,
	usageCsv,
} from "./usage-format.ts";
import styles from "./usage-page.module.css";
import {
	OPTIONAL_COLUMNS,
	type OptionalColumn,
	UsageColumnsMenu,
	type UsageFilterOption,
	UsageFilterSelect,
	UsageGroupTable,
	UsageHint,
	type UsageMetricItem,
	UsageMetrics,
	UsagePagination,
	UsageRunsTable,
	UsageTabs,
	UsageTrend,
	UsageViewStatsEmpty,
} from "./usage-view.tsx";

type UsageKind = "orchestration" | "chat";
type UsageState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly summary: AdminUsageSummary }
	| { readonly kind: "error"; readonly message: string };
type DetailState =
	| { readonly kind: "loading"; readonly runId: string }
	| { readonly kind: "loaded"; readonly item: AnalysisWorkItem; readonly sourceName: string }
	| { readonly kind: "error"; readonly runId: string; readonly message: string };

const PAGE_SIZE = 10;
const DEFAULT_COLUMNS: readonly OptionalColumn[] = ["state", "model"];

const REFRESH_ICON = (
	<svg
		viewBox="0 0 16 16"
		width="14"
		height="14"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8M13.4 2.6v2.9h-2.9" />
	</svg>
);
const EXPORT_ICON = (
	<svg
		viewBox="0 0 16 16"
		width="14"
		height="14"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M8 2v8m0 0 2.8-2.8M8 10 5.2 7.2M2.6 11.2v2.2h10.8v-2.2" />
	</svg>
);

function periodForDays(days: number): { from: Date; to: Date } {
	const to = new Date();
	const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - (days - 1)));
	return { from, to };
}

function metricItems(kind: UsageKind, coverage: AdminUsageViewStats["coverage"]): readonly UsageMetricItem[] {
	const isRun = kind === "orchestration";
	return [
		{
			id: "runs",
			label: isRun ? "编排 Run 数" : "请求数",
			hint: isRun
				? "统计周期内创建的编排 Run 总数，含排队中、执行中、成功、失败与取消；不含 Chat Agent 请求。"
				: "统计周期内已结束的 Chat Agent Turn 数（turn/end 事件），不含编排 Run。",
			value: formatCompact(coverage.runCount),
			icon: "run",
		},
		{
			id: "tokens",
			label: "准确 Token",
			hint: "仅累加每次 LLM 调用都有完整 provider usage 的记录；历史部分 Token 与无 usage 记录不计入，也不会用 0 代替。",
			value: formatCompact(coverage.accurateTokens),
			icon: "token",
		},
		{
			id: "calls",
			label: "LLM 调用次数",
			hint: "只统计完整 llmUsage 记录中可准确覆盖的调用次数；历史部分记录无法准确覆盖，显示为 —。",
			value: formatCompact(coverage.llmCallCount),
			icon: "call",
		},
		{
			id: "complete",
			label: isRun ? "完整记录 Run 数" : "完整记录请求数",
			hint: "拥有完整 provider usage 的记录数；覆盖率 = 完整记录数 / 当前视图总数。",
			value: formatCompact(coverage.completeCount),
			badge: formatCoveragePercent(coverage.completeCount, coverage.runCount),
			icon: "check",
		},
	];
}

export function AdminUsagePage(): React.ReactElement {
	const { controller } = useAdminAuth();
	const apiRef = useRef<UsageApi | null>(null);
	const orchestrationApiRef = useRef<OrchestrationApi | null>(null);
	if (apiRef.current === null) apiRef.current = new UsageApi({ auth: controller });
	if (orchestrationApiRef.current === null) orchestrationApiRef.current = new OrchestrationApi(controller);
	const api = apiRef.current;
	const orchestrationApi = orchestrationApiRef.current;
	const sequence = useRef(0);

	const [days, setDays] = useState(14);
	const [kind, setKind] = useState<UsageKind>("orchestration");
	const [state, setState] = useState<UsageState>({ kind: "loading" });
	const [refreshing, setRefreshing] = useState(false);
	const [filters, setFilters] = useState<UsageFilters>(EMPTY_FILTERS);
	const [tab, setTab] = useState<UsageTab>("runs");
	const [sort, setSort] = useState<UsageSort>({ key: "createdAt", direction: "desc" });
	const [page, setPage] = useState(0);
	const [visible, setVisible] = useState<ReadonlySet<OptionalColumn>>(new Set(DEFAULT_COLUMNS));
	const [detail, setDetail] = useState<DetailState | null>(null);

	const load = useCallback(() => {
		const current = ++sequence.current;
		const { from, to } = periodForDays(days);
		setRefreshing(true);
		void api.getSummary({ from, to }).then(
			(summary) => {
				if (current !== sequence.current) return;
				setState({ kind: "loaded", summary });
				setRefreshing(false);
			},
			(error: Error) => {
				if (current !== sequence.current) return;
				setState({ kind: "error", message: error.message });
				setRefreshing(false);
			},
		);
	}, [api, days]);

	useEffect(() => {
		load();
	}, [load]);

	const summary = state.kind === "loaded" ? state.summary : null;
	const viewStats: AdminUsageViewStats | null = useMemo(() => {
		if (summary === null) return null;
		return kind === "orchestration" ? (summary.orchestration?.view ?? null) : (summary.chat ?? null);
	}, [summary, kind]);

	const narrowed = useMemo(
		() => (viewStats === null ? null : filterUsageRuns(viewStats.runs, { ...filters, query: "" })),
		[viewStats, filters],
	);
	/** Same shared aggregator as the server: filtering never changes the caliber. */
	const aggregated = useMemo(
		() =>
			summary === null || narrowed === null
				? null
				: buildUsageViewStats({
						runs: narrowed,
						from: summary.period.from,
						to: summary.period.to,
					}),
		[summary, narrowed],
	);
	const searchRuns = useMemo(
		() => (narrowed === null ? [] : filterUsageRuns(narrowed, { ...EMPTY_FILTERS, query: filters.query })),
		[narrowed, filters.query],
	);
	const sortedRuns = useMemo(() => sortUsageRuns(searchRuns, sort), [searchRuns, sort]);
	const pageCount = Math.max(1, Math.ceil(sortedRuns.length / PAGE_SIZE));
	const currentPage = Math.min(page, pageCount - 1);
	const pagedRuns = sortedRuns.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

	const groupOptions: readonly UsageFilterOption[] = useMemo(
		() =>
			viewStats === null
				? []
				: [...new Map(viewStats.runs.map((run) => [run.groupId, run.groupName])).entries()].map(
						([value, label]) => ({ value, label }),
					),
		[viewStats],
	);
	const modelOptions: readonly UsageFilterOption[] = useMemo(
		() =>
			viewStats === null
				? []
				: [...new Set(viewStats.runs.map((run) => run.model ?? UNKNOWN_MODEL_LABEL))].map((value) => ({
						value,
						label: value,
					})),
		[viewStats],
	);
	const stateOptions: readonly UsageFilterOption[] = useMemo(
		() =>
			viewStats === null
				? []
				: [
						...new Set(viewStats.runs.map((run) => run.state).filter((value): value is string => value !== null)),
					].map((value) => ({
						value,
						label: WORK_STATUS[value as keyof typeof WORK_STATUS]?.label ?? value,
					})),
		[viewStats],
	);

	const updateFilter = (patch: Partial<UsageFilters>): void => {
		setFilters((previous) => ({ ...previous, ...patch }));
		setPage(0);
	};
	const changeKind = (next: UsageKind): void => {
		setKind(next);
		setFilters(EMPTY_FILTERS);
		setTab("runs");
		setSort({ key: "createdAt", direction: "desc" });
		setPage(0);
		if (next === "chat") {
			setVisible((previous) => {
				const columns = new Set(previous);
				columns.delete("version");
				return columns;
			});
		}
	};
	const changeSort = (key: UsageSortKey): void => {
		setSort((previous) =>
			previous.key === key
				? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
				: { key, direction: "desc" },
		);
		setPage(0);
	};
	const toggleColumn = (column: OptionalColumn): void => {
		setVisible((previous) => {
			const next = new Set(previous);
			if (next.has(column)) next.delete(column);
			else next.add(column);
			return next;
		});
	};
	const exportCurrent = (): void => {
		if (aggregated === null) return;
		const content = usageCsv(tab, aggregated, sortedRuns);
		const stamp = new Date().toISOString().slice(0, 10);
		downloadCsv(`usage-${kind}-${tab}-${stamp}.csv`, content);
	};
	const openDetail = (run: AdminUsageRunRow): void => {
		if (kind === "chat") {
			if (run.conversationId !== null) navigate(`/conversations/${run.conversationId}`);
			else setDetail({ kind: "error", runId: run.id, message: "该请求没有关联的会话记录。" });
			return;
		}
		setDetail({ kind: "loading", runId: run.id });
		void orchestrationApi.request<AnalysisWorkItem>(`work-items/${encodeURIComponent(run.id)}`).then(
			(item) => setDetail({ kind: "loaded", item, sourceName: run.groupName }),
			(error: unknown) => setDetail({ kind: "error", runId: run.id, message: errorMessage(error) }),
		);
	};

	const isRun = kind === "orchestration";
	return (
		<section className={styles.page} aria-labelledby="usage-title">
			<AuroraPageHeader
				title="用量统计"
				titleId="usage-title"
				meta={
					<UsageHint text="Agent 编排与 Chat Agent 为两套独立统计口径，切换后所有指标、趋势与明细均只使用该口径的真实数据。" />
				}
				actions={
					<div className={styles.headerActions}>
						<AuroraButton size="sm" icon={REFRESH_ICON} disabled={refreshing} onClick={load}>
							{refreshing ? "正在刷新…" : "刷新"}
						</AuroraButton>
						<AuroraButton size="sm" icon={EXPORT_ICON} disabled={aggregated === null} onClick={exportCurrent}>
							导出
						</AuroraButton>
					</div>
				}
			/>

			<div className={styles.filterBar}>
				<label className={styles.rangeSelect}>
					<span className={styles.srOnly}>时间范围</span>
					<select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="时间范围">
						{[7, 14, 30, 90].map((value) => (
							<option key={value} value={value}>{`最近 ${value} 天`}</option>
						))}
					</select>
				</label>
				<div className={styles.kindTabs}>
					<AuroraPillTabs
						ariaLabel="统计口径"
						value={kind}
						onChange={changeKind}
						items={[
							{ value: "orchestration", label: "Agent 编排" },
							{ value: "chat", label: "Chat Agent" },
						]}
					/>
				</div>
				<UsageFilterSelect
					label={isRun ? "接入" : "Agent"}
					allLabel={isRun ? "全部接入" : "全部 Agent"}
					value={filters.group}
					options={groupOptions}
					onChange={(value) => updateFilter({ group: value })}
				/>
				<UsageFilterSelect
					label="模型"
					value={filters.model}
					options={modelOptions}
					onChange={(value) => updateFilter({ model: value })}
				/>
				{isRun && (
					<UsageFilterSelect
						label="状态"
						value={filters.state}
						options={stateOptions}
						onChange={(value) => updateFilter({ state: value })}
					/>
				)}
				{summary && <span className={styles.updated}>更新于 {formatRunTime(summary.generatedAt)} UTC</span>}
			</div>

			{state.kind === "loading" && <output className={styles.state}>正在汇总用量…</output>}
			{state.kind === "error" && (
				<div className={styles.error} role="alert">
					<div>
						<strong>无法加载用量统计</strong>
						<p>请确认管理服务已升级并可访问 Usage 聚合接口。</p>
						<code>{state.message}</code>
					</div>
					<AuroraButton size="sm" onClick={load}>
						重试
					</AuroraButton>
				</div>
			)}
			{state.kind === "loaded" && viewStats === null && (
				<UsageViewStatsEmpty message="当前服务版本尚未提供该口径的明细聚合，请升级管理服务后刷新。" />
			)}
			{state.kind === "loaded" && aggregated !== null && (
				<>
					<UsageMetrics items={metricItems(kind, aggregated.coverage)} />
					<UsageTrend days={aggregated.byDay} />
					<section className={styles.detailCard} aria-label="用量明细">
						<div className={styles.detailHead}>
							<UsageTabs
								value={tab}
								onChange={(next) => {
									setTab(next);
									setPage(0);
								}}
							/>
							<div className={styles.detailTools}>
								<AuroraSearchBox
									value={filters.query}
									onChange={(value) => updateFilter({ query: value })}
									placeholder="搜索 ID / 接入 / 模型"
									ariaLabel="搜索运行记录"
								/>
								<UsageColumnsMenu
									visible={visible}
									onToggle={toggleColumn}
									columns={OPTIONAL_COLUMNS.filter((column) => isRun || column !== "version")}
								/>
							</div>
						</div>
						<div
							role="tabpanel"
							aria-label={tab === "runs" ? "运行记录" : tab === "groups" ? "按接入统计" : "按模型统计"}
						>
							{tab === "runs" ? (
								<>
									<UsageRunsTable
										runs={pagedRuns}
										sort={sort}
										onSort={changeSort}
										visible={visible}
										onOpenDetail={openDetail}
									/>
									<UsagePagination
										page={currentPage}
										pageCount={pageCount}
										total={sortedRuns.length}
										onPage={setPage}
									/>
								</>
							) : (
								<UsageGroupTable
									rows={tab === "groups" ? aggregated.byGroup : aggregated.byModel}
									label={tab === "groups" ? (isRun ? "接入" : "Agent") : "模型"}
									emptyText="当前筛选条件下没有统计数据。"
								/>
							)}
						</div>
					</section>
				</>
			)}

			{detail?.kind === "loading" && <output className={styles.detailNotice}>正在加载 Run 详情…</output>}
			{detail?.kind === "error" && (
				<div className={styles.detailNotice} role="alert">
					<span>
						无法打开 {shortId(detail.runId)}：{detail.message}
					</span>
					<button type="button" onClick={() => setDetail(null)}>
						关闭
					</button>
				</div>
			)}
			{detail?.kind === "loaded" && (
				<OrchestrationWorkDetail
					key={detail.item.id}
					api={orchestrationApi}
					initial={detail.item}
					sourceName={detail.sourceName}
					onClose={() => setDetail(null)}
					onChanged={load}
				/>
			)}
		</section>
	);
}
