import {
	type AdminExecutionUsageSource,
	type AdminUsageRunRow,
	type AdminUsageSummary,
	type AdminUsageViewStats,
	type AnalysisWorkItem,
	buildUsageViewStats,
	UNKNOWN_MODEL_LABEL,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OrchestrationApi } from "../api/orchestration-api.ts";
import { usageCacheFor } from "../api/usage-cache.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPageHeader } from "../aurora/PageHeader.tsx";
import { AuroraPillTabs } from "../aurora/PillTabs.tsx";
import { AuroraSearchBox } from "../aurora/SearchBox.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { BEIJING_OFFSET_MS, beijingDay } from "../beijing-time.ts";
import { navigate } from "../router.ts";
import { errorMessage, WORK_STATUS } from "./orchestration-ui.ts";
import { OrchestrationWorkDetail } from "./orchestration-work-detail.tsx";
import {
	CACHE_HIT_HINT,
	downloadCsv,
	EMPTY_FILTERS,
	filterUsageRuns,
	formatCacheCoverage,
	formatCompact,
	formatCoveragePercent,
	formatPercent,
	formatRunTime,
	PROMPT_TOKEN_HINT,
	shortId,
	sortUsageRuns,
	usageExecutionSourceLabel,
	usageSourceLabel,
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
	UsageCaliberLine,
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

type UsageKind = "all" | AdminExecutionUsageSource;
type UsageState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly summary: AdminUsageSummary }
	| { readonly kind: "error"; readonly message: string };
type DetailState =
	| { readonly kind: "loading"; readonly runId: string }
	| { readonly kind: "loaded"; readonly item: AnalysisWorkItem; readonly sourceName: string }
	| { readonly kind: "error"; readonly runId: string; readonly message: string };

const PAGE_SIZE = 10;
export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ["state", "model", "cache"];

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
	const from = new Date(Date.parse(`${beijingDay(to)}T00:00:00+08:00`) - (days - 1) * 86400000);
	return { from, to };
}

/** Rebucket the returned rows for Beijing days without changing API timestamps or UTC contract. */
export function buildBeijingUsageStats(input: {
	readonly runs: readonly AdminUsageRunRow[];
	readonly from: string;
	readonly to: string;
}): AdminUsageViewStats {
	const original = buildUsageViewStats(input);
	const shifted = (value: string): string => new Date(Date.parse(value) + BEIJING_OFFSET_MS).toISOString();
	const beijing = buildUsageViewStats({
		runs: input.runs.map((run) => ({ ...run, createdAt: shifted(run.createdAt) })),
		from: shifted(input.from),
		to: shifted(input.to),
	});
	return { ...original, byDay: beijing.byDay };
}

export function metricItems(kind: UsageKind, coverage: AdminUsageViewStats["coverage"]): readonly UsageMetricItem[] {
	const recordName = kind === "chat" ? "请求" : kind === "router" ? "Operation" : kind === "all" ? "执行记录" : "Run";
	// Cache coverage is counted per LLM call: a record may hold several model
	// calls and only some of them may report cache fields.
	const cacheCoverage = formatCacheCoverage(coverage.cacheReportedCalls, coverage.cacheUnknownCalls);
	return [
		{
			id: "runs",
			label: `${recordName}数`,
			hint: "Chat 按结束的 Turn 统计，旧入口按 Run 统计，Router 按 Operation 统计。",
			value: formatCompact(coverage.runCount),
			icon: "run",
		},
		{
			id: "tokens",
			label: "准确 Token",
			hint: "仅累加每次 LLM 调用都有完整 provider usage 的记录；部分用量 与无 usage 记录不计入，也不会用 0 代替。",
			// Without a single complete record the total is unknown, not zero.
			value: coverage.completeCount === 0 ? "—" : formatCompact(coverage.accurateTokens),
			note: coverage.partialCount > 0 ? `已知部分 ${formatCompact(coverage.partialTokens)}` : undefined,
			icon: "token",
		},
		{
			id: "calls",
			label: "已记录 LLM 调用次数",
			hint: "只统计完整用量且保存了调用记录的执行。Router 调用次数来自逐次模型记录。",
			value: coverage.llmCallCount === 0 ? "—" : formatCompact(coverage.llmCallCount),
			icon: "call",
		},
		{
			id: "complete",
			label: `完整记录${recordName}数`,
			hint: "拥有完整 provider usage 的记录数；覆盖率 = 完整记录数 / 当前视图总数。",
			value: formatCompact(coverage.completeCount),
			badge: formatCoveragePercent(coverage.completeCount, coverage.runCount),
			icon: "check",
		},
		{
			id: "cacheHitTokens",
			label: "缓存命中 Token",
			hint: `仅统计完整 provider usage 且明确上报缓存字段的 LLM 调用；同一轮里未上报缓存的调用按未知处理，既不计入命中也不计入 Prompt Token，不当作 0 或未命中。badge 为缓存数据覆盖率（按调用次数），无有效分母时显示 —。${CACHE_HIT_HINT}${PROMPT_TOKEN_HINT}`,
			// With no reported cache calls the aggregate is 0, but showing 0 would
			// imply "zero hits" for unknown data; show the same unknown marker.
			value: coverage.cacheReportedCalls === 0 ? "—" : formatCompact(coverage.cacheHitTokens),
			badge: cacheCoverage,
			icon: "cache",
		},
		{
			id: "cacheHitRate",
			label: "缓存命中率",
			hint: `仅统计完整 provider usage 且明确上报缓存字段的 LLM 调用；命中率按 Prompt Token 加权；未上报的调用按未知处理，不当作 0 或未命中。${PROMPT_TOKEN_HINT}`,
			value: formatPercent(coverage.cacheHitRate),
			badge: cacheCoverage,
			icon: "cache",
		},
	];
}

