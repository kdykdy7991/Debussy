/**
 * WB-006/M1: 会话详情"上下文"（context）tab。
 *
 * 调用 `ConversationsApi.getContext` 真实接口；切换 tab / 重试都触发新请求。
 * 错误码直接来自协议 `admin-workbench-metrics.ts` 的错误表，按 HTTP 状态映射。
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
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationsApi } from "../api/conversations-api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { createStaleResponseGuard, type DataState, describeError, toDataStateError } from "../data-state.ts";

interface ContextTabProps {
	readonly conversationId: string;
	readonly api: ConversationsApi;
}

type ErrorDataState = Extract<DataState<ConversationContextResponse>, { kind: "error" }>;

function mapErrorToDataState(err: unknown): ErrorDataState {
	return toDataStateError(err);
}

/**
 * 把 `ContextUsageSnapshot.usagePercent` 渲染成 UI 副本。
 * 协议字段已是百分比标量（如 3.75 表示 3.75%），渲染时只 `toFixed(2)` 加 `%`——
 * **不要**再乘以 100（之前 `(v * 100)` 会把 3.75 渲染成 375%）。
 *
 * 导出本函数使单测可以共享组件的渲染逻辑（避免复制实现导致回归）。
 */
export function formatUsagePercent(snapshot: ContextUsageSnapshot): string {
	return `${snapshot.usagePercent.toFixed(2)}%`;
}

export function ContextTab({ conversationId, api }: ContextTabProps): React.ReactElement {
	const [state, setState] = useState<DataState<ConversationContextResponse>>({ kind: "idle" });

	// 防止过期响应覆盖最新请求结果（见 `data-state.ts` StaleResponseGuard）。
	const guardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (guardRef.current === null) guardRef.current = createStaleResponseGuard();
	const guard = guardRef.current;

	const load = useCallback(() => {
		const ticket = guard.begin();

		setState({ kind: "loading" });
		api.getContext(conversationId, ticket.signal)
			.then((data) => {
				ticket.commit(() => setState({ kind: "loaded", data }));
			})
			.catch((err: unknown) => {
				if (err instanceof DOMException && err.name === "AbortError") return;
				ticket.commit(() => setState(mapErrorToDataState(err)));
			});
	}, [api, conversationId, guard]);

	useEffect(() => {
		load();
		return () => {
			guard.cancel();
		};
	}, [load, guard]);

	const onRetry = () => load();

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
				刷新
			</button>
		</div>
	);
}

function ContextSnapshotCard({ snapshot }: { readonly snapshot: ContextUsageSnapshot }): React.ReactElement {
	return (
		<div className="context-snapshot-card">
			<p>
				<strong>{snapshot.usedTokens.toLocaleString()}</strong> / {snapshot.contextWindow.toLocaleString()}{" "}
				tokens（使用率 {formatUsagePercent(snapshot)}，剩余 {snapshot.remainingTokens.toLocaleString()}
				，预留输出 {snapshot.reservedOutputTokens.toLocaleString()}）
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
	readonly state: ErrorDataState;
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
