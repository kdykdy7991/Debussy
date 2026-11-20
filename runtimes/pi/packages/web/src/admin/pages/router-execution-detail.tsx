import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AaasKeysApi } from "../api/aaas-keys-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPillTabs } from "../aurora/PillTabs.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { formatBeijing } from "../beijing-time.ts";
import { createStaleResponseGuard } from "../data-state.ts";
import { navigate } from "../router.ts";
import detailStyles from "../user-conversations/conversation-detail.module.css";
import usageStyles from "../user-conversations/usage-view.module.css";
import { Info, InfoCard } from "../user-conversations/execution-info.tsx";
import styles from "./aaas-keys-page.module.css";
import { formatDuration } from "./usage-format.ts";
import { RouterOperationUsage } from "./router-operation-usage.tsx";
import { RouterTaskHistory } from "./router-task-history.tsx";
import { errorMessage } from "./orchestration-ui.ts";
import {
	type RouterHistoryEvent,
	RouterOperationTrajectory,
	type RouterTrajectoryOperation,
} from "./router-operation-trajectory.tsx";

type Task = {
	id: string;
	status: string;
	execution_duration_ms?: number;
	usage: { complete: boolean; known_totals: Record<string, number>; unknown_operations: number };
	operations: { id: string; sequence: number; status: string }[];
	next_cursor: string | null;
};
type Operation = RouterTrajectoryOperation & {
	id: string;
	task_id: string;
	started_at: string | null;
	cancel_reason: string | null;
	status: string;
	error: { code: string } | null;
	cache_read?: { tokens: number | null; reported_calls: number; total_calls: number };
	usage: {
		complete: boolean;
		total_tokens: number | null;
		input_tokens: number | null;
		output_tokens: number | null;
	};
};
type HistoryPage = { events: RouterHistoryEvent[]; next_cursor: string | null };

export function usageLabel(value: number | null | undefined, complete: boolean): string {
	return value == null ? "未知" : `${value} tokens${complete ? "" : "（已确认部分）"}`;
}

export const routerStateLabel: Record<string, string> = {
	idle: "空闲",
	active: "进行中",
	queued: "排队中",
	running: "运行中",
	completed: "已完成",
	failed: "失败",
	canceled: "已取消",
};