export function AdminUsagePage(): React.ReactElement {
	const { snapshot } = useAdminAuth();
	return <ConnectedUsagePage key={`${snapshot.state}:${snapshot.baseUrl}:${snapshot.tenant?.id ?? ""}`} />;
}

export function executionUsageRows(summary: AdminUsageSummary, kind: UsageKind): readonly AdminUsageRunRow[] | null {
	const orchestration = summary.orchestration;
	const sources = new Map(orchestration?.byIntegration.map((row) => [row.integrationId, row.source]));
	const legacy = orchestration?.view?.runs.map((run): AdminUsageRunRow => ({
		...run,
		source: run.source ?? (sources.get(run.groupId) === "aaas_key" || run.groupName.startsWith("aaas_key:") ? "aaas_key" : "integration"),
	}));
	const chat = summary.chat?.runs.map((run): AdminUsageRunRow => ({ ...run, source: "chat" }));
	const router = summary.router?.runs;
	if (kind === "chat") return chat ?? null;
	if (kind === "router") return router ?? null;
	if (kind !== "all") return legacy?.filter((run) => run.source === kind) ?? null;
	if (!chat && !legacy && !router) return null;
	return [...(chat ?? []), ...(legacy ?? []), ...(router ?? [])].map((run) => ({
		...run,
		groupId: `${run.source}:${run.groupId}`,
		groupName: run.source === undefined ? run.groupName : `${usageExecutionSourceLabel[run.source]} · ${run.groupName.replace(/^aaas_key:/, "")}`,
	}));
}

