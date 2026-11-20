import type {
	AdminUsageDayRow,
	AdminUsageGroupRow,
	AdminUsageRunRow,
	AnalysisWorkState,
} from "@earendil-works/pi-protocol";
import { useState } from "react";
import { AuroraPill } from "../aurora/Pill.tsx";
import { WORK_STATUS } from "./orchestration-ui.ts";
import {
	CACHE_HIT_HINT,
	CACHE_MISS_HINT,
	CACHE_UNKNOWN_TITLE,
	coverageLabel,
	formatCacheCoverage,
	formatCacheHitMiss,
	formatCompact,
	formatCoveragePercent,
	formatDayCacheHitTokens,
	formatDayLabel,
	formatDuration,
	formatInteger,
	formatPercent,
	formatRunTime,
	PROMPT_TOKEN_HINT,
	shortId,
	usageSourceLabel,
	USAGE_CALIBER_LINE,
	type UsageSort,
	type UsageSortKey,
	type UsageTab,
} from "./usage-format.ts";
import styles from "./usage-page.module.css";

/** Compact hover/focus tooltip for caliber and field notes; no extra page space. */
export function UsageHint({ text }: { readonly text: string }): React.ReactElement {
	return (
		<button type="button" className={styles.hint} data-tip={text} aria-label={text}>
			i
		</button>
	);
}

export interface UsageFilterOption {
	readonly value: string;
	readonly label: string;
}

