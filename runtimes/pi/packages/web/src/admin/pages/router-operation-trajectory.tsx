import { useCallback, useEffect, useState } from "react";
import type { AaasKeysApi } from "../api/aaas-keys-api.ts";
import { createStaleResponseGuard } from "../data-state.ts";
import styles from "../user-conversations/session-views.module.css";
import {
	TrajectoryOverview,
	TrajectoryRecordRow,
	type TrajectoryRow,
	TrajectoryTable,
} from "../user-conversations/trajectory-ledger.tsx";
import { errorMessage } from "./orchestration-ui.ts";
import inspector from "./router-record-inspector.module.css";
import { RouterRecordInspector } from "./router-record-inspector.tsx";

export type RouterTrajectoryOperation = {
	sequence: number;
	input: string;
	result: string | null;
	queued_at: string;
	ended_at: string | null;
};
export type RouterHistoryEvent = {
	sequence: string;
	operation_id: string | null;
	type: string;
	summary: string | null;
	context_committed: boolean | null;
	local_result?: { provider: string; is_error: boolean; output: string | null };
	created_at: string;
};

export type RouterTrajectoryCall = {
	id: string;
	kind: "model" | "mcp" | "bash";
	name: string;
	call_index: number | null;
	started_at: string;
	ended_at: string | null;
	duration_ms: number | null;
	outcome: keyof typeof outcomes;
	error_code: string | null;
	mcp_server_id: string | null;
	mcp_revision: number | null;
	bash?: { command: string | null; output: string | null };
};

type CallPage = { entries: readonly RouterTrajectoryCall[]; next_cursor: string | null };
type RouterRecord = TrajectoryRow & { call?: RouterTrajectoryCall; event?: RouterHistoryEvent };

const outcomes = {
	request_recorded: "仅记录到请求",
	response_recorded: "已记录响应",
	success: "成功",
	error: "失败",
	cancelled: "已取消",
};

