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
	coverageLabel,
	formatCompact,
	formatCoveragePercent,
	formatDayLabel,
	formatDuration,
	formatInteger,
	formatRunTime,
	shortId,
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
	readonly icon: "run" | "token" | "call" | "check";
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
					</div>
				</div>
			))}
		</section>
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

export function UsageTrend({ days }: { readonly days: readonly AdminUsageDayRow[] }): React.ReactElement {
	const [hovered, setHovered] = useState<string | null>(null);
	const peak = days.reduce((max, day) => Math.max(max, day.accurateTokens), 0);
	const step = niceStep(peak / 4);
	const top = step * 4;
	const ticks = [4, 3, 2, 1, 0].map((n) => n * step);
	const labelEvery = Math.max(1, Math.ceil(days.length / 14));
	const hoveredIndex = hovered === null ? -1 : days.findIndex((day) => day.date === hovered);
	const hoveredDay = hoveredIndex >= 0 ? days[hoveredIndex] : null;
	const tipLeft = days.length > 0 ? ((hoveredIndex + 0.5) / days.length) * 100 : 0;
	/** Keep the bubble inside the plot for the first and last column. */
	const tipShift = hoveredIndex <= 0 ? "0%" : hoveredIndex >= days.length - 1 ? "-100%" : "-50%";
	const tipBottom = hoveredDay !== null && top > 0 ? Math.min(100, (hoveredDay.accurateTokens / top) * 100) : 0;
	return (
		<section className={styles.trendCard} aria-label="Tokens 按天趋势">
			<div className={styles.trendTitleRow}>
				<h2 className={styles.trendTitle}>Tokens · 趋势</h2>
				<UsageHint text="按 Run 创建时间归入 UTC 自然日，仅累计完整 provider usage 的准确 Token；历史部分 Token 不计入柱高。" />
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
						{days.map((day) => (
							<div className={styles.barSlot} key={day.date}>
								<div
									className={styles.bar}
									data-empty={day.accurateTokens === 0 ? "true" : undefined}
									style={{ height: `${top > 0 ? Math.min(100, (day.accurateTokens / top) * 100) : 0}%` }}
									role="img"
									aria-label={`${day.date} 准确 Token ${formatInteger(day.accurateTokens)}`}
									onMouseEnter={() => setHovered(day.date)}
									onMouseLeave={() => setHovered(null)}
								/>
							</div>
						))}
						{hoveredDay !== null && (
							<div
								className={styles.chartTip}
								role="tooltip"
								style={{
									left: `${tipLeft}%`,
									bottom: `calc(${tipBottom}% + 10px)`,
									transform: `translateX(${tipShift})`,
								}}
							>
								<strong className={styles.chartTipDate}>{hoveredDay.date.replaceAll("-", "/")}</strong>
								<div className={styles.chartTipRow}>
									<span className={styles.chartTipDot} aria-hidden="true" />
									<span className={styles.chartTipLabel}>Tokens</span>
									<span className={styles.chartTipValue}>{formatInteger(hoveredDay.accurateTokens)}</span>
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
			<div className={styles.xAxis} aria-hidden="true">
				{days.map((day, index) => (
					<span key={day.date}>{index % labelEvery === 0 ? formatDayLabel(day.date) : ""}</span>
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

export const OPTIONAL_COLUMNS = ["state", "model", "llm", "coverage", "version"] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const COLUMN_LABELS: Record<OptionalColumn, string> = {
	state: "状态",
	model: "模型",
	llm: "LLM 调用",
	coverage: "Token 覆盖",
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
	const status = WORK_STATUS[state as AnalysisWorkState] ?? { label: state, tone: "neutral" as const };
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
						? `历史部分 Token ${formatInteger(run.partialTokens)}（仅最后一次 LLM 调用，不能计入准确总量）`
						: "该记录没有持久化的 provider usage"
				}
			>
				—
			</span>
		);
	}
	return <span>{formatInteger(run.accurateTokens)}</span>;
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
							hint="创建时间，按 UTC 显示；趋势图也按 UTC 自然日分桶。"
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
							hint="仅完整 llmUsage 的记录计入；不完整或无 usage 显示 —，历史部分 Token 单独保留可查看，不计入总量。"
						/>
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
							hint="执行耗时 = assignment 开始到结束，不包含排队时间；无法计算时显示 —。"
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
							<tr key={run.id}>
								<td className={styles.nowrap}>{formatRunTime(run.createdAt)}</td>
								<td>
									<span className={styles.idCell}>
										<code title={run.id}>{shortId(run.id)}</code>
										<CopyButton value={run.id} />
									</span>
								</td>
								<td>{run.groupName}</td>
								{visible.has("state") && (
									<td>
										<StateCell state={run.state} />
									</td>
								)}
								{visible.has("model") && <td>{run.model ?? "—"}</td>}
								<td className={styles.numeric}>
									<AccurateTokens run={run} />
								</td>
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
		return `历史部分 Token ${formatInteger(run.partialTokens)}：仅有最后一次调用的 usage，不计入准确总量。`;
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
						<th scope="col">LLM 调用</th>
						<th scope="col">平均 / 最长耗时</th>
						<th scope="col">历史部分 Token</th>
						<th scope="col">覆盖率</th>
					</tr>
				</thead>
				<tbody>
					{rows.length === 0 ? (
						<tr>
							<td colSpan={8} className={styles.emptyCell}>
								{emptyText}
							</td>
						</tr>
					) : (
						rows.map((row) => (
							<tr key={row.key}>
								<td>{row.label}</td>
								<td className={styles.numeric}>{formatInteger(row.runCount)}</td>
								<td className={styles.numeric}>
									{row.completeCount} / {row.partialCount} / {row.noUsageCount}
								</td>
								<td className={styles.numeric}>{formatInteger(row.accurateTokens)}</td>
								<td className={styles.numeric}>{formatInteger(row.llmCallCount)}</td>
								<td className={styles.nowrap}>
									{formatDuration(row.avgDurationMs === 0 ? null : row.avgDurationMs)} /{" "}
									{formatDuration(row.maxDurationMs === 0 ? null : row.maxDurationMs)}
								</td>
								<td
									className={styles.numeric}
									title="历史仅保存最后一次 LLM 调用的 usage，单独列示，不计入准确总量。"
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