export function UsageFilterSelect({
	label,
	value,
	options,
	onChange,
	allLabel,
}: {
	readonly label: string;
	readonly value: string;
	readonly options: readonly UsageFilterOption[];
	readonly onChange: (value: string) => void;
	readonly allLabel?: string;
}): React.ReactElement {
	return (
		<label className={styles.filterSelect}>
			<span className={styles.srOnly}>{label}</span>
			<select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
				<option value="">{allLabel ?? `全部${label}`}</option>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}

export interface UsageMetricItem {
	readonly id: string;
	readonly label: string;
	readonly hint: string;
	readonly value: string;
	readonly badge?: string;
	readonly note?: string;
	readonly icon: "run" | "token" | "call" | "check" | "cache";
}

const METRIC_ICONS: Record<UsageMetricItem["icon"], React.ReactNode> = {
	run: <path d="M4 3.5v13l12-6.5-12-6.5Z" />,
	token: (
		<>
			<ellipse cx="10" cy="4.5" rx="6.5" ry="2.5" />
			<path d="M3.5 4.5v7c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-7M3.5 11.5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" />
		</>
	),
	call: (
		<>
			<circle cx="5" cy="4.5" r="2" />
			<circle cx="15" cy="15.5" r="2" />
			<circle cx="15" cy="4.5" r="2" />
			<path d="M6.8 5.4 13.2 14M7 7l6 6.5" />
		</>
	),
	check: (
		<>
			<circle cx="10" cy="10" r="7.5" />
			<path d="m6.5 10 2.5 2.5 4.5-5" />
		</>
	),
	cache: (
		<>
			<path d="M3 6.2 10 3l7 3.2-7 3.2-7-3.2Z" />
			<path d="m3 10.2 7 3.2 7-3.2M3 14.2l7 3.2 7-3.2" />
		</>
	),
};

export function UsageMetrics({ items }: { readonly items: readonly UsageMetricItem[] }): React.ReactElement {
	return (
		<section className={styles.metrics} aria-label="核心指标">
			{items.map((item) => (
				<div className={styles.metric} key={item.id}>
					<div className={styles.metricLabel}>
						<svg viewBox="0 0 20 20" aria-hidden="true" className={styles.metricIcon}>
							{METRIC_ICONS[item.icon]}
						</svg>
						<span>{item.label}</span>
						<UsageHint text={item.hint} />
					</div>
					<div className={styles.metricValueRow}>
						<strong className={styles.metricValue}>{item.value}</strong>
						{item.badge && <span className={styles.coverageBadge}>覆盖率 {item.badge}</span>}
						{item.note && <span className={styles.coverageBadge}>{item.note}</span>}
					</div>
				</div>
			))}
		</section>
	);
}

/**
 * 口径定义行：Prompt Token / 缓存命中 / 非命中 / Total 四个公式的可见说明。
 * 全局用量控制台与单会话 Usage 页共用同一段文案，避免两处口径漂移。
 */
export function UsageCaliberLine(): React.ReactElement {
	return (
		<p className={styles.muted} data-usage-caliber="true">
			口径：{USAGE_CALIBER_LINE}
		</p>
	);
}

function niceStep(raw: number): number {
	if (raw <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	for (const factor of [1, 2, 2.5, 5, 10]) {
		if (raw <= factor * magnitude) return factor * magnitude;
	}
	return 10 * magnitude;
}

function dayTokenSegments(day: AdminUsageDayRow) {
	const total = day.accurateTokens;
	const hit =
		day.cacheReportedRuns > 0 ? Math.min(total, day.cacheHitTokens) : 0;
	const miss =
		day.cacheReportedRuns > 0
			? Math.min(
					total - hit,
					Math.max(0, day.cachePromptTokens - day.cacheHitTokens),
				)
			: 0;
	return { hit, miss, other: total - hit - miss };
}

export function UsageTrend({
	days,
}: {
	readonly days: readonly AdminUsageDayRow[];
}): React.ReactElement {
	const [hovered, setHovered] = useState<string | null>(null);
	const peak = days.reduce((max, day) => Math.max(max, day.accurateTokens), 0);
	const step = niceStep(peak / 3.5);
	const top = step * 4;
	const ticks = [4, 3, 2, 1, 0].map((n) => n * step);
	const labelEvery = Math.max(1, Math.ceil(days.length / 14));
	const hoveredIndex =
		hovered === null ? -1 : days.findIndex((day) => day.date === hovered);
	const hoveredDay = hoveredIndex >= 0 ? days[hoveredIndex] : null;
	const tipLeft =
		days.length > 0 ? ((hoveredIndex + 0.5) / days.length) * 100 : 0;
	/** Keep the bubble inside the plot for the first and last column. */
	const tipShift =
		hoveredIndex <= 0
			? "0%"
			: hoveredIndex >= days.length - 1
				? "-100%"
				: "-50%";
	const hoveredHeight = hoveredDay === null ? 0 : hoveredDay.accurateTokens;
	const tipBottom = top > 0 ? Math.min(100, (hoveredHeight / top) * 100) : 0;
	const hoveredSegments =
		hoveredDay === null ? null : dayTokenSegments(hoveredDay);
	const barHeight = (value: number): string =>
		`${top > 0 ? Math.min(100, (value / top) * 100) : 0}%`;
	return (
		<section className={styles.trendCard} aria-label="Tokens 按天趋势">
			<div className={styles.trendTitleRow}>
				<h2 className={styles.trendTitle}>Tokens · 趋势</h2>
				<UsageHint text="按北京时间自然日汇总完整上报的总 Token。柱内区分已确认的缓存命中、非命中，以及输出或无缓存分项的其余 Token。" />
				<div className={styles.legend} aria-hidden="true">
					<span className={styles.legendItem}>
						<i className={`${styles.legendDot} ${styles.legendDotCache}`} />
						缓存命中
					</span>
					<span className={styles.legendItem}>
						<i className={styles.legendDot} />
						非命中
					</span>
					<span className={styles.legendItem}>
						<i className={`${styles.legendDot} ${styles.legendDotOther}`} />
						输出及未分类
					</span>
				</div>
			</div>
			<div className={styles.chart}>
				<div className={styles.yAxis} aria-hidden="true">
					{ticks.map((tick) => (
						<span key={tick}>{formatCompact(tick)}</span>
					))}
				</div>
				<div className={styles.plot}>
					<div className={styles.gridLines} aria-hidden="true">
						{ticks.map((tick) => (
							<span key={tick} />
						))}
					</div>
					<div className={styles.bars}>
						{days.map((day, index) => {
							const { hit, miss, other } = dayTokenSegments(day);
							const total = day.accurateTokens;
							return (
								<div
									className={styles.barSlot}
									key={day.date}
									role="img"
									aria-label={`${day.date} 总 Token ${formatInteger(total)}，缓存命中 Token ${formatDayCacheHitTokens(day)}，非命中 Token ${day.cacheReportedRuns === 0 ? "—" : formatInteger(miss)}，输出及未分类 Token ${formatInteger(other)}，缓存命中率 ${formatPercent(day.cacheHitRate)}`}
									onMouseEnter={() => setHovered(day.date)}
									onMouseLeave={() => setHovered(null)}
								>
									<div
										className={styles.bar}
										data-series="total"
										data-empty={total === 0 ? "true" : undefined}
										style={{ height: barHeight(total) }}
									>
										{total > 0 && index % labelEvery === 0 && (
											<span className={styles.barTotal}>
												{formatCompact(total)}
											</span>
										)}
										<div className={styles.barStack}>
											{other > 0 && (
												<span
													className={styles.barOther}
													data-segment="other"
													style={{ flexGrow: other }}
												/>
											)}
											{miss > 0 && (
												<span
													className={styles.barMiss}
													data-segment="miss"
													style={{ flexGrow: miss }}
												/>
											)}
											{hit > 0 && (
												<span
													className={styles.barCache}
													data-segment="hit"
													style={{ flexGrow: hit }}
												/>
											)}
										</div>
									</div>
								</div>
							);
						})}
						{hoveredDay !== null && hoveredSegments !== null && (
							<div
								className={styles.chartTip}
								role="tooltip"
								style={{
									left: `${tipLeft}%`,
									bottom: `calc(${tipBottom}% + 10px)`,
									transform: `translateX(${tipShift})`,
								}}
							>
								<strong className={styles.chartTipDate}>
									{hoveredDay.date.replaceAll("-", "/")}
								</strong>
								<div className={styles.chartTipRow}>
									<span className={styles.chartTipLabel}>总 Token</span>
									<span className={styles.chartTipValue}>
										{formatInteger(hoveredDay.accurateTokens)}
									</span>
								</div>
								<div className={styles.chartTipRow}>
									<span
										className={`${styles.chartTipDot} ${styles.chartTipDotCache}`}
										aria-hidden="true"
									/>
									<span className={styles.chartTipLabel}>缓存命中 Token</span>
									<span className={styles.chartTipValue}>
										{formatDayCacheHitTokens(hoveredDay)}
									</span>
								</div>
								<div className={styles.chartTipRow}>
									<span className={styles.chartTipDot} aria-hidden="true" />
									<span className={styles.chartTipLabel}>非命中 Token</span>
									<span className={styles.chartTipValue}>
										{hoveredDay.cacheReportedRuns === 0
											? "—"
											: formatInteger(hoveredSegments.miss)}
									</span>
								</div>
								<div className={styles.chartTipRow}>
									<span
										className={`${styles.chartTipDot} ${styles.legendDotOther}`}
										aria-hidden="true"
									/>
									<span className={styles.chartTipLabel}>输出及未分类</span>
									<span className={styles.chartTipValue}>
										{formatInteger(hoveredSegments.other)}
									</span>
								</div>
								<div className={styles.chartTipRow}>
									<span className={styles.chartTipLabel}>命中率</span>
									<span className={styles.chartTipValue}>
										{formatPercent(hoveredDay.cacheHitRate)}
									</span>
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
			<div className={styles.xAxis} aria-hidden="true">
				{days.map((day, index) => (
					<span key={day.date}>
						{index % labelEvery === 0 ? formatDayLabel(day.date) : ""}
					</span>
				))}
			</div>
		</section>
	);
}

const TABS: readonly { readonly value: UsageTab; readonly label: string }[] = [
	{ value: "runs", label: "运行记录" },
	{ value: "groups", label: "按接入统计" },
	{ value: "models", label: "按模型统计" },
];

export function UsageTabs({
	value,
	onChange,
}: {
	readonly value: UsageTab;
	readonly onChange: (value: UsageTab) => void;
}): React.ReactElement {
	return (
		<div className={styles.tabs} role="tablist" aria-label="用量明细视图">
			{TABS.map((tab) => (
				<button
					key={tab.value}
					type="button"
					role="tab"
					aria-selected={value === tab.value}
					className={`${styles.tab} ${value === tab.value ? styles.tabActive : ""}`}
					onClick={() => onChange(tab.value)}
				>
					{tab.label}
				</button>
			))}
		</div>
	);
}

export const OPTIONAL_COLUMNS = ["state", "model", "llm", "coverage", "cache", "version"] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const COLUMN_LABELS: Record<OptionalColumn, string> = {
	state: "状态",
	model: "模型",
	llm: "LLM 调用",
	coverage: "Token 覆盖",
	cache: "缓存命中",
	version: "冻结版本",
};

export function UsageColumnsMenu({
	visible,
	onToggle,
	columns,
}: {
	readonly visible: ReadonlySet<OptionalColumn>;
	readonly onToggle: (column: OptionalColumn) => void;
	readonly columns: readonly OptionalColumn[];
}): React.ReactElement {
	return (
		<details className={styles.columnsMenu}>
			<summary aria-label="列设置" title="列设置">
				<svg viewBox="0 0 20 20" aria-hidden="true">
					<rect x="2.5" y="3.5" width="15" height="13" rx="2" />
					<path d="M7.5 3.5v13M12.5 3.5v13" />
				</svg>
			</summary>
			<div className={styles.columnsPanel}>
				<strong>显示列</strong>
				{columns.map((column) => (
					<label key={column}>
						<input type="checkbox" checked={visible.has(column)} onChange={() => onToggle(column)} />
						{COLUMN_LABELS[column]}
					</label>
				))}
			</div>
		</details>
	);
}

function SortHeader({
	label,
	sortKey,
	sort,
	onSort,
	hint,
}: {
	readonly label: string;
	readonly sortKey: UsageSortKey;
	readonly sort: UsageSort;
	readonly onSort: (key: UsageSortKey) => void;
	readonly hint?: string;
}): React.ReactElement {
	const active = sort.key === sortKey;
	return (
		<th scope="col" aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
			<button
				type="button"
				className={`${styles.sortButton} ${active ? styles.sortActive : ""}`}
				onClick={() => onSort(sortKey)}
			>
				{label}
				<span aria-hidden="true">{active ? (sort.direction === "asc" ? "↑" : "↓") : "⇅"}</span>
			</button>
			{hint && <UsageHint text={hint} />}
		</th>
	);
}

function StateCell({ state }: { readonly state: string | null }): React.ReactElement {
	if (state === null) return <span className={styles.muted}>—</span>;
	const status = WORK_STATUS[state as AnalysisWorkState] ??
		(state === "completed" ? { label: "已完成", tone: "green" as const } :
			state === "canceled" ? WORK_STATUS.cancelled : { label: state, tone: "neutral" as const });
	return <AuroraPill tone={status.tone}>{status.label}</AuroraPill>;
}

function CopyButton({ value }: { readonly value: string }): React.ReactElement {
	return (
		<button
			type="button"
			className={styles.copyButton}
			title="复制完整 ID"
			aria-label="复制完整 ID"
			onClick={() => void navigator.clipboard?.writeText(value)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true">
				<rect x="5" y="5" width="8" height="9" rx="1.5" />
				<path d="M10.5 3H4.5A1.5 1.5 0 0 0 3 4.5v7" />
			</svg>
		</button>
	);
}

function AccurateTokens({ run }: { readonly run: AdminUsageRunRow }): React.ReactElement {
	if (run.accurateTokens === null) {
		return (
			<span
				className={styles.muted}
				title={
					run.tokenCoverage === "partial"
					? `已知部分用量 ${formatInteger(run.partialTokens)}，单独统计`
						: "该记录没有持久化的 provider usage"
				}
			>
				—
			</span>
		);
	}
	return <span>{formatInteger(run.accurateTokens)}</span>;
}

function CacheHitMiss({ run }: { readonly run: AdminUsageRunRow }): React.ReactElement {
	const text = formatCacheHitMiss(run);
	if (text === null) {
		return (
			<span className={styles.muted} title={CACHE_UNKNOWN_TITLE}>
				—
			</span>
		);
	}
	return (
		<span
			className={styles.cacheText}
			title={
				run.cachePromptTokens === null
					? `缓存命中 Token / 非命中 Token（加权命中率）。${CACHE_HIT_HINT}${CACHE_MISS_HINT}`
					: `缓存命中 Token / 非命中 Token（加权命中率）；Prompt Token ${formatInteger(run.cachePromptTokens)}。${CACHE_MISS_HINT}`
			}
		>
			{text}
		</span>
	);
}

export function UsageRunsTable({
	runs,
	sort,
	onSort,
	visible,
	onOpenDetail,
}: {
	readonly runs: readonly AdminUsageRunRow[];
	readonly sort: UsageSort;
	readonly onSort: (key: UsageSortKey) => void;
	readonly visible: ReadonlySet<OptionalColumn>;
	readonly onOpenDetail: (run: AdminUsageRunRow) => void;
}): React.ReactElement {
	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<thead>
					<tr>
						<SortHeader
							label="时间"
							sortKey="createdAt"
							sort={sort}
							onSort={onSort}
							hint="创建时间和趋势图均按北京时间显示。"
						/>
						<th scope="col">Run ID</th>
						<th scope="col">接入</th>
						{visible.has("state") && <th scope="col">状态</th>}
						{visible.has("model") && <th scope="col">模型</th>}
						<SortHeader
							label="准确 Token"
							sortKey="accurateTokens"
							sort={sort}
							onSort={onSort}
							hint="仅完整 llmUsage 的记录计入；不完整或无 usage 显示 —，部分用量 单独保留可查看，不计入总量。"
						/>
						{visible.has("cache") && (
							<th
								scope="col"
								title={`缓存命中 Token / 非命中 Token（加权命中率）；未上报缓存字段显示 —，不计入分母。${CACHE_HIT_HINT}${CACHE_MISS_HINT}`}
							>
								缓存命中
							</th>
						)}
						{visible.has("llm") && (
							<SortHeader
								label="LLM 调用"
								sortKey="accurateLlmCallCount"
								sort={sort}
								onSort={onSort}
								hint="只统计完整 llmUsage 记录中可准确覆盖的调用次数。"
							/>
						)}
						<SortHeader
							label="耗时"
							sortKey="durationMs"
							sort={sort}
							onSort={onSort}
							hint="执行耗时 = assignment 开始到结束，不包含排队时间；无记录显示 —，真实的 0 毫秒显示 0 ms。"
						/>
						{visible.has("coverage") && <th scope="col">Token 覆盖</th>}
						{visible.has("version") && <th scope="col">冻结版本</th>}
						<th scope="col">操作</th>
					</tr>
				</thead>
				<tbody>
					{runs.length === 0 ? (
						<tr>
							<td colSpan={6 + visible.size} className={styles.emptyCell}>
								当前筛选条件下没有记录。
							</td>
						</tr>
					) : (
						runs.map((run) => (
							<tr key={`${run.source ?? ""}:${run.id}`}>
								<td className={styles.nowrap}>{formatRunTime(run.createdAt)}</td>
								<td>
									<span className={styles.idCell}>
										<code title={run.id}>{shortId(run.id)}</code>
										<CopyButton value={run.id} />
									</span>
								</td>
								<td>{usageSourceLabel(run.groupName)}</td>
								{visible.has("state") && (
									<td>
										<StateCell state={run.state} />
									</td>
								)}
								{visible.has("model") && <td>{run.model ?? "—"}</td>}
								<td className={styles.numeric}>
									<AccurateTokens run={run} />
								</td>
								{visible.has("cache") && (
									<td className={styles.numeric}>
										<CacheHitMiss run={run} />
									</td>
								)}
								{visible.has("llm") && (
									<td className={styles.numeric}>
										{run.accurateLlmCallCount === null ? (
											<span className={styles.muted}>—</span>
										) : (
											formatInteger(run.accurateLlmCallCount)
										)}
									</td>
								)}
								<td className={styles.nowrap}>{formatDuration(run.durationMs)}</td>
								{visible.has("coverage") && (
									<td>
										<span className={styles.coverageText} title={coverageHint(run)}>
											{coverageLabel(run.tokenCoverage)}
										</span>
									</td>
								)}
								{visible.has("version") && (
									<td title={run.versionId ?? undefined}>{run.versionId ? shortId(run.versionId) : "—"}</td>
								)}
								<td>
									<button type="button" className={styles.detailLink} onClick={() => onOpenDetail(run)}>
										详情 <span aria-hidden="true">›</span>
									</button>
								</td>
							</tr>
						))
					)}
				</tbody>
			</table>
		</div>
	);
}

function coverageHint(run: AdminUsageRunRow): string {
	if (run.tokenCoverage === "complete") return "本记录每次 LLM 调用都有 provider usage，已计入准确总量。";
	if (run.tokenCoverage === "partial")
		return `已知部分用量 ${formatInteger(run.partialTokens)}，单独统计。`;
	return "没有持久化的 provider usage，准确 Token 与 LLM 调用次数均显示 —。";
}

export function UsageGroupTable({
	rows,
	label,
	emptyText,
}: {
	readonly rows: readonly AdminUsageGroupRow[];
	readonly label: string;
	readonly emptyText: string;
}): React.ReactElement {
	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<thead>
					<tr>
						<th scope="col">{label}</th>
						<th scope="col">数量</th>
						<th scope="col">完整 / 部分 / 无 usage</th>
						<th scope="col">准确 Token</th>
						<th
							scope="col"
							title={`仅统计完整 provider usage 且明确上报缓存字段的记录；无命中也有 0 值。${CACHE_HIT_HINT}`}
						>
							缓存命中 Token
						</th>
						<th
							scope="col"
							title={`命中率 = 缓存命中 Token / Prompt Token（按 Prompt Token 加权）；没有上报记录时显示 —。${PROMPT_TOKEN_HINT}`}
						>
							缓存命中率
						</th>
						<th
							scope="col"
							title="缓存覆盖 = 上报了缓存字段的 LLM 调用次数 / (上报 + 未上报)；未上报的调用按未知处理，不当作未命中。"
						>
							缓存覆盖
						</th>
						<th scope="col">LLM 调用</th>
						<th scope="col">平均 / 最长耗时</th>
						<th scope="col">部分用量</th>
						<th scope="col">覆盖率</th>
					</tr>
				</thead>
				<tbody>
					{rows.length === 0 ? (
						<tr>
							<td colSpan={11} className={styles.emptyCell}>
								{emptyText}
							</td>
						</tr>
					) : (
						rows.map((row) => (
							<tr key={row.key}>
								<td>{usageSourceLabel(row.label)}</td>
								<td className={styles.numeric}>{formatInteger(row.runCount)}</td>
								<td className={styles.numeric}>
									{row.completeCount} / {row.partialCount} / {row.noUsageCount}
								</td>
								<td className={styles.numeric}>
									{/* No complete record in this group → the accurate total is unknown, not zero. */}
									{row.completeCount === 0 ? (
										<span
											className={styles.muted}
											title="该分组没有完整 provider usage 的记录，准确 Token 未知。"
										>
											—
										</span>
									) : (
										formatInteger(row.accurateTokens)
									)}
								</td>
								<td className={styles.numeric}>
									{row.cacheReportedRuns === 0 ? (
										<span className={styles.muted} title="该分组没有上报缓存字段的记录，命中 Token 未知。">
											—
										</span>
									) : (
										formatInteger(row.cacheHitTokens)
									)}
								</td>
								<td className={styles.numeric}>{formatPercent(row.cacheHitRate)}</td>
								<td className={styles.numeric}>
									{formatCacheCoverage(row.cacheReportedCalls, row.cacheUnknownCalls)}
								</td>
								<td className={styles.numeric}>
								{row.llmCallCount === 0 ? "—" : formatInteger(row.llmCallCount)}
								</td>
								<td className={styles.nowrap}>
									{/*
									 * 服务端在「该分组没有耗时记录」时给出 avg/max = 0，因此这里把 0 转成
									 * null（未知 → 「—」）；真实测到的 0 毫秒仍由 formatDuration 渲染成 "0 ms"。
									 */}
									{formatDuration(row.avgDurationMs === 0 ? null : row.avgDurationMs)} /{" "}
									{formatDuration(row.maxDurationMs === 0 ? null : row.maxDurationMs)}
								</td>
								<td
									className={styles.numeric}
									title="不完整或取消 Turn 已确认的用量，或历史仅最后一次调用；不计入准确总量。"
								>
									{formatInteger(row.partialTokens)}
								</td>
								<td className={styles.numeric}>{formatCoveragePercent(row.completeCount, row.runCount)}</td>
							</tr>
						))
					)}
				</tbody>
			</table>
		</div>
	);
}

export function UsagePagination({
	page,
	pageCount,
	total,
	onPage,
}: {
	readonly page: number;
	readonly pageCount: number;
	readonly total: number;
	readonly onPage: (page: number) => void;
}): React.ReactElement {
	return (
		<div className={styles.pagination}>
			<span>
				共 {formatInteger(total)} 条 · 第 {page + 1} / {pageCount} 页
			</span>
			<div>
				<button type="button" disabled={page <= 0} onClick={() => onPage(page - 1)}>
					上一页
				</button>
				<button type="button" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>
					下一页
				</button>
			</div>
		</div>
	);
}

export function UsageViewStatsEmpty({ message }: { readonly message: string }): React.ReactElement {
	return <div className={styles.emptyCell}>{message}</div>;
}
