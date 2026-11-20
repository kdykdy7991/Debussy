import type {
	ConversationAdminDetailResponse,
	ConversationAdminEvent,
	ConversationAdminLlmCallSummary,
	ConversationLlmTraceStatus,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationsApi } from "../api/conversations-api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { createStaleResponseGuard } from "../data-state.ts";
import styles from "./session-views.module.css";
import { type CallDetailState, type InspectionMode, TrajectoryInspector } from "./trajectory-inspector.tsx";
import { TrajectoryLedger, TrajectoryOverview } from "./trajectory-ledger.tsx";
import { buildTrajectory, recordMatches, type TrajectoryNode } from "./trajectory-model.ts";

type ListState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded" }
	| { readonly kind: "error"; readonly message: string };
export interface TrajectoryViewProps {
	readonly api: ConversationsApi;
	readonly conversationId: string;
	readonly events: readonly ConversationAdminEvent[];
	readonly initialTrace: ConversationLlmTraceStatus;
	readonly taskInput?: ConversationAdminDetailResponse["taskInput"];
	readonly hasMoreEvents?: boolean;
	readonly loadingMoreEvents?: boolean;
	readonly onLoadMoreEvents?: () => void;
}
export function traceNotice(trace: ConversationLlmTraceStatus): string {
	if (trace.reason === "table_missing")
		return "逐次调用追踪未部署（数据库缺少 0030 表）。仍可查看已记录的执行事件与用量。";
	if (trace.reason === "chat_untraced")
		return "普通对话未启用模型请求采集，无法查看逐次原始请求；仍可查看已记录的执行事件与用量。";
	if (trace.reason === "no_records")
		return "该会话没有逐次请求记录（可能创建于追踪启用前）。完整性无法确认，不得视为完整记录。";
	if (trace.coverage === "unknown")
		return "已读取逐次请求摘要；完整性无法确认（部分 Turn 缺少可核对的 llmUsage），不得视为完整记录。";
	if (trace.coverage === "partial")
		return `逐次请求记录不完整：已记录 ${trace.recordedCalls} 次，应有 ${trace.expectedCalls ?? "未知"} 次。`;
	return `逐次请求记录已核对：${trace.recordedCalls} 次 / 应有 ${trace.expectedCalls} 次。`;
}

