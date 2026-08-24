/**
 * WB-006/M1: 会话详情"性能"（metrics）tab。
 *
 * 当前阶段：通过 fixtures 适配层取占位 DTO；真实接口接通后
 * 改为调用 `ConversationsApi.getMetrics` 并填充同一 `DataState`。
 * 因此组件只对 `DataState` 判别渲染，不与 fixture 实现耦合。
 *
 * 渲染口径：
 * - `loaded` 且 `stats.available=false` → 200 但空态（合法分支，不是错误）；
 * - `loaded` 且 `stats.available=true` → 渲染 `MetricsRow` + 明细表；
 * - `error` → `EmptyState` 错误壳（title/description 由 `describeError` 给出）。
 */
import type { ConversationMetricsResponse, ConversationTurnMetric } from "@earendil-works/pi-protocol";
import { EmptyState } from "../components/EmptyState.tsx";
import { type MetricItem, MetricsRow } from "../components/MetricsRow.tsx";
import { type DataState, describeError, loadFixture } from "../fixtures/index.ts";

interface MetricsTabProps {
	readonly state: DataState<ConversationMetricsResponse>;
	readonly onRetry: () => void;
	readonly conversationId: string;
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

export function MetricsTab({ state, onRetry, conversationId }: MetricsTabProps): React.ReactElement {
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
			return <LoadedMetrics data={state.data} onRetry={onRetry} conversationId={conversationId} />;
		case "error":
			return <ErrorShell state={state} onRetry={onRetry} />;
	}
}

function LoadedMetrics({
	data,
	onRetry,
	conversationId,
}: {
	readonly data: ConversationMetricsResponse;
	readonly onRetry: () => void;
	readonly conversationId: string;
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
	return (
		<div className="card">
			<p className="conversation-meta">
				会话 {conversationId} · 总轮数 {data.stats.turnCount} · 有效样本 {data.stats.sampleCount}
			</p>
			<MetricsRow items={buildMetricItems(data.stats)} />
			<MetricsTable items={data.items} />
			<Pagination data={data} onRetry={onRetry} />
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

function Pagination({
	data,
	onRetry,
}: {
	readonly data: ConversationMetricsResponse;
	readonly onRetry: () => void;
}): React.ReactElement | null {
	if (data.nextAfterSequence === null) return null;
	return (
		<div className="metrics-pagination">
			<p>本页最末序号 {data.nextAfterSequence}（下一游标）。</p>
			<button type="button" onClick={onRetry}>
				加载下一页（M1 接线后启用）
			</button>
		</div>
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

/**
 * 数据入口：组件通过此入口获取 `DataState<ConversationMetricsResponse>`。
 *
 * 当前阶段按 `scenario` 路由到不同 fixture 或错误状态；真实接口接通后改为：
 * `useEffect` 触发 `api.getMetrics`，按 HTTP 状态码映射到 `DataState` 的
 * `loading / loaded / empty / error` 四态。该函数的签名（`DataState<T>`）保持不变，
 * 调用方零迁移。
 *
 * `unavailable` / `invalid` 是错误路径，直接构造 `error` 状态；fixture 表保留
 * 这些条目供单元测试与未来错误注入场景使用，不在此函数内重复。
 *
 * 注意：此函数不带 `use*` 前缀——它本身不调用任何 React hooks；按同步函数使用。
 */
export function getMetricsTabData(
	scenario: "ok" | "empty" | "unavailable" | "invalid",
): DataState<ConversationMetricsResponse> {
	switch (scenario) {
		case "ok":
			return loadFixture<ConversationMetricsResponse>("conversation/metrics/loaded-with-sample");
		case "empty":
			return loadFixture<ConversationMetricsResponse>("conversation/metrics/loaded-empty");
		case "unavailable":
			return {
				kind: "error",
				code: "METRICS_UNAVAILABLE",
				message: "指标服务暂不可用",
				retryable: true,
			};
		case "invalid":
			return {
				kind: "error",
				code: "INVALID_METRICS_FILTER",
				message: "分页参数非法",
				retryable: false,
			};
	}
}