export function RouterExecutionDetail({
	keyId,
	taskId,
	operationId,
}: {
	keyId: string;
	taskId: string;
	operationId: string;
}): React.JSX.Element {
	const { controller } = useAdminAuth();
	const api = useMemo(() => new AaasKeysApi(controller), [controller]);
	const root = `/${keyId}/router`;
	const taskPath = `${root}/tasks/${taskId}`;
	const operationPath = `${root}/operations/${operationId}`;
	const [task, setTask] = useState<Task | null>(null);
	const [operation, setOperation] = useState<Operation | null>(null);
	const [taskGuard] = useState(createStaleResponseGuard);
	const [historyGuard] = useState(createStaleResponseGuard);
	const historyAttempt = useRef<string | null>(null);
	const [history, setHistory] = useState<HistoryPage>({ events: [], next_cursor: null });
	const [loadingTask, setLoadingTask] = useState(true);
	const [loadingOperation, setLoadingOperation] = useState(true);
	const [loadingHistory, setLoadingHistory] = useState(true);
	const [taskError, setTaskError] = useState("");
	const [operationError, setOperationError] = useState("");
	const [historyError, setHistoryError] = useState("");
	const [revision, setRevision] = useState(0);
	const [view, setView] = useState<"calls" | "usage" | "history">("calls");
	const current = operation?.id === operationId ? operation : null;
	const cacheRead = current?.cache_read;
	const loadTask = useCallback(
		(after: string | null) => {
			const ticket = taskGuard.begin();
			setLoadingTask(true);
			setTaskError("");
			void api
				.request<Task>(
					taskPath + (after ? `?after=${encodeURIComponent(after)}` : ""),
					"GET",
					undefined,
					ticket.signal,
				)
				.then(
					(page) =>
						ticket.commit(() => {
							setTask((previous) =>
								after && previous
									? { ...page, operations: [...previous.operations, ...page.operations] }
									: page,
							);
							setLoadingTask(false);
						}),
					(cause: unknown) =>
						ticket.commit(() => {
							setTaskError(errorMessage(cause));
							setLoadingTask(false);
						}),
				);
		},
		[api, taskGuard, taskPath],
	);
	const loadHistory = useCallback(
		(after: string | null) => {
			const ticket = historyGuard.begin();
			historyAttempt.current = after;
			setLoadingHistory(true);
			setHistoryError("");
			void api
				.request<HistoryPage>(
					`${taskPath}/history${after ? `?after=${encodeURIComponent(after)}` : ""}`,
					"GET",
					undefined,
					ticket.signal,
				)
				.then(
					(page) =>
						ticket.commit(() => {
							setHistory((previous) =>
								after ? { ...page, events: [...previous.events, ...page.events] } : page,
							);
							setLoadingHistory(false);
						}),
					(cause: unknown) =>
						ticket.commit(() => {
							setHistoryError(errorMessage(cause));
							setLoadingHistory(false);
						}),
				);
		},
		[api, historyGuard, taskPath],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes the current task and history.
	useEffect(() => {
		loadTask(null);
		loadHistory(null);
		return () => {
			taskGuard.cancel();
			historyGuard.cancel();
		};
	}, [historyGuard, loadHistory, loadTask, revision, taskGuard]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes the selected Operation.
	useEffect(() => {
		const abort = new AbortController();
		setLoadingOperation(true);
		setOperationError("");
		void api
			.request<Operation>(operationPath, "GET", undefined, abort.signal)
			.then((selected) => {
				if (abort.signal.aborted) return;
				if (selected.task_id !== taskId) throw new Error("Operation 不属于此 Task");
				setOperation(selected);
			})
			.catch((cause: unknown) => {
				if (!abort.signal.aborted) setOperationError(errorMessage(cause));
			})
			.finally(() => {
				if (!abort.signal.aborted) setLoadingOperation(false);
			});
		return () => abort.abort();
	}, [api, operationPath, revision, taskId]);

	const operationEvents = history.events.filter((event) => event.operation_id === operationId);

	return (
		<section className={detailStyles.page} aria-label="Router 执行详情">
			<div className={detailStyles.topLine}>
				<button
					type="button"
					className={detailStyles.back}
					onClick={() => navigate(`/conversations/router/${keyId}`)}
				>
					←&nbsp; 返回执行记录
				</button>
				<button type="button" className={detailStyles.refresh} onClick={() => setRevision((value) => value + 1)}>
					<span aria-hidden="true">↻</span> 刷新
				</button>
			</div>
			<div className={detailStyles.titleRow}>
				<h1>Router 执行详情</h1>
			</div>
			{(!task || !current) && (loadingTask || loadingOperation) && (
				<p className={detailStyles.loading}>正在加载执行详情…</p>
			)}
			{(taskError || operationError) && (
				<p className={detailStyles.errorBanner} role="alert">
					{taskError || operationError}
				</p>
			)}
			{task && (
				<>
					<div className={detailStyles.summaryGrid}>
						<InfoCard title="任务信息">
							<Info label="Task ID" value={taskId} copy />
							<Info label="API Key ID" value={keyId} copy />
							<Info label="任务状态" value={routerStateLabel[task.status] ?? task.status} />
							<Info label="Task 累计执行耗时" value={formatDuration(task.execution_duration_ms ?? null)} />
						</InfoCard>
						<InfoCard title="Operation 信息">
							<Info label="Operation ID" value={operationId} copy />
							<Info
								label="状态"
								value={current ? (routerStateLabel[current.status] ?? current.status) : "—"}
								status={current?.status === "completed"}
							/>
							<Info label="受理时间" value={current ? formatBeijing(current.queued_at) : "—"} />
							<Info label="开始时间" value={current?.started_at ? formatBeijing(current.started_at) : "—"} />
							<Info label="结束时间" value={current?.ended_at ? formatBeijing(current.ended_at) : "—"} />
							{current?.error && <Info label="错误代码" value={current.error.code} />}
							{current?.cancel_reason && <Info label="取消原因" value={current.cancel_reason} />}
						</InfoCard>
					</div>
					{view !== "history" && (
						<nav className={styles.routerOperationNav} aria-label="Task Operations">
							{task.operations.map((item) => (
								<AuroraButton
									size="sm"
									key={item.id}
									aria-pressed={operationId === item.id}
									onClick={() => navigate(`/conversations/router/${keyId}/${taskId}/${item.id}`)}
								>
									{item.sequence} · {routerStateLabel[item.status] ?? item.status}
								</AuroraButton>
							))}
							{task.next_cursor && (
								<AuroraButton size="sm" disabled={loadingTask} onClick={() => loadTask(task.next_cursor)}>
									加载更多 Operation
								</AuroraButton>
							)}
						</nav>
					)}
					<AuroraPillTabs
						ariaLabel="Router 执行视图"
						value={view}
						onChange={setView}
						items={[
							{ value: "calls", label: "执行轨迹" },
							{ value: "usage", label: "用量" },
							{ value: "history", label: "Task 时间线" },
						]}
					/>
					<div className={detailStyles.tabPanel}>
						{view === "calls" && current && (
							<RouterOperationTrajectory
								key={`${current.id}:${revision}`}
								api={api}
								path={`${operationPath}/trajectory`}
								operation={current}
								operationId={operationId}
								events={operationEvents}
								historyError={historyError}
								loadingHistory={loadingHistory}
								onLoadMoreEvents={history.next_cursor ? () => loadHistory(history.next_cursor) : undefined}
							/>
						)}
						{view === "usage" && (
							<section className={usageStyles.page} aria-label="用量与统计视图">
								<div className={usageStyles.heading}><div><h1>Operation 用量</h1></div></div>
								<div className={usageStyles.topGrid}>
									<article className={`${usageStyles.card} ${usageStyles.hero}`}>
										<p className={usageStyles.label}>已确认 Token 消耗</p>
										<p className={usageStyles.value}>{current?.usage.total_tokens?.toLocaleString() ?? "—"}<span className={usageStyles.unit}>tokens</span></p>
										<p className={usageStyles.cardHint}>输入 <b>{current?.usage.input_tokens?.toLocaleString() ?? "—"}</b> · 输出 <b>{current?.usage.output_tokens?.toLocaleString() ?? "—"}</b></p>
									</article>
									<article className={usageStyles.card}><p className={usageStyles.label}>Task 累计用量</p><p className={usageStyles.value}>{task.usage.known_totals.total_tokens?.toLocaleString() ?? "—"}<span className={usageStyles.unit}>tokens</span></p><p className={usageStyles.cardHint}>{task.usage.unknown_operations} 项用量未完整上报</p></article>
									<article className={usageStyles.card}>
										<p className={usageStyles.label}>缓存读取</p>
										<p className={usageStyles.value}>
											{cacheRead?.tokens == null ? "未知" : cacheRead.tokens.toLocaleString()}
											{cacheRead?.tokens != null && <span className={usageStyles.unit}>tokens</span>}
										</p>
										<p className={usageStyles.cardHint}>
											{cacheRead?.tokens == null
												? "当前 Operation 无可确认的缓存读取记录"
												: `${cacheRead.reported_calls} / ${cacheRead.total_calls} 次已记录调用可确认`}
											{cacheRead && cacheRead.tokens !== null && cacheRead.reported_calls < cacheRead.total_calls && " · 仅显示已确认部分"}
										</p>
									</article>
								</div>
								{current && !current.usage.complete && <p className={usageStyles.notice}>本次用量尚未完整上报，已确认消耗可能低于实际值。</p>}
								{current && <RouterOperationUsage key={`${current.id}:${revision}`} api={api} path={`${operationPath}/trajectory`} />}
							</section>
						)}
						{view === "history" && (
							<RouterTaskHistory
								key={taskId}
								events={history.events}
								operations={current ? [...task.operations, current] : task.operations}
								loading={loadingHistory}
								error={historyError}
								onRetry={() => loadHistory(historyAttempt.current)}
								onLoadMore={history.next_cursor ? () => loadHistory(history.next_cursor) : undefined}
							/>
						)}
					</div>
				</>
			)}
		</section>
	);
}
