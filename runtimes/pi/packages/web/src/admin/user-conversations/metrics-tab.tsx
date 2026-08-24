/**
 * WB-006/M1: 会话详情"性能"（metrics）tab。
 *
 * 调用 `ConversationsApi.getMetrics` 真实接口；分页通过 `afterSequence` 实现；
 * 重试复用 `api.getMetrics` + `useEffect` 触发。错误码直接来自协议
 * `admin-workbench-metrics.ts`，按 HTTP 状态映射到 `DataState.error`。
 *
 * 渲染口径：
 * - `loaded` 且 `stats.available=false` → 200 但空态（合法分支，不是错误）；
 * - `loaded` 且 `stats.available=true` → 渲染 `MetricsRow` + 明细表；
 * - `error` → `EmptyState` 错误壳（title/description 由 `describeError` 给出）。
 */
import type { ConversationMetricsResponse, ConversationTurnMetric } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useState } from "react";
import { type ConversationsApi, ConversationsApiError } from "../api/conversations-api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { type MetricItem, MetricsRow } from "../components/MetricsRow.tsx";
import { type DataState, describeError } from "../fixtures/index.ts";

interface MetricsTabProps {
	readonly conversationId: string;
	readonly api: ConversationsApi;
	/**
	 * 父组件递增的游标：每次 `onNextPage(sequence)` 后下次 effect 触发新请求。
	 * 第一次进入 tab 时传 `null` → 触发首页请求。
	 */
	readonly afterSequence: number | null;
	/**
	 * 子组件通过此函数告知父组件"下一页游标"，由父组件写入 state。
	 * 必须保证幂等：父组件不可在 `onNextPage` 内同步写入（避免 effect 重入）。
	 */
	readonly onNextPage: (sequence: number) => void;
}

/**
 * 把会话级 stats 映射为 `MetricsRow` 项。失败/缺值字段保留 `null`，由 `MetricsRow`
 * 走"value=—"展示，**不**伪造 0。这是 V2 指标口径的硬约束（不静默写 0）。
 */
function buildMetricItems(stats: ConversationMetricsResponse["stats"]): readonly MetricItem[] {
	return [
		{
			id: "ttft",
			label: "TTFT (ms) 均值",
			value: stats.ttftMs.mean === null ? "—" : stats.ttftMs.mean.toFixed(1),
			comparison: `p50 ${stats.ttftMs.p50 === null ? "—" : stats.ttftMs.p50.toFixed(1)} · p95 ${
				stats.ttftMs.p95 === null ? "—" : stats.ttftMs.p95.toFixed(1)
			} · n=${stats.ttftMs.count}`,
		},
		{
			id: "generation",
			label: "生成耗时 (ms) 均值",
			value: stats.generationMs.mean === null ? "—" : stats.generationMs.mean.toFixed(1),
			comparison: `p50 ${stats.generationMs.p50 === null ? "—" : stats.generationMs.p50.toFixed(1)} · p95 ${
				stats.generationMs.p95 === null ? "—" : stats.generationMs.p95.toFixed(1)
			} · n=${stats.generationMs.count}`,
		},
		{
			id: "totalLatency",
			label: "总耗时 (ms) 均值",
			value: stats.totalLatencyMs.mean === null ? "—" : stats.totalLatencyMs.mean.toFixed(1),
			comparison: `p50 ${stats.totalLatencyMs.p50 === null ? "—" : stats.totalLatencyMs.p50.toFixed(1)} · p95 ${
				stats.totalLatencyMs.p95 === null ? "—" : stats.totalLatencyMs.p95.toFixed(1)
			} · n=${stats.totalLatencyMs.count}`,
		},
		{
			id: "outputTps",
			label: "输出 (tokens/s) 均值",
			value: stats.outputTokensPerSecond.mean === null ? "—" : stats.outputTokensPerSecond.mean.toFixed(2),
			comparison: `p50 ${stats.outputTokensPerSecond.p50 === null ? "—" : stats.outputTokensPerSecond.p50.toFixed(2)} · p95 ${
				stats.outputTokensPerSecond.p95 === null ? "—" : stats.outputTokensPerSecond.p95.toFixed(2)
			} · n=${stats.outputTokensPerSecond.count}`,
		},
	];
}

/**
 * 把 `ConversationsApiError` + 其它未知错误映射为 `DataState.error`，
 * 错误码尽量从 `ConversationsApiError.code` 透传；非 conversations-api 错误
 * 统一落到 `UNKNOWN_ERROR`。
 */
type ErrorDataState = Extract<DataState<ConversationMetricsResponse>, { kind: "error" }>;

function mapErrorToDataState(err: unknown): ErrorDataState {
	if (err instanceof ConversationsApiError) {
		const code = err.code ?? "UNKNOWN_ERROR";
		return {
			kind: "error",
			code,
			message: err.message,
			retryable: code === "METRICS_UNAVAILABLE" || code === "CONTEXT_SNAPSHOT_UNAVAILABLE",
		};
	}
	return {
		kind: "error",
		code: "UNKNOWN_ERROR",
		message: err instanceof Error ? err.message : String(err),
		retryable: false,
	};
}

