/**
 * Session V1 — Usage view.
 *
 * Session totals aggregate confirmed provider usage from Turns that have
 * per-call `llmUsage`; per-call rows come from `llmUsage.calls[]`. The two are
 * projections of the same facts and are never added together. Incomplete
 * coverage is shown separately from confirmed totals. Unknown values render
 * as "—", never as zero or a character estimate.
 */
import type { ConversationSessionLlmCallUsage, ConversationSessionUsageResponse } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationsApi } from "../api/conversations-api.ts";
import { Badge } from "../components/Badge.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Table, type TableColumn } from "../components/Table.tsx";
import { createStaleResponseGuard } from "../data-state.ts";
import { OrchestrationDrawer } from "../pages/orchestration-drawer.tsx";
import { formatMetric } from "./session-view-helpers.ts";
import styles from "./usage-view.module.css";

type UsageState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly data: ConversationSessionUsageResponse }
	| { readonly kind: "error"; readonly message: string };

export interface UsageViewProps {
	readonly api: ConversationsApi;
	readonly conversationId: string;
}

const nf = new Intl.NumberFormat("zh-CN");

function known(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * 逐次调用里的 Token 分项：
 * provider 未返回用量（usageReported=false）或无法可靠计算 Token 分项时，数值是「未知」，
 * 一律渲染成「—」，不能把未知的值显示成 0。0 只在 provider 确实上报 0 时出现。
 */
export function formatCallToken(
	call: Pick<ConversationSessionLlmCallUsage, "contextTokens" | "usageReported">,
	value: number,
): string {
	return !call.usageReported || call.contextTokens === null ? "—" : formatMetric(value);
}

function knownCacheRead(call: ConversationSessionLlmCallUsage): boolean {
	return call.usageReported && (call.cacheReadReported === true || call.cacheRead > 0);
}

export function formatCallCacheRead(call: ConversationSessionLlmCallUsage): string {
	return knownCacheRead(call) ? formatMetric(call.cacheRead) : "—";
}

/** 单次 Prompt Token 未知时显示「—」，不伪造 0，也不使用字符数估算回填。 */
export function formatPromptToken(
	call: Pick<ConversationSessionLlmCallUsage, "promptTokens" | "usageReported">,
): string {
	return !call.usageReported || call.promptTokens === null ? "—" : formatMetric(call.promptTokens);
}

export function formatTimingMs(value: number | null | undefined): string {
	return !known(value) ? "—" : `${value.toFixed(1)} ms`;
}

/** 长耗时按秒展示，短耗时保留毫秒；未知值仍显示「—」。 */
export function formatDuration(value: number | null | undefined): string {
	return !known(value) ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

export function formatObservedTps(value: number | null | undefined): string {
	return !known(value) ? "—" : `${value.toFixed(2)} tok/s`;
}

export function formatSignedDelta(value: number | null | undefined, label: string): string {
	return !known(value) ? "—" : `${value > 0 ? "+" : ""}${nf.format(value)} ${label}`;
}

/** 调用终态的中文展示，不把 unknown 伪装成成功或失败。 */
export function formatCallStatus(status: ConversationSessionLlmCallUsage["status"]): string {
	switch (status) {
		case "completed":
			return "完成";
		case "failed":
			return "失败";
		case "aborted":
			return "已取消";
		default:
			return "未知";
	}
}

export interface PromptCachePoint {
	readonly index: number;
	readonly callIndex: number | null;
	readonly model: string | null;
	readonly promptTokens: number;
	readonly nonCacheInput: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/** Only reliable per-call prompt/cache facts feed the chart; gaps are not backfilled. */
export function buildPromptCachePoints(calls: readonly ConversationSessionLlmCallUsage[]): PromptCachePoint[] {
	return calls
		.filter(
			(call): call is ConversationSessionLlmCallUsage & { promptTokens: number } =>
				knownCacheRead(call) && call.contextTokens !== null && call.promptTokens !== null,
		)
		.map((call) => ({
			index: call.index,
			callIndex: call.callIndex,
			model: call.model,
			promptTokens: call.promptTokens,
			nonCacheInput: call.input,
			cacheRead: call.cacheRead,
			cacheWrite: call.cacheWrite,
		}));
}

export interface ExecutionSummary {
	readonly completed: number;
	readonly failed: number;
	readonly aborted: number;
	readonly unknown: number;
	readonly attention: boolean;
	readonly label: string;
}

export function summarizeExecution(
	calls: readonly ConversationSessionLlmCallUsage[],
	toolErrorCount: number,
): ExecutionSummary {
	let completed = 0;
	let failed = 0;
	let aborted = 0;
	let unknown = 0;
	for (const call of calls) {
		if (call.status === "completed") completed += 1;
		else if (call.status === "failed") failed += 1;
		else if (call.status === "aborted") aborted += 1;
		else unknown += 1;
	}
	const attention = toolErrorCount > 0 || failed > 0 || aborted > 0;
	const detail: string[] = [];
	if (completed > 0) detail.push(`${completed} 完成`);
	if (failed > 0) detail.push(`${failed} 失败`);
	if (aborted > 0) detail.push(`${aborted} 已取消`);
	if (unknown > 0) detail.push(`${unknown} 状态未知`);
	return {
		completed,
		failed,
		aborted,
		unknown,
		attention,
		label: calls.length === 0 ? "无 LLM 调用" : (detail.length > 0 ? detail.join(" · ") : "无 LLM 调用"),
	};
}

function delta(current: number | null | undefined, previous: number | null | undefined): number | null {
	return known(current) && known(previous) ? current - previous : null;
}

/** Runtime 观察性能列；历史数据缺列时由调用方隐藏整组列。 */
export function performanceColumns(): readonly TableColumn<ConversationSessionLlmCallUsage>[] {
	return [
		{
			key: "durationMs",
			header: <span title="Runtime 观察到的请求总耗时（单调时钟）">调用耗时</span>,
			render: (row) => formatDuration(row.timing?.durationMs),
			align: "right",
			width: 96,
		},
		{
			key: "firstOutputLatencyMs",
			header: <span title="Runtime 观察到首个文本、Reasoning 或 Tool Call 生成增量的延迟">首生成延迟</span>,
			render: (row) => formatTimingMs(row.timing?.firstOutputLatencyMs),
			align: "right",
			width: 104,
		},
		{
			key: "observedOutputTps",
			header: <span title="客户端观察到的近似输出吞吐，不是 vLLM 内部纯推理 TPS">观测 TPS</span>,
			render: (row) => formatObservedTps(row.observedOutputTps),
			align: "right",
			width: 108,
		},
	];
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }): React.ReactElement {
	return (
		<div className={styles.detailRow}>
			<span>{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

export function CallDetailDrawer({
	call,
	onClose,
}: {
	readonly call: ConversationSessionLlmCallUsage;
	readonly onClose: () => void;
}): React.ReactElement {
	const timing = call.timing;
	const hasTiming = timing !== undefined || known(call.generationMs) || known(call.observedOutputTps);
	return (
		<OrchestrationDrawer
			title={`LLM 调用 #${call.index}`}
			subtitle={`${call.model ?? "未知模型"} · ${formatCallStatus(call.status)}`}
			className={styles.detailDrawer}
			onClose={onClose}
		>
			<div className={styles.detailTag}>
				{call.usageReported ? "Provider 已上报" : "用量未知"}
				{` · ${formatCallStatus(call.status)}`}
			</div>
			<section className={styles.detailSection}>
				<h3>本次请求</h3>
				<DetailRow label="调用编号" value={call.callIndex === null ? "—（历史记录未采集）" : String(call.callIndex)} />
				<DetailRow label="Turn" value={call.turnId ?? "—"} />
				<DetailRow label="状态" value={formatCallStatus(call.status)} />
				<DetailRow label="Prompt Token" value={formatPromptToken(call)} />
				<DetailRow label="非缓存输入" value={formatCallToken(call, call.input)} />
				<DetailRow label="缓存读取" value={formatCallCacheRead(call)} />
				<DetailRow label="缓存写入" value={formatCallToken(call, call.cacheWrite)} />
				<DetailRow label="Output Token" value={formatCallToken(call, call.output)} />
				<DetailRow label="Total Token" value={formatCallToken(call, call.totalTokens)} />
				<DetailRow label="Reasoning Token" value="未知" />
			</section>
			<section className={styles.detailSection}>
				<h3>性能观测</h3>
				{hasTiming ? (
					<>
						<DetailRow label="调用耗时" value={formatDuration(timing?.durationMs)} />
						<DetailRow label="首生成延迟" value={formatTimingMs(timing?.firstOutputLatencyMs)} />
						<DetailRow label="输出阶段耗时" value={formatTimingMs(call.generationMs)} />
						<DetailRow label="观测输出 TPS" value={formatObservedTps(call.observedOutputTps)} />
					</>
				) : (
					<DetailRow label="Timing" value="—（历史记录未采集）" />
				)}
			</section>
			<p className={styles.detailHint}>Timing / TPS 是 Runtime 客户端观察值，不等于模型内部纯推理性能。</p>
		</OrchestrationDrawer>
	);
}

export function UsageView({ api, conversationId }: UsageViewProps): React.ReactElement {
	const guardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (guardRef.current === null) guardRef.current = createStaleResponseGuard();
	const guard = guardRef.current;
	const [state, setState] = useState<UsageState>({ kind: "loading" });

	const load = useCallback(() => {
		const ticket = guard.begin();
		setState({ kind: "loading" });
		api.getSessionUsage(conversationId, ticket.signal)
			.then((data) => ticket.commit(() => setState({ kind: "loaded", data })))
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				ticket.commit(() =>
					setState({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
				);
			});
	}, [api, conversationId, guard]);

	useEffect(() => {
		load();
		return () => guard.cancel();
	}, [load, guard]);

	if (state.kind === "loading")
		return (
			<EmptyState
				kind="loading"
				title="汇总会话用量中…"
				description="读取 turn/end 中的逐次 Provider 用量。"
				compact
			/>
		);
	if (state.kind === "error")
		return (
			<EmptyState
				kind="error"
				title="用量数据加载失败"
				description={state.message}
				action={<button type="button" onClick={load}>重试</button>}
				compact
			/>
		);
	return <UsageContent data={state.data} />;
}

export function UsageContent({ data }: { readonly data: ConversationSessionUsageResponse }): React.ReactElement {
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	const selectedCall = selectedIndex === null ? undefined : data.calls.find((call) => call.index === selectedIndex);
	const totals = data.totals;
	const knownCacheCalls = data.calls.filter(knownCacheRead);
	const cacheReadDisplay = knownCacheCalls.length === 0 ? "—" : nf.format(knownCacheCalls.reduce((sum, call) => sum + call.cacheRead, 0));
	const points = buildPromptCachePoints(data.calls);
	const maxPrompt = points.reduce((max, point) => Math.max(max, point.promptTokens), 0);
	const execution = summarizeExecution(data.calls, data.toolErrorCount);
	const modelNames = [...new Set(data.calls.map((call) => call.model).filter((model): model is string => model !== null))];
	const modelLabel = modelNames.length === 0 ? "模型未知" : modelNames.length === 1 ? modelNames[0] : `${modelNames.length} 个模型`;
	const hasPerformance = data.calls.some(
		(call) =>
			known(call.timing?.durationMs) ||
			known(call.timing?.firstOutputLatencyMs) ||
			known(call.generationMs) ||
			known(call.observedOutputTps),
	);
	const hasCacheWrite = points.some((point) => point.cacheWrite > 0);
	const firstPoint = points[0];
	const previousPoint = points.length >= 2 ? points[points.length - 2] : undefined;
	const latestPoint = points[points.length - 1];
	const promptDelta = delta(latestPoint?.promptTokens, previousPoint?.promptTokens);
	const cacheDelta = delta(latestPoint?.cacheRead, firstPoint?.cacheRead);
	const latestPromptDelta = delta(data.latestPromptTokens, previousPoint?.promptTokens);

	const columns: readonly TableColumn<ConversationSessionLlmCallUsage>[] = [
		{ key: "call", header: "调用", render: (row) => `#${row.index}`, width: 64 },
		{
			key: "modelStatus",
			header: "模型 / 状态",
			render: (row) => (
				<span className={styles.modelStatus}>
					<span className={styles[`dot_${row.status}`]} aria-hidden="true" />
					{row.model ?? "未知模型"} · {formatCallStatus(row.status)}
				</span>
			),
		},
		{
			key: "promptTokens",
			header: <span title="单次请求输入规模 = input + cacheRead + cacheWrite，不含 output">Prompt Token</span>,
			render: (row) => formatPromptToken(row),
			align: "right",
		},
		{
			key: "cacheRead",
			header: "缓存读取",
			render: (row) => formatCallCacheRead(row),
			align: "right",
		},
		{ key: "output", header: "Output", render: (row) => formatCallToken(row, row.output), align: "right" },
		...(hasPerformance ? performanceColumns() : []),
		{ key: "open", header: "", render: () => <span aria-hidden="true">›</span>, align: "center", width: 36 },
	];

	return (
		<section className={styles.page} aria-label="用量与统计视图">
			<div className={styles.heading}>
				<div>
					<p className={styles.eyebrow}>SESSION ANALYTICS</p>
					<h1>Session 用量</h1>
					<div className={styles.meta}>
						<strong>{modelLabel}</strong>
						<span>·</span>
						<span>{data.turns.length} Turn</span>
						<span>·</span>
						<span>{data.calls.length} 次 LLM 调用</span>
					</div>
				</div>
				<Badge variant={execution.attention ? "warning" : "success"} tone="soft" dot>
					{execution.attention ? "需要关注" : "统计正常"}
				</Badge>
			</div>

			<div className={styles.topGrid}>
				<article className={`${styles.card} ${styles.hero}`}>
					<p className={styles.label}>已确认 Token 消耗</p>
					<p className={styles.value}>
						{totals === null ? "—" : nf.format(totals.totalTokens)}
						<span className={styles.unit}>tokens</span>
					</p>
					<p className={styles.cardHint}>
						非缓存输入 <b>{totals === null ? "—" : nf.format(totals.input)}</b>
						<span> · </span>
						缓存读取 <b>{cacheReadDisplay}</b>
						<span> · </span>
						输出 <b>{totals === null ? "—" : nf.format(totals.output)}</b>
					</p>
				</article>
				<article className={styles.card}>
					<p className={styles.label}>缓存读取</p>
					<p className={styles.value}>
						{cacheReadDisplay}
						<span className={styles.unit}>tokens</span>
					</p>
					<p className={styles.cardHint}>
						{knownCacheCalls.length} / {data.calls.length} 次调用可确认
						{knownCacheCalls.length < data.calls.length && knownCacheCalls.length > 0 ? " · 已确认部分" : ""}
					</p>
				</article>
				<article className={styles.card}>
					<p className={styles.label}>最近一次 Prompt 规模</p>
					<p className={styles.value}>
						{known(data.latestPromptTokens) ? nf.format(data.latestPromptTokens) : "—"}
						<span className={styles.unit}>tokens</span>
					</p>
					<p className={styles.cardHint}>
						峰值 {known(data.peakPromptTokens) ? nf.format(data.peakPromptTokens) : "—"}
						<span> · </span>
						较上次 {formatSignedDelta(latestPromptDelta, "tokens")}
					</p>
				</article>
			</div>

			{totals === null || data.legacyTurns > 0 || data.partialTurns > 0 || data.missingTurns > 0 ? (
				<p className={styles.notice}>
					历史数据不完整：{data.legacyTurns} 个轮次仅有最后一次调用用量、{data.partialTurns} 个轮次用量不完整、
					{data.missingTurns} 个 Turn 无用量记录；已确认累计可能低于实际消耗。
				</p>
			) : null}

			<div className={styles.middleGrid}>
				<section className={styles.panel}>
					<div className={styles.panelHead}>
						<h2>Prompt 与缓存变化</h2>
						<div className={styles.legend}>
							<span><i className={styles.legendInput} />非缓存输入</span>
							<span><i className={styles.legendCache} />缓存读取</span>
							{hasCacheWrite ? <span><i className={styles.legendWrite} />缓存写入</span> : null}
						</div>
					</div>
					{points.length === 0 ? (
						<EmptyState
							kind="empty"
							title="没有可靠的 Prompt 分项"
							description="逐次调用缺少 provider 上报的分项用量，无法生成变化图。"
							compact
						/>
					) : (
						<div className={styles.chartRows}>
							{points.map((point) => {
								const inputWidth = maxPrompt > 0 ? (point.nonCacheInput / maxPrompt) * 100 : 0;
								const cacheWidth = maxPrompt > 0 ? (point.cacheRead / maxPrompt) * 100 : 0;
								const writeWidth = maxPrompt > 0 ? (point.cacheWrite / maxPrompt) * 100 : 0;
								return (
									<div className={styles.chartRow} key={`${point.callIndex ?? "none"}:${point.index}`}>
										<span className={styles.callName}>调用 {point.index}</span>
										<div className={styles.barTrack}>
											<div
												className={`${styles.barPart} ${styles.barInput}`}
												style={{ width: `${inputWidth}%` }}
												title={`非缓存输入 ${nf.format(point.nonCacheInput)}`}
											>
												{inputWidth >= 14 ? nf.format(point.nonCacheInput) : ""}
											</div>
											<div
												className={`${styles.barPart} ${styles.barCache}`}
												style={{ width: `${cacheWidth}%` }}
												title={`缓存读取 ${nf.format(point.cacheRead)}`}
											>
												{cacheWidth >= 14 ? nf.format(point.cacheRead) : ""}
											</div>
											{writeWidth > 0 ? (
												<div
													className={`${styles.barPart} ${styles.barWrite}`}
													style={{ width: `${writeWidth}%` }}
													title={`缓存写入 ${nf.format(point.cacheWrite)}`}
												>
													{writeWidth >= 14 ? nf.format(point.cacheWrite) : ""}
												</div>
											) : null}
										</div>
										<span className={styles.barValue}>{nf.format(point.promptTokens)}</span>
									</div>
								);
							})}
						</div>
					)}
					<div className={styles.chartFooter}>
						<span>Prompt 变化 <b>{formatSignedDelta(promptDelta, "tokens")}</b></span>
						<span>缓存读取变化 <b className={styles.positive}>{formatSignedDelta(cacheDelta, "tokens")}</b></span>
						<span>仅展示缓存读取已确认的调用</span>
					</div>
				</section>

				<section className={`${styles.panel} ${styles.health}`}>
					<div className={styles.healthTop}>
						<h2>执行情况</h2>
						<Badge variant={execution.attention ? "warning" : "success"} tone="soft">
							{execution.attention ? "需要关注" : "正常"}
						</Badge>
					</div>
					<div className={styles.healthCount}>
						<strong>{data.toolErrorCount}</strong>
						<span>次工具错误</span>
					</div>
					<p className={styles.healthSub}>本会话共 {data.toolCallCount} 次工具调用</p>
					<div className={styles.healthRow}>
						<span>LLM 调用</span>
						<strong>{execution.label}</strong>
					</div>
				</section>
			</div>

			<section className={styles.tablePanel}>
				<div className={styles.tableTop}>
					<div>
						<h2>逐次 LLM 调用</h2>
						<p className={styles.tableSub}>点击任意一行查看完整 Token 分项与调用信息</p>
					</div>
				</div>
				<Table
					className={styles.callTable}
					columns={columns}
					rows={data.calls}
					rowKey={(row) => `${row.turnId ?? "none"}:${row.index}`}
					onRowClick={(row) => setSelectedIndex(row.index)}
					onRowKeyDown={(event, row) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							setSelectedIndex(row.index);
						}
					}}
					rowAriaLabel={(row) => `查看第 ${row.index} 次 LLM 调用详情`}
					emptyTitle="没有逐次用量记录"
					emptyDescription="该会话的 turn/end 事件未包含 llmUsage.calls[]。"
				/>
				<p className={styles.tableFoot}>
					{hasPerformance
						? "调用编号不假定每个 Turn 从 1 开始；缺失的 Timing 显示「—」，历史记录不会回填。"
						: "此会话没有逐次性能采集数据，性能列已自动隐藏。"}
				</p>
			</section>

			<p className={styles.footnote}>
				<b>统计说明</b>　累计是 Provider 已确认的消耗，不完整时可能低于实际值；Prompt 表示单次输入规模。
				性能指标是 Runtime 客户端观测值，不代表模型内部推理速度。
			</p>

			{selectedCall !== undefined ? (
				<CallDetailDrawer call={selectedCall} onClose={() => setSelectedIndex(null)} />
			) : null}
		</section>
	);
}
