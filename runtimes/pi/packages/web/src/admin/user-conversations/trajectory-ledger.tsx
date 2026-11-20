import { type ReactNode, useEffect, useRef } from "react";
import styles from "./session-views.module.css";
import type { TrajectoryNode } from "./trajectory-model.ts";

export type TrajectoryRow = Pick<
	TrajectoryNode,
	"key" | "role" | "time" | "completedAt" | "durationMs" | "title" | "preview" | "status" | "abnormal"
>;

export function TrajectoryTable({
	label,
	children,
	orderLabel = "按开始时间排列 · 点击检查详情",
}: {
	label: string;
	children: ReactNode;
	orderLabel?: string;
}): React.ReactElement {
	return (
		<table className={styles.ledgerTable} aria-label={label}>
			<colgroup>
				<col className={styles.ledgerRoleColumn} />
				<col />
			</colgroup>
			<thead>
				<tr>
					<th>事件</th>
					<th>
						内容<span>{orderLabel}</span>
					</th>
				</tr>
			</thead>
			<tbody>{children}</tbody>
		</table>
	);
}

export function TrajectoryRecordRow({
	record,
	selected,
	onSelect,
	leading,
	previewPrefix,
	note,
	missingDuration = "—",
}: {
	record: TrajectoryRow;
	selected: boolean;
	onSelect: () => void;
	leading?: ReactNode;
	previewPrefix?: string;
	note?: string;
	missingDuration?: string;
}): React.ReactElement {
	const ref = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (selected) ref.current?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	return (
		<tr data-selected={selected} data-error={record.abnormal}>
			<td>
				<span className={`${styles.ledgerRole} ${styles[`role_${record.role}`]}`}>{record.role}</span>
			</td>
			<td>
				<div className={styles.ledgerRowContent}>
					{leading}
					<button
						type="button"
						ref={ref}
						className={styles.ledgerSelect}
						onClick={onSelect}
						aria-pressed={selected}
						title={`${record.time}\n${record.title}\n${record.preview}`}
					>
						<strong>{record.title}</strong>
						<span className={styles.ledgerPreview}>
							{previewPrefix}
							{record.preview}
						</span>
						{note && <em>{note}</em>}
						{record.abnormal && <span className={styles.ledgerFailure}>{record.status}</span>}
						<time dateTime={record.time}>
							{record.durationMs === null ? missingDuration : `${(record.durationMs / 1000).toFixed(2)} s`}
						</time>
					</button>
				</div>
			</td>
		</tr>
	);
}

export interface TrajectoryLedgerProps {
	readonly records: readonly TrajectoryNode[];
	readonly allRecords: readonly TrajectoryNode[];
	readonly selected: string | null;
	readonly onSelect: (record: TrajectoryNode) => void;
	readonly onInspectRequest?: (record: TrajectoryNode) => void;
	readonly onInspectSystem?: (record: TrajectoryNode) => void;
	readonly collapsedTurns: ReadonlySet<string>;
	readonly collapsedCalls: ReadonlySet<string>;
	readonly onToggleTurn: (turnId: string) => void;
	readonly onToggleCall: (key: string) => void;
	readonly searching: boolean;
}

export function TrajectoryLedger({
	records,
	allRecords,
	selected,
	onSelect,
	onInspectRequest,
	onInspectSystem,
	collapsedTurns,
	collapsedCalls,
	onToggleTurn,
	onToggleCall,
	searching,
}: TrajectoryLedgerProps): React.ReactElement {
	const turns = new Map<string, number>();
	const ownerByTool = new Map<string, string[]>();
	for (const record of allRecords) {
		if (record.turnId !== null && !turns.has(record.turnId)) turns.set(record.turnId, turns.size + 1);
		if (record.kind === "model")
			for (const id of record.call.toolCallIds) {
				const key = `${record.turnId}:${id}`;
				ownerByTool.set(key, [...(ownerByTool.get(key) ?? []), record.key]);
			}
	}
	const shownTurns = new Set<string>();
	const firstModel = allRecords.find((record) => record.kind === "model");
	return (
		<TrajectoryTable label="对话执行记录">
			{firstModel?.kind === "model" &&
			firstModel.call.systemPromptChars !== null &&
			firstModel.call.systemPromptChars > 0 &&
			!searching &&
			onInspectSystem ? (
				<tr>
					<td>
						<span className={`${styles.ledgerRole} ${styles.role_系统}`}>系统</span>
					</td>
					<td>
						<button className={styles.ledgerSelect} type="button" onClick={() => onInspectSystem(firstModel)}>
							<strong>{firstModel.call.callIndex === 1 ? "初始系统配置" : "首个已加载请求的系统配置"}</strong>
							<span className={styles.ledgerPreview}>系统提示词与可用工具目录</span>
						</button>
					</td>
				</tr>
			) : null}
			{records.map((record, index) => {
				const turnId = record.turnId;
				const boundary = index === 0 || records[index - 1]?.turnId !== turnId;
				const foldedTurn = !searching && turnId !== null && collapsedTurns.has(turnId);
				const first = turnId === null || !shownTurns.has(turnId);
				if (turnId !== null) shownTurns.add(turnId);
				const owners =
					record.kind === "tool" ? (ownerByTool.get(`${record.turnId}:${record.toolCallId}`) ?? []) : [];
				const foldedTool = !searching && owners.length === 1 && collapsedCalls.has(owners[0]!);
				const toolCount =
					record.kind === "model"
						? allRecords.filter(
								(entry) =>
									entry.kind === "tool" &&
									entry.turnId === record.turnId &&
									record.call.toolCallIds.includes(entry.toolCallId),
							).length
						: 0;
				return (
					<LedgerRows
						key={record.key}
						record={record}
						selected={selected}
						onSelect={onSelect}
						onInspectRequest={onInspectRequest}
						boundary={boundary && (!foldedTurn || first)}
						turnNumber={turnId === null ? null : (turns.get(turnId) ?? null)}
						turnCount={allRecords.filter((entry) => entry.turnId === turnId).length}
						foldedTurn={foldedTurn}
						hidden={foldedTurn || foldedTool}
						onToggleTurn={onToggleTurn}
						onToggleCall={onToggleCall}
						foldedCall={!searching && collapsedCalls.has(record.key)}
						toolCount={toolCount}
					/>
				);
			})}
		</TrajectoryTable>
	);
}