export function MetricsTab({ conversationId, api, afterSequence, onNextPage }: MetricsTabProps): React.ReactElement {
	const [state, setState] = useState<DataState<ConversationMetricsResponse>>({ kind: "idle" });

	const load = useCallback(
		(after: number | null) => {
			setState({ kind: "loading" });
			const arg =
				after !== null && after > 0
					? { conversationId, afterSequence: after, limit: 50 }
					: { conversationId, limit: 50 };
			api.getMetrics(conversationId, arg)
				.then((data) => setState({ kind: "loaded", data }))
				.catch((err: unknown) => {
					setState(mapErrorToDataState(err));
				});
		},
		[api, conversationId],
	);

	// 切到本 tab / `afterSequence` 变化 → 拉一次。
	// 父组件从 `null` → 首次进入；`null → 数字` → 翻页；`数字 → null` → 重置回首页。
	useEffect(() => {
		load(afterSequence);
	}, [load, afterSequence]);

	const onRetry = () => load(afterSequence === null ? null : afterSequence > 0 ? afterSequence : null);

	switch (state.kind) {
		case "idle":
			return <EmptyState kind="empty" title="尚未开始加载" description="切换到此标签后会自动拉取指标。" compact />;
		case "loading":
			return (
				<EmptyState kind="loading" title="加载指标中…" description="从服务端拉取分页 + 全会话 stats。" compact />
			);
		case "empty":
			return (
				<EmptyState
					kind="empty"
					title={state.reason === "legacy_session" ? "旧会话无指标" : "暂无指标"}
					description={
						state.reason === "legacy_session"
							? "该会话在指标采集开关打开之前已创建，因此不会写入轮次指标。"
							: "会话尚未结束任何轮次；第一轮完成后会自动出现。"
					}
					compact
				/>
			);
		case "partial":
			return (
				<EmptyState
					kind="error"
					title="指标返回不完整"
					description={`缺字段：${state.missing.join("、")}`}
					action={
						<button type="button" onClick={onRetry}>
							重试
						</button>
					}
					compact
				/>
			);
		case "loaded":
			return <LoadedMetrics data={state.data} conversationId={conversationId} onNextPage={onNextPage} />;
		case "error":
			return <ErrorShell state={state} onRetry={onRetry} />;
	}
}

function LoadedMetrics({
	data,
	conversationId,
	onNextPage,
}: {
	readonly data: ConversationMetricsResponse;
	readonly conversationId: string;
	readonly onNextPage: (sequence: number) => void;
}): React.ReactElement {
	if (!data.stats.available) {
		return (
			<EmptyState
				kind="empty"
				title="会话存在但暂无指标"
				description={`stats.available=false（turnCount=${data.stats.turnCount}，sampleCount=${data.stats.sampleCount}）。这是合法的 200 响应，不是错误。`}
				compact
			/>
		);
	}
	const handleNextPage = () => {
		if (data.nextAfterSequence !== null) onNextPage(data.nextAfterSequence);
	};
	return (
		<div className="card">
			<p className="conversation-meta">
				会话 {conversationId} · 总轮数 {data.stats.turnCount} · 有效样本 {data.stats.sampleCount}
			</p>
			<MetricsRow items={buildMetricItems(data.stats)} />
			<MetricsTable items={data.items} />
			{data.nextAfterSequence !== null && (
				<div className="metrics-pagination">
					<p>本页最末序号 {data.nextAfterSequence}（下一游标）。</p>
					<button type="button" onClick={handleNextPage}>
						加载下一页
					</button>
				</div>
			)}
		</div>
	);
}

function MetricsTable({ items }: { readonly items: readonly ConversationTurnMetric[] }): React.ReactElement {
	if (items.length === 0) {
		return <p className="empty-cell">本会话暂无任何轮次。</p>;
	}
	return (
		<table className="evt-table">
			<thead>
				<tr>
					<th>序号</th>
					<th>结果</th>
					<th>模型</th>
					<th>TTFT (ms)</th>
					<th>生成 (ms)</th>
					<th>总耗时 (ms)</th>
					<th>输出 tokens/s</th>
				</tr>
			</thead>
			<tbody>
				{items.map((item) => {
					const m = item.metrics;
					return (
						<tr key={item.sequence}>
							<td>{item.sequence}</td>
							<td>{m.outcome}</td>
							<td>{item.modelId}</td>
							<td>{m.ttftMs === null ? "—" : m.ttftMs.toFixed(1)}</td>
							<td>{m.generationMs === null ? "—" : m.generationMs.toFixed(1)}</td>
							<td>{m.totalLatencyMs.toFixed(1)}</td>
							<td>{m.outputTokensPerSecond === null ? "—" : m.outputTokensPerSecond.toFixed(2)}</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

function ErrorShell({
	state,
	onRetry,
}: {
	readonly state: Extract<DataState<ConversationMetricsResponse>, { kind: "error" }>;
	readonly onRetry: () => void;
}): React.ReactElement {
	const { title, description } = describeError(state);
	return (
		<EmptyState
			kind="error"
			title={title}
			description={description}
			action={
				<button type="button" onClick={onRetry}>
					重试
				</button>
			}
			compact
		/>
	);
}
