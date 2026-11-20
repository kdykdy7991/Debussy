import { useState } from "react";
import { formatBeijing } from "../beijing-time.ts";
import styles from "../user-conversations/session-views.module.css";
import {
	TrajectoryOverview,
	TrajectoryRecordRow,
	type TrajectoryRow,
	TrajectoryTable,
} from "../user-conversations/trajectory-ledger.tsx";
import type { RouterHistoryEvent } from "./router-operation-trajectory.tsx";
import inspector from "./router-record-inspector.module.css";
import { RouterRecordInspector } from "./router-record-inspector.tsx";

const eventLabels: Record<string, string> = {
	"task.created": "创建任务",
	"task.canceled": "取消任务",
	"task.cleanup_completed": "清理完成",
	"user.message": "用户输入",
	"assistant.message": "助手输出",
	"tool.call": "调用工具",
	"tool.result": "工具返回",
	"operation.accepted": "受理执行",
	"operation.queued": "进入队列",
	"operation.started": "开始执行",
	"operation.progress": "更新进度",
	"operation.completed": "执行完成",
	"operation.failed": "执行失败",
	"operation.canceled": "执行取消",
	"context.committed": "提交上下文",
};

type HistoryRecord = TrajectoryRow & { event: RouterHistoryEvent; scope: string };

export function RouterTaskHistory({
	events,
	operations,
	loading,
	error,
	onRetry,
	onLoadMore,
}: {
	events: readonly RouterHistoryEvent[];
	operations: readonly { id: string; sequence: number }[];
	loading: boolean;
	error: string;
	onRetry: () => void;
	onLoadMore?: () => void;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [actualTime, setActualTime] = useState(false);
	const numbers = new Map(operations.map(({ id, sequence }) => [id, sequence]));
	const needle = query.trim().toLowerCase();
	const records = events
		.map((event) => {
			const number = event.operation_id === null ? undefined : numbers.get(event.operation_id);
			const scope = event.operation_id === null ? "Task" : number === undefined ? "Operation" : `第 ${number} 轮`;
			const role = event.type.startsWith("tool.")
				? "工具"
				: event.type === "user.message"
					? "用户"
					: event.type === "assistant.message"
						? "助手"
						: "系统";
			const row: TrajectoryRow = {
				key: event.sequence,
				title: eventLabels[event.type] ?? event.type,
				preview: event.summary ?? "",
				role,
				time: event.created_at,
				completedAt: null,
				durationMs: null,
				abnormal: event.type === "operation.failed",
				status: event.type === "operation.failed" ? "失败" : "",
			};
			return { ...row, event, scope };
		})
		.filter(({ title, preview, scope, event }) =>
			[title, preview, scope, event.type, event.sequence, event.operation_id].some((value) =>
				value?.toLowerCase().includes(needle),
			),
		);
	const active = records.find((record) => record.key === selected);

	return (
		<section className={styles.view} aria-label="Task 时间线">
			<header className={styles.trajectoryOverview}>
				<strong>Task 时间线</strong>
				<span>{records.length} 条可见事件</span>
			</header>
			<div className={styles.ledgerToolbar} role="toolbar" aria-label="Task 时间线工具栏">
				<button type="button" aria-pressed={actualTime} onClick={() => setActualTime(!actualTime)}>
					{actualTime ? "实际时间" : "等宽概览"}
				</button>
				<input
					type="search"
					aria-label="搜索Task 时间线"
					placeholder="搜索事件、内容或 Operation ID"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
				/>
			</div>
			{records.length > 0 && (
				<TrajectoryOverview
					records={records}
					actualDuration={actualTime}
					selected={selected}
					onSelect={(record) => setSelected(record.key)}
				/>
			)}
			{error && (
				<p className={styles.error} role="alert">
					{error}{" "}
					<button type="button" onClick={onRetry}>
						重试
					</button>
				</p>
			)}
			{!loading && !error && records.length === 0 && (
				<p className={styles.hint}>{needle ? "已加载事件中没有匹配记录。" : "暂无任务事件。"}</p>
			)}
			{records.length > 0 && (
				<div className={`${styles.ledgerSplit}${active ? ` ${inspector.split}` : ""}`}>
					<div className={`${styles.ledgerPane}${active ? ` ${inspector.ledger}` : ""}`}>
						<TrajectoryTable label="Task 事件记录" orderLabel="按事件序号排列 · 点击检查详情">
							{records.map((record) => (
								<TrajectoryRecordRow
									key={record.key}
									record={record}
									selected={record.key === selected}
									onSelect={() => setSelected(record.key)}
									missingDuration={formatBeijing(record.time).split(" ").at(-1)}
								/>
							))}
						</TrajectoryTable>
					</div>
					{active && <HistoryInspector key={active.key} record={active} onClose={() => setSelected(null)} />}
				</div>
			)}
			<div className={styles.ledgerFooter}>
				<span>{loading ? "正在读取Task 时间线…" : `${events.length} 条已加载事件`}</span>
				{onLoadMore && !error && (
					<button type="button" disabled={loading} onClick={onLoadMore}>
						加载更多事件
					</button>
				)}
			</div>
		</section>
	);
}

function HistoryInspector({ record, onClose }: { record: HistoryRecord; onClose: () => void }): React.JSX.Element {
	const { event, scope, title, role } = record;
	const contentLabel =
		role === "用户" ? "输入内容" : role === "助手" ? "输出内容" : role === "工具" ? "工具名称" : "事件摘要";
	return (
		<RouterRecordInspector
			record={record}
			label="所选任务事件"
			scope={scope}
			event={event}
			operationId={event.operation_id}
			content={event.summary === null ? undefined : { label: contentLabel, text: event.summary }}
			facts={[
				{ label: "事件归属", value: event.operation_id === null ? "Task 级事件" : `${scope} · ${role}` },
				{ label: "事件类型", value: title },
				...(event.context_committed === null
					? []
					: [{ label: "后续上下文", value: event.context_committed ? "已提交" : "未进入后续上下文" }]),
			]}
			onClose={onClose}
		/>
	);
}