function ConnectedUsagePage(): React.ReactElement {
	const { controller, snapshot } = useAdminAuth();
	const orchestrationApiRef = useRef<OrchestrationApi | null>(null);
	if (orchestrationApiRef.current === null) orchestrationApiRef.current = new OrchestrationApi(controller);
	const cache = usageCacheFor(controller);
	const orchestrationApi = orchestrationApiRef.current;
	const sequence = useRef(0);

	const [days, setDays] = useState(14);
	const [kind, setKind] = useState<UsageKind>("all");
	const [state, setState] = useState<UsageState>(() => {
		const cached = cache.get(periodForDays(14).from);
		return cached ? { kind: "loaded", summary: cached.summary } : { kind: "loading" };
	});
	const [refreshing, setRefreshing] = useState(false);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [filters, setFilters] = useState<UsageFilters>(EMPTY_FILTERS);
	const [tab, setTab] = useState<UsageTab>("runs");
	const [sort, setSort] = useState<UsageSort>({ key: "createdAt", direction: "desc" });
	const [page, setPage] = useState(0);
	const [visible, setVisible] = useState<ReadonlySet<OptionalColumn>>(new Set(DEFAULT_COLUMNS));
	const [detail, setDetail] = useState<DetailState | null>(null);

	const load = useCallback(
		(force = false) => {
			const current = ++sequence.current;
			if (snapshot.state !== "connected" || snapshot.tenant === null) return;
			const { from } = periodForDays(days);
			const cached = cache.get(from);
			setRefreshError(null);
			setState(cached ? { kind: "loaded", summary: cached.summary } : { kind: "loading" });
			if (!force && cached && cache.isFresh(cached)) {
				setRefreshing(false);
				return;
			}
			setRefreshing(true);
			void cache.request(from, force).then(
				(summary) => {
					if (current !== sequence.current) return;
					setState({ kind: "loaded", summary });
					setRefreshing(false);
				},
				(error: Error) => {
					if (current !== sequence.current) return;
					if (cached) setRefreshError(error.message);
					else setState({ kind: "error", message: error.message });
					setRefreshing(false);
				},
			);
		},
		[cache, days, snapshot.state, snapshot.tenant],
	);

	useEffect(() => {
		load();
		return () => {
			sequence.current++;
		};
	}, [load]);

	const summary = state.kind === "loaded" ? state.summary : null;
	const viewRuns = useMemo(() => (summary === null ? null : executionUsageRows(summary, kind)), [summary, kind]);

	const narrowed = useMemo(
		() => (viewRuns === null ? null : filterUsageRuns(viewRuns, { ...filters, query: "" })),
		[viewRuns, filters],
	);
	/** Same shared aggregator as the server: filtering never changes the caliber. */
	const aggregated = useMemo(
		() =>
			summary === null || narrowed === null
				? null
				: buildBeijingUsageStats({
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
			viewRuns === null
				? []
				: [...new Map(viewRuns.map((run) => [run.groupId, usageSourceLabel(run.groupName)])).entries()].map(
						([value, label]) => ({ value, label }),
					),
		[viewRuns],
	);
	const modelOptions: readonly UsageFilterOption[] = useMemo(
		() =>
			viewRuns === null
				? []
				: [...new Set(viewRuns.map((run) => run.model ?? UNKNOWN_MODEL_LABEL))].map((value) => ({
						value,
						label: value,
					})),
		[viewRuns],
	);
	const stateOptions: readonly UsageFilterOption[] = useMemo(
		() =>
			viewRuns === null
				? []
				: [
						...new Set(viewRuns.map((run) => run.state).filter((value): value is string => value !== null)),
					].map((value) => ({
						value,
						label: WORK_STATUS[value as keyof typeof WORK_STATUS]?.label ?? (value === "completed" ? "已完成" : value === "canceled" ? "已取消（Router）" : value),
					})),
		[viewRuns],
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
		const stamp = beijingDay(new Date());
		downloadCsv(`usage-${kind}-${tab}-${stamp}.csv`, content);
	};
	const openDetail = (run: AdminUsageRunRow): void => {
		if (run.routerTaskId && run.routerKeyId) {
			navigate(`/conversations/router/${run.routerKeyId}/${run.routerTaskId}/${run.id}`);
			return;
		}
		if (run.conversationId !== null) {
			navigate(`/conversations/${run.conversationId}`);
			return;
		}
		if (run.source !== "integration") {
			setDetail({ kind: "error", runId: run.id, message: "该记录没有关联的会话。" });
			return;
		}
		setDetail({ kind: "loading", runId: run.id });
		void orchestrationApi.request<AnalysisWorkItem>(`work-items/${encodeURIComponent(run.id)}`).then(
			(item) => setDetail({ kind: "loaded", item, sourceName: usageSourceLabel(run.groupName) }),
			(error: unknown) => setDetail({ kind: "error", runId: run.id, message: errorMessage(error) }),
		);
	};

	const isRun = kind !== "chat";
	const groupLabel = kind === "chat" ? "Agent" : kind === "all" ? "归属" : "接入";
	return (
		<section className={styles.page} aria-labelledby="usage-title">
			<AuroraPageHeader
				title="用量统计"
				titleId="usage-title"
				meta={
					<UsageHint text="按来源区分 Chat Turn、旧 Run 和 Router Operation。已知部分用量单独展示。" />
				}
				actions={
					<div className={styles.headerActions}>
						<AuroraButton size="sm" icon={REFRESH_ICON} disabled={refreshing} onClick={() => load(true)}>
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
						ariaLabel="用量来源"
						value={kind}
						onChange={changeKind}
						items={[
							{ value: "all", label: "全部来源" },
							{ value: "chat", label: usageExecutionSourceLabel.chat },
							{ value: "integration", label: usageExecutionSourceLabel.integration },
							{ value: "router", label: usageExecutionSourceLabel.router },
						]}
					/>
				</div>
				<UsageFilterSelect
					label={groupLabel}
					allLabel={`全部${groupLabel}`}
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
				{summary && <span className={styles.updated}>更新于 {formatRunTime(summary.generatedAt)} 北京时间</span>}
			</div>

			<UsageCaliberLine />
			{refreshError && (
				<div className={styles.error} role="alert">
					刷新失败，当前显示上次的数据：{refreshError}
				</div>
			)}

			{state.kind === "loading" && <output className={styles.state}>正在汇总用量…</output>}
			{state.kind === "error" && (
				<div className={styles.error} role="alert">
					<div>
						<strong>无法加载用量统计</strong>
						<p>请确认管理服务已升级并可访问 Usage 聚合接口。</p>
						<code>{state.message}</code>
					</div>
					<AuroraButton size="sm" onClick={() => load(true)}>
						重试
					</AuroraButton>
				</div>
			)}
			{state.kind === "loaded" && viewRuns === null && (
				<UsageViewStatsEmpty message="当前服务版本尚未提供该口径的明细聚合，请升级管理服务后刷新。" />
			)}
			{kind === "all" && summary && (!summary.chat || !summary.orchestration?.view || !summary.router) && (
				<p className={styles.state}>当前管理服务仅提供部分来源的用量数据。</p>
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
									label={tab === "groups" ? groupLabel : "模型"}
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
					onChanged={() => load(true)}
				/>
			)}
		</section>
	);
}