function LedgerRows({
	record,
	selected,
	onSelect,
	onInspectRequest,
	boundary,
	turnNumber,
	turnCount,
	foldedTurn,
	hidden,
	onToggleTurn,
	onToggleCall,
	foldedCall,
	toolCount,
}: {
	readonly record: TrajectoryNode;
	readonly selected: string | null;
	readonly onSelect: (record: TrajectoryNode) => void;
	readonly onInspectRequest?: (record: TrajectoryNode) => void;
	readonly boundary: boolean;
	readonly turnNumber: number | null;
	readonly turnCount: number;
	readonly foldedTurn: boolean;
	readonly hidden: boolean;
	readonly onToggleTurn: (id: string) => void;
	readonly onToggleCall: (key: string) => void;
	readonly foldedCall: boolean;
	readonly toolCount: number;
}): React.ReactElement {
	return (
		<>
			{boundary ? (
				<tr className={styles.ledgerTurn}>
					<td colSpan={2}>
						{record.turnId === null ? (
							"轮次之间"
						) : (
							<button type="button" onClick={() => onToggleTurn(record.turnId!)} aria-expanded={!foldedTurn}>
								{foldedTurn ? "▸" : "▾"} 第 {turnNumber} 轮{" "}
								<span>
									{turnCount} 条记录{foldedTurn ? " · 已折叠" : ""}
								</span>
							</button>
						)}
					</td>
				</tr>
			) : null}
			{!hidden ? (
				<TrajectoryRecordRow
					record={record.kind === "model" && onInspectRequest ? { ...record, title: "助手输出" } : record}
					selected={selected === record.key}
					onSelect={() => onSelect(record)}
					previewPrefix={record.kind === "model" ? "输出：" : undefined}
					note={
						record.kind === "model" && foldedCall && toolCount > 0 ? `${toolCount} 次工具执行已折叠` : undefined
					}
					missingDuration={record.kind === "tool" ? "耗时未知" : undefined}
					leading={
						<>
							{record.kind === "model" && onInspectRequest ? (
								<button
									className={styles.requestMarker}
									type="button"
									onClick={() => onInspectRequest(record)}
									aria-label={`查看请求 ${record.call.callIndex} 的运行信息`}
								>
									请求 #{record.call.callIndex}
								</button>
							) : null}
							{record.kind === "model" && toolCount > 0 ? (
								<button
									className={styles.ledgerFold}
									type="button"
									aria-label={`${foldedCall ? "展开" : "折叠"}请求 ${record.call.callIndex} 的工具`}
									aria-expanded={!foldedCall}
									onClick={() => onToggleCall(record.key)}
								>
									{foldedCall ? "▸" : "▾"}
								</button>
							) : null}
						</>
					}
				/>
			) : null}
		</>
	);
}

export function TrajectoryOverview<
	Marker extends Pick<TrajectoryNode, "key" | "time" | "completedAt" | "title" | "role">,
>({
	records,
	actualDuration,
	selected,
	onSelect,
}: {
	readonly records: readonly Marker[];
	readonly actualDuration: boolean;
	readonly selected: string | null;
	readonly onSelect: (record: Marker) => void;
}): React.ReactElement {
	const valid = records.filter((record) => Number.isFinite(Date.parse(record.time)));
	if (valid.length === 0) return <p className={styles.hint}>暂无可用的时间记录。</p>;
	const start = Math.min(...valid.map((record) => Date.parse(record.time)));
	const end = Math.max(...valid.map((record) => Date.parse(record.completedAt ?? record.time)));
	const span = Math.max(1, end - start);
	return (
		<section className={styles.timeOverview} aria-label="执行时间概览">
			<header>
				<strong>时间概览</strong>
				<span>
					{new Date(start).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} —{" "}
					{new Date(end).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} ·{" "}
					{actualDuration ? "记录时间与耗时" : "等宽记录"}
				</span>
			</header>
			{(["用户", "助手", "工具", "系统"] as const).map((role) => (
				<div className={styles.overviewLane} key={role}>
					<span>{role}</span>
					<div>
						{valid.map((record, index) => {
							if (record.role !== role) return null;
							const elapsed =
								record.completedAt === null
									? 0
									: Math.max(0, Date.parse(record.completedAt) - Date.parse(record.time));
							const left = actualDuration
								? ((Date.parse(record.time) - start) / span) * 99
								: (index / valid.length) * 100;
							const width = actualDuration ? (elapsed / span) * 99 : (100 / valid.length) * 0.85;
							return (
								<button
									type="button"
									key={record.key}
									className={`${styles.overviewBar} ${styles[`role_${role}`]}`}
									style={{ left: `${left}%`, width: `${Math.max(0.35, width)}%` }}
									data-selected={selected === record.key}
									aria-label={`定位${record.title}`}
									title={`${record.title}\n开始：${record.time}\n结束：${record.completedAt ?? "未知 / 无耗时记录"}`}
									onClick={() => onSelect(record)}
								/>
							);
						})}
					</div>
				</div>
			))}
		</section>
	);
}
