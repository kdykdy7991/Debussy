/**
 * WB-006/M1: 会话详情"上下文"（context）tab。
 *
 * 当前阶段：通过 fixtures 适配层取占位 DTO；真实接口接通后
 * 改为调用 `ConversationsApi.getContext` 并填充同一 `DataState`。
 *
 * 渲染口径：
 * - `loaded` 且 `available=false` → 200 但空态（合法分支：旧会话/未生成快照）；
 * - `loaded` 且 `available=true` 且 `latest` 非空 → 渲染 breakdown；
 * - `error` → `EmptyState` 错误壳（title/description 由 `describeError` 给出）。
 */
import type {
	ContextUsageBreakdown,
	ContextUsageSnapshot,
	ConversationContextResponse,
} from "@earendil-works/pi-protocol";
import { EmptyState } from "../components/EmptyState.tsx";
import { type DataState, describeError, loadFixture } from "../fixtures/index.ts";

interface ContextTabProps {
	readonly state: DataState<ConversationContextResponse>;
	readonly onRetry: () => void;
	readonly conversationId: string;
}

export function ContextTab({ state, onRetry, conversationId }: ContextTabProps): React.ReactElement {
	switch (state.kind) {
		case "idle":
			return (
				<EmptyState
					kind="empty"
					title="尚未开始加载"
					description="切换到此标签后会自动拉取最新一帧快照。"
					compact
				/>
			);
		case "loading":
			return <EmptyState kind="loading" title="加载上下文中…" description="从服务端拉取最新一帧快照。" compact />;
		case "empty":
			return (
				<EmptyState
					kind="empty"
					title={state.reason === "legacy_session" ? "旧会话无上下文快照" : "暂无快照"}
					description={
						state.reason === "legacy_session"
							? "该会话在上下文快照开关打开之前已创建，因此没有可显示的快照帧。"
							: "会话尚未发送任何模型请求；首次请求发送前会自动生成快照。"
					}
					compact
				/>
			);
		case "partial":
			return (
				<EmptyState
					kind="error"
					title="上下文返回不完整"
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
			return <LoadedContext data={state.data} onRetry={onRetry} conversationId={conversationId} />;
		case "error":
			return <ErrorShell state={state} onRetry={onRetry} />;
	}
}

function LoadedContext({
	data,
	onRetry,
	conversationId,
}: {
	readonly data: ConversationContextResponse;
	readonly onRetry: () => void;
	readonly conversationId: string;
}): React.ReactElement {
	if (!data.available || data.latest === null) {
		return (
			<EmptyState
				kind="empty"
				title="会话存在但暂无上下文快照"
				description={`available=${data.available}，latest=${data.latest === null ? "null" : "snapshot"}。这是合法的 200 响应，不是错误。`}
				compact
			/>
		);
	}
	return (
		<div className="card">
			<p className="conversation-meta">
				会话 {conversationId}
				{data.atSequence === null ? "" : ` · 快照事件序号 ${data.atSequence}`} · 计量精度 {data.latest.measurement}
			</p>
			<ContextSnapshotCard snapshot={data.latest} />
			<button type="button" onClick={onRetry}>
				刷新（M1 接线后启用）
			</button>
		</div>
	);
}

function ContextSnapshotCard({ snapshot }: { readonly snapshot: ContextUsageSnapshot }): React.ReactElement {
	const usagePercent = `${(snapshot.usagePercent * 100).toFixed(2)}%`;
	return (
		<div className="context-snapshot-card">
			<p>
				<strong>{snapshot.usedTokens.toLocaleString()}</strong> / {snapshot.contextWindow.toLocaleString()}{" "}
				tokens（使用率 {usagePercent}，剩余 {snapshot.remainingTokens.toLocaleString()}，预留输出{" "}
				{snapshot.reservedOutputTokens.toLocaleString()}）
			</p>
			<BreakdownTable breakdown={snapshot.breakdown} />
		</div>
	);
}

function BreakdownTable({ breakdown }: { readonly breakdown: ContextUsageBreakdown }): React.ReactElement {
	const rows: ReadonlyArray<{ readonly key: keyof ContextUsageBreakdown; readonly label: string }> = [
		{ key: "systemPrompt", label: "系统提示" },
		{ key: "skillInstructions", label: "Skill 指令" },
		{ key: "toolDefinitions", label: "工具定义" },
		{ key: "conversationMessages", label: "对话消息" },
		{ key: "toolResults", label: "工具结果" },
		{ key: "retrievalContext", label: "检索上下文" },
		{ key: "attachments", label: "附件" },
	];
	return (
		<table className="evt-table">
			<thead>
				<tr>
					<th>分项</th>
					<th>tokens</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={row.key}>
						<td>{row.label}</td>
						<td>{breakdown[row.key].toLocaleString()}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function ErrorShell({
	state,
	onRetry,
}: {
	readonly state: Extract<DataState<ConversationContextResponse>, { kind: "error" }>;
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
 * 数据入口：组件通过此入口获取 `DataState<ConversationContextResponse>`。
 *
 * 当前阶段按 `scenario` 路由到不同 fixture 或错误状态；真实接口接通后改为
 * `useEffect` + `api.getContext`，按 HTTP 状态码映射到 `DataState`。
 * 该函数签名（`DataState<T>`）保持不变，调用方零迁移。
 *
 * `unavailable` 是错误路径，直接构造 `error` 状态；fixture 表保留该条目供单元测试
 * 使用，不在此函数内重复。
 *
 * 注意：此函数不带 `use*` 前缀——它本身不调用任何 React hooks；按同步函数使用。
 */
export function getContextTabData(
	scenario: "ok" | "no-snapshot" | "legacy" | "unavailable",
): DataState<ConversationContextResponse> {
	switch (scenario) {
		case "ok":
			return loadFixture<ConversationContextResponse>("conversation/context/loaded-with-snapshot");
		case "no-snapshot":
			return loadFixture<ConversationContextResponse>("conversation/context/loaded-no-snapshot");
		case "legacy":
			return loadFixture<ConversationContextResponse>("conversation/context/legacy-no-snapshot");
		case "unavailable":
			return {
				kind: "error",
				code: "CONTEXT_SNAPSHOT_UNAVAILABLE",
				message: "上下文快照暂不可用",
				retryable: true,
			};
	}
}