export function buildRouterTrajectory(
	operation: RouterTrajectoryOperation,
	calls: readonly RouterTrajectoryCall[],
	events: readonly RouterHistoryEvent[],
): RouterRecord[] {
	const records: RouterRecord[] = [
		{
			key: "input",
			title: "用户输入",
			preview: operation.input,
			role: "用户",
			time: operation.queued_at,
			completedAt: null,
			durationMs: null,
			status: "",
			abnormal: false,
		},
	];
	for (const call of calls) {
		const model = call.kind === "model";
		records.push({
			key: call.id,
			title: model ? "模型请求" : call.name,
			preview: model
				? `${call.name} · ${outcomes[call.outcome]}`
				: call.bash?.command || call.error_code || outcomes[call.outcome],
			role: model ? "助手" : "工具",
			time: call.started_at,
			completedAt: call.ended_at,
			durationMs: call.duration_ms,
			status: outcomes[call.outcome],
			abnormal: call.outcome === "error",
			call,
		});
	}
	if (operation.result !== null && operation.ended_at !== null) {
		records.push({
			key: "result",
			title: "助手输出",
			preview: operation.result,
			role: "助手",
			time: operation.ended_at,
			completedAt: null,
			durationMs: null,
			status: "",
			abnormal: false,
		});
	}
	for (const event of events) {
		if (
			event.type === "user.message" ||
			(event.type === "assistant.message" && event.context_committed && event.summary === operation.result)
		)
			continue;
		records.push({
			key: `event:${event.sequence}`,
			title: event.type,
			preview: event.summary ?? "",
			role: event.local_result ? "工具" : "系统",
			time: event.created_at,
			completedAt: null,
			durationMs: null,
			status: event.local_result ? (event.local_result.is_error ? "失败" : "成功") : "",
			abnormal: event.type === "operation.failed" || event.local_result?.is_error === true,
			event,
		});
	}
	return records.sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

export function RouterOperationTrajectory({
	api,
	path,
	operation,
	operationId,
	events,
	historyError,
	loadingHistory,
	onLoadMoreEvents,
}: {
	api: AaasKeysApi;
	path: string;
	operation: RouterTrajectoryOperation;
	operationId: string;
	events: readonly RouterHistoryEvent[];
	historyError: string;
	loadingHistory: boolean;
	onLoadMoreEvents?: () => void;
}): React.JSX.Element {
	const [guard] = useState(createStaleResponseGuard);
	const [calls, setCalls] = useState<readonly RouterTrajectoryCall[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [actualDuration, setActualDuration] = useState(true);
	const [folded, setFolded] = useState(false);
	const [foldedTools, setFoldedTools] = useState(false);
	const [technical, setTechnical] = useState(false);
	const load = useCallback(
		(after: string | null) => {
			const ticket = guard.begin();
			setLoading(true);
			setError("");
			void api
				.request<CallPage>(
					path + (after ? `?after=${encodeURIComponent(after)}` : ""),
					"GET",
					undefined,
					ticket.signal,
				)
				.then(
					(page) =>
						ticket.commit(() => {
							setCalls((previous) => (after ? [...previous, ...page.entries] : page.entries));
							setCursor(page.next_cursor);
							setLoading(false);
						}),
					(cause: unknown) =>
						ticket.commit(() => {
							setError(errorMessage(cause));
							setLoading(false);
						}),
				);
		},
		[api, guard, path],
	);

	useEffect(() => {
		load(null);
		return () => guard.cancel();
	}, [guard, load]);

	const records = buildRouterTrajectory(operation, calls, technical ? events : []);
	const active = records.find((record) => record.key === selected);
	const result = records.find((record) => record.key === "result");
	const needle = query.trim().toLowerCase();
	const visible = records.filter((record) =>
		needle
			? `${record.title} ${record.preview} ${record.status}`.toLowerCase().includes(needle)
			: !folded && (!foldedTools || record.role !== "工具"),
	);
	const modelCount = calls.filter((call) => call.kind === "model").length;
	const toolCount = calls.length - modelCount;

	function select(key: string, role?: RouterRecord["role"]) {
		setSelected(key);
		setQuery("");
		setFolded(false);
		if (role === "工具") setFoldedTools(false);
	}

	return (
		<section className={styles.view} aria-label="执行轨迹视图">
			<header className={styles.trajectoryOverview}>
				<strong>执行轨迹</strong>
				<span>
					第 {operation.sequence} 次 Operation · {modelCount} 次模型请求 · {toolCount} 次工具执行
				</span>
			</header>
			<div className={styles.ledgerToolbar} role="toolbar" aria-label="轨迹工具栏">
				<button type="button" aria-pressed={selected === "input"} onClick={() => select("input")}>
					查看输入
				</button>
				{result ? (
					<button type="button" aria-pressed={selected === "result"} onClick={() => select(result.key)}>
						查看结果
					</button>
				) : (
					<span className={styles.hint}>尚无结果</span>
				)}
				<button type="button" aria-pressed={actualDuration} onClick={() => setActualDuration(!actualDuration)}>
					{actualDuration ? "真实耗时" : "等宽概览"}
				</button>
				<button type="button" aria-pressed={folded} onClick={() => setFolded(!folded)}>
					{folded ? "展开 Operation" : "折叠 Operation"}
				</button>
				<button
					type="button"
					disabled={toolCount === 0}
					aria-pressed={foldedTools}
					onClick={() => setFoldedTools(!foldedTools)}
				>
					{foldedTools ? "展开工具" : "折叠工具"}
				</button>
				<label>
					<input
						type="checkbox"
						checked={technical}
						onChange={(event) => setTechnical(event.currentTarget.checked)}
					/>{" "}
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
				onSelect={(record) => select(record.key, record.role)}
			/>
			{loading && calls.length === 0 && <output className={styles.hint}>正在读取调用记录…</output>}
			{error && (
				<p className={styles.error} role="alert">
					{error}{" "}
					<button type="button" onClick={() => load(cursor)}>
						重试
					</button>
				</p>
			)}
			{technical && historyError && (
				<p className={styles.error} role="alert">
					{historyError}
				</p>
			)}
			<div className={`${styles.ledgerSplit}${active ? ` ${inspector.split}` : ""}`}>
				<div className={`${styles.ledgerPane}${active ? ` ${inspector.ledger}` : ""}`}>
					<TrajectoryTable label="Router 执行记录">
						{needle === "" && (
							<tr className={styles.ledgerTurn}>
								<td colSpan={2}>
									<button type="button" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
										{folded ? "▸" : "▾"} 第 {operation.sequence} 次 Operation{" "}
										<span>{records.length} 条记录</span>
									</button>
								</td>
							</tr>
						)}
						{visible.map((record) => (
							<TrajectoryRecordRow
								key={record.key}
								record={record}
								selected={selected === record.key}
								onSelect={() => select(record.key, record.role)}
								leading={
									record.call?.kind === "model" && (
										<button
											type="button"
											className={styles.requestMarker}
											onClick={() => select(record.key, record.role)}
											aria-label={`查看请求 ${record.call.call_index} 的运行信息`}
										>
											请求 #{record.call.call_index}
										</button>
									)
								}
								missingDuration={record.role === "工具" ? "耗时未知" : undefined}
							/>
						))}
					</TrajectoryTable>
					{needle && visible.length === 0 && <p className={styles.hint}>没有匹配记录</p>}
				</div>
				{active && (
					<OperationRecordInspector
						key={active.key}
						record={active}
						operation={operation}
						operationId={operationId}
						onClose={() => setSelected(null)}
					/>
				)}
			</div>
			<div className={styles.ledgerFooter}>
				<span>
					{records.length} 条已加载记录{cursor || (technical && onLoadMoreEvents) ? " · 尚有更多记录" : ""}
				</span>
				{technical && onLoadMoreEvents && (
					<button type="button" disabled={loadingHistory} onClick={onLoadMoreEvents}>
						{loadingHistory ? "加载中…" : "加载更多事件"}
					</button>
				)}
				{cursor && !error && (
					<button type="button" disabled={loading} onClick={() => load(cursor)}>
						加载更多调用
					</button>
				)}
			</div>
		</section>
	);
}

function OperationRecordInspector({
	record,
	operation,
	operationId,
	onClose,
}: {
	record: RouterRecord;
	operation: RouterTrajectoryOperation;
	operationId: string;
	onClose: () => void;
}): React.JSX.Element {
	const { call, event } = record;
	const facts = [{ label: "记录类型", value: record.title }];
	if (call) {
		facts.push({ label: call.kind === "model" ? "模型" : "工具", value: call.name });
		facts.push({ label: "状态", value: outcomes[call.outcome] });
		if (call.call_index !== null) facts.push({ label: "请求序号", value: String(call.call_index) });
		if (call.duration_ms !== null) facts.push({ label: "耗时", value: `${call.duration_ms} ms` });
		if (call.mcp_server_id !== null) facts.push({ label: "MCP Server", value: call.mcp_server_id });
		if (call.mcp_revision !== null) facts.push({ label: "MCP 版本", value: String(call.mcp_revision) });
		if (call.error_code) facts.push({ label: "错误码", value: call.error_code });
	}
	if (event?.context_committed === false) facts.push({ label: "后续上下文", value: "未进入后续上下文" });
	if (event?.local_result) facts.push({ label: "执行环境", value: event.local_result.provider });
	if (call?.kind === "bash") facts.push({ label: "执行环境", value: "Bubblewrap" });
	const content =
		call?.kind === "bash"
			? {
					label: "Bash 命令",
					text: call.bash?.command ?? "未记录命令",
					copy: call.bash?.command != null,
					plain: true,
				}
			: record.key === "input"
				? { label: "输入内容", text: record.preview, copy: true }
				: record.key === "result"
					? { label: "输出内容", text: record.preview, copy: true }
					: event?.local_result?.output != null
						? { label: "Bash 输出（最多 4096 字符）", text: event.local_result.output, copy: true }
						: event?.summary != null
							? { label: "事件摘要", text: event.summary }
							: undefined;
	return (
		<RouterRecordInspector
			record={record}
			label="所选轨迹记录"
			scope={`第 ${operation.sequence} 轮`}
			event={event}
			operationId={operationId}
			content={content}
			output={
				call?.kind === "bash" ? (call.bash?.output ?? (call.ended_at ? "未记录输出" : "尚无执行结果")) : undefined
			}
			facts={facts}
			onClose={onClose}
		/>
	);
}