export function TrajectoryView({
	api,
	conversationId,
	events,
	initialTrace,
	taskInput = null,
	hasMoreEvents = false,
	loadingMoreEvents = false,
	onLoadMoreEvents,
}: TrajectoryViewProps): React.ReactElement {
	const guardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (guardRef.current === null) guardRef.current = createStaleResponseGuard();
	const guard = guardRef.current;
	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [items, setItems] = useState<readonly ConversationAdminLlmCallSummary[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [trace, setTrace] = useState(initialTrace);
	const [selected, setSelected] = useState<string | null>(null);
	const [inspectionMode, setInspectionMode] = useState<InspectionMode>("record");
	const [query, setQuery] = useState("");
	const [technical, setTechnical] = useState(false);
	const [actualDuration, setActualDuration] = useState(true);
	const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(new Set());
	const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<string>>(new Set());
	const [raw, setRaw] = useState<Record<string, CallDetailState>>({});
	const loadPage = useCallback(
		(after: string | null) => {
			const ticket = guard.begin();
			setState({ kind: "loading" });
			void api
				.listLlmCalls(conversationId, { limit: 50, after: after === null ? 0 : Number(after) }, ticket.signal)
				.then((data) =>
					ticket.commit(() => {
						setItems((previous) => (after === null ? data.items : [...previous, ...data.items]));
						setCursor(data.nextCursor);
						setTrace(data.trace);
						setState({ kind: "loaded" });
					}),
				)
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError") return;
					ticket.commit(() =>
						setState({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
					);
				});
		},
		[api, conversationId, guard],
	);
	useEffect(() => {
		loadPage(null);
		return () => guard.cancel();
	}, [loadPage, guard]);
	const loadRaw = (call: ConversationAdminLlmCallSummary): void => {
		const key = `${call.turnId}:${call.callIndex}`;
		if (raw[key]?.kind === "loaded" || raw[key]?.kind === "loading") return;
		setRaw((previous) => ({ ...previous, [key]: { kind: "loading" } }));
		void api
			.getLlmCallDetail(conversationId, call.turnId, call.callIndex)
			.then((data) => setRaw((previous) => ({ ...previous, [key]: { kind: "loaded", data } })))
			.catch((error: unknown) =>
				setRaw((previous) => ({
					...previous,
					[key]: { kind: "error", message: error instanceof Error ? error.message : String(error) },
				})),
			);
	};
	const records = useMemo(
		() => buildTrajectory(events, items, technical, taskInput),
		[events, items, technical, taskInput],
	);
	const visible = records.filter((record) => recordMatches(record, query));
	const record = records.find((entry) => entry.key === selected);
	const call = record?.kind === "model" ? record.call : undefined;
	const detail = call === undefined ? undefined : raw[`${call.turnId}:${call.callIndex}`];
	const previousCall =
		call === undefined
			? undefined
			: items
					.filter((entry) => entry.turnId === call.turnId && entry.callIndex < call.callIndex)
					.sort((a, b) => b.callIndex - a.callIndex)[0];
	const previousRaw = previousCall === undefined ? undefined : raw[`${previousCall.turnId}:${previousCall.callIndex}`];
	const owners =
		record?.kind !== "tool" || record.toolCallId === ""
			? []
			: items.filter((entry) => entry.turnId === record.turnId && entry.toolCallIds.includes(record.toolCallId));
	const owner = owners.length === 1 ? owners[0] : undefined;
	const ownerDetail = owner === undefined ? undefined : raw[`${owner.turnId}:${owner.callIndex}`];
	const selectRecord = (entry: TrajectoryNode, mode: InspectionMode = "record"): void => {
		setSelected(entry.key);
		setInspectionMode(mode);
		setQuery("");
		setCollapsedTurns((previous) => {
			const next = new Set(previous);
			if (entry.turnId !== null) next.delete(entry.turnId);
			return next;
		});
		if (entry.kind === "model" && entry.call.hasRawPayload) loadRaw(entry.call);
		if (entry.kind === "tool")
			setCollapsedCalls((previous) => {
				const next = new Set(previous);
				for (const candidate of items)
					if (candidate.turnId === entry.turnId && candidate.toolCallIds.includes(entry.toolCallId))
						next.delete(`model:${candidate.turnId}:${candidate.callIndex}`);
				return next;
			});
	};
	const turnIds = [...new Set(records.flatMap((entry) => (entry.turnId === null ? [] : [entry.turnId])))];
	const callKeys = records
		.filter((entry) => entry.kind === "model" && entry.call.toolCallIds.length > 0)
		.map((entry) => entry.key);
	const allTurnsCollapsed = turnIds.length > 0 && turnIds.every((id) => collapsedTurns.has(id));
	const allCallsCollapsed = callKeys.length > 0 && callKeys.every((key) => collapsedCalls.has(key));
	return (
		<section className={styles.view} aria-label="执行轨迹视图">
			<header className={styles.trajectoryOverview}>
				<strong>执行轨迹</strong>
				<span>
					已加载 {turnIds.length} 轮 · {items.length} 次模型请求 ·{" "}
					{records.filter((entry) => entry.kind === "tool").length} 次工具执行
				</span>
			</header>
			{taskInput !== null && !records.some((entry) => entry.kind === "event" && entry.taskInput !== undefined) ? (
				<details className={styles.requestConfiguration} open>
					<summary>外部任务（API 输入）</summary>
					<p className={styles.hint}>
						该任务通过当前 API 契约作为系统提示词发送。对应触发事件尚未加载，暂不指定时间位置。
					</p>
					<pre className={styles.message}>{taskInput.text}</pre>
				</details>
			) : null}
			<div className={styles.ledgerToolbar} role="toolbar" aria-label="轨迹工具栏">
				<button type="button" aria-pressed={actualDuration} onClick={() => setActualDuration(!actualDuration)}>
					{actualDuration ? "真实耗时" : "等宽概览"}
				</button>
				<button
					type="button"
					disabled={turnIds.length === 0}
					aria-pressed={allTurnsCollapsed}
					onClick={() => setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(turnIds))}
				>
					{allTurnsCollapsed ? "展开轮次" : "折叠轮次"}
				</button>
				<button
					type="button"
					disabled={callKeys.length === 0}
					aria-pressed={allCallsCollapsed}
					onClick={() => setCollapsedCalls(allCallsCollapsed ? new Set() : new Set(callKeys))}
				>
					{allCallsCollapsed ? "展开工具" : "折叠工具"}
				</button>
				<label>
					<input
						type="checkbox"
						checked={technical}
						onChange={(event) => setTechnical(event.currentTarget.checked)}
					/>
					底层事件
				</label>
				<input
					type="search"
					aria-label="搜索轨迹"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					placeholder="搜索输入、回复、工具与结果"
				/>
			</div>
			<TrajectoryOverview
				records={records}
				actualDuration={actualDuration}
				selected={selected}
				onSelect={selectRecord}
			/>
			{state.kind === "loading" && items.length === 0 ? (
				<output className={styles.hint}>正在加载模型请求记录…</output>
			) : null}
			{state.kind === "error" ? (
				<p className={styles.error}>
					请求列表加载失败：{state.message}{" "}
					<button type="button" onClick={() => loadPage(cursor)}>
						重试
					</button>
				</p>
			) : null}
			<div className={styles.ledgerSplit}>
				<div className={styles.ledgerPane}>
					<TrajectoryLedger
						records={visible}
						allRecords={records}
						selected={selected}
						onSelect={selectRecord}
						onInspectRequest={(entry) => selectRecord(entry, "request")}
						onInspectSystem={(entry) => selectRecord(entry, "system")}
						collapsedTurns={collapsedTurns}
						collapsedCalls={collapsedCalls}
						searching={query.trim() !== ""}
						onToggleTurn={(id) =>
							setCollapsedTurns((previous) => {
								const next = new Set(previous);
								if (next.has(id)) next.delete(id);
								else next.add(id);
								return next;
							})
						}
						onToggleCall={(key) =>
							setCollapsedCalls((previous) => {
								const next = new Set(previous);
								if (next.has(key)) next.delete(key);
								else next.add(key);
								return next;
							})
						}
					/>
					{visible.length === 0 ? (
						<EmptyState
							kind="empty"
							title={records.length === 0 ? "暂无执行记录" : "没有匹配记录"}
							description="可继续加载记录或调整搜索。"
							compact
						/>
					) : null}
				</div>
				{record ? (
					<TrajectoryInspector
						key={`${record.key}:${inspectionMode}`}
						initialMode={inspectionMode}
						record={record}
						detail={detail}
						owner={owner}
						ownerDetail={ownerDetail}
						onLoadCall={loadRaw}
						onOpenOwner={
							owner === undefined
								? undefined
								: () => {
										const target = records.find((entry) => entry.kind === "model" && entry.call === owner);
										if (target) selectRecord(target, "request");
									}
						}
						onClose={() => setSelected(null)}
						previous={previousRaw?.kind === "loaded" ? previousRaw.data : undefined}
						onCompare={previousCall === undefined ? undefined : () => loadRaw(previousCall)}
					/>
				) : null}
			</div>
			<div className={styles.ledgerFooter}>
				<span>
					{visible.length} / {records.length} 条已加载记录
					{hasMoreEvents || cursor !== null ? " · 历史尚未加载完整" : ""}
				</span>
				{hasMoreEvents ? (
					<button type="button" disabled={loadingMoreEvents} onClick={onLoadMoreEvents}>
						{loadingMoreEvents ? "加载中…" : "加载更多事件"}
					</button>
				) : null}
				{cursor !== null ? (
					<button type="button" disabled={state.kind === "loading"} onClick={() => loadPage(cursor)}>
						加载更多请求
					</button>
				) : null}
			</div>
			{trace.coverage !== "complete" ? <p className={styles.hint}>{traceNotice(trace)}</p> : null}
		</section>
	);
}
