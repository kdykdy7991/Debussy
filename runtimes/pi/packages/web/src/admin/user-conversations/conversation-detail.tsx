import type {
	ConversationAdminEvent,
	ConversationAdminEventListResponse,
	ConversationAdminListResponse,
	ConversationAdminSummary,
	ConversationExportMode,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationsApi } from "../api/conversations-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { ConfirmModal } from "../components/confirm-modal.tsx";
import { navigate } from "../router.ts";
import styles from "./conversation-detail.module.css";

interface DetailData {
	readonly conversation: ConversationAdminSummary;
	readonly rollover: {
		readonly previousConversationId: string | null;
		readonly nextConversationId: string | null;
		readonly rolledOverAt: string | null;
	};
}

type DetailState = { kind: "loading" } | { kind: "loaded"; data: DetailData } | { kind: "error"; message: string };
type EventState =
	| { kind: "loading" }
	| { kind: "loaded"; items: readonly ConversationAdminEvent[] }
	| { kind: "error"; message: string };

type TimelineKind = "user" | "assistant" | "tool" | "error";
interface TimelineItem {
	readonly event: ConversationAdminEvent;
	readonly kind: TimelineKind;
	readonly label: string;
	readonly text: string;
}

export function AdminConversationDetail({ conversationId }: { conversationId: string }): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useRef(new ConversationsApi({ auth: controller })).current;
	const [detail, setDetail] = useState<DetailState>({ kind: "loading" });
	const [events, setEvents] = useState<EventState>({ kind: "loading" });
	const [query, setQuery] = useState("");
	const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
	const [fullExportOpen, setFullExportOpen] = useState(false);
	const [exporting, setExporting] = useState<ConversationExportMode | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);

	const load = useCallback(() => {
		setDetail({ kind: "loading" });
		setEvents({ kind: "loading" });
		void Promise.all([
			api.getDetail(conversationId),
			api.listEvents(conversationId, { limit: 500, afterSequence: 0 }),
		]).then(
			([detailData, eventData]) => {
				setDetail({ kind: "loaded", data: detailData });
				setEvents({ kind: "loaded", items: eventData.items });
				const firstFailure = eventData.items.find((event) => isErrorEvent(event));
				setSelectedSequence(firstFailure?.sequence ?? null);
			},
			(error: Error) => {
				setDetail({ kind: "error", message: error.message });
				setEvents({ kind: "error", message: error.message });
			},
		);
	}, [api, conversationId]);

	useEffect(() => {
		load();
	}, [load]);

	const downloadExport = useCallback(
		async (mode: ConversationExportMode): Promise<void> => {
			setExporting(mode);
			setExportError(null);
			try {
				const blob = await api.downloadExport(conversationId, mode);
				const url = URL.createObjectURL(blob);
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = `conversation-${conversationId}-${mode}.jsonl.gz`;
				anchor.click();
				URL.revokeObjectURL(url);
				setFullExportOpen(false);
			} catch (error) {
				setExportError(error instanceof Error ? error.message : String(error));
			} finally {
				setExporting(null);
			}
		},
		[api, conversationId],
	);

	const timeline = useMemo(() => {
		if (events.kind !== "loaded") return [];
		const needle = query.trim().toLowerCase();
		return events.items
			.map(toTimelineItem)
			.filter((item): item is TimelineItem => item !== null)
			.filter((item) => needle === "" || item.text.toLowerCase().includes(needle));
	}, [events, query]);
	const selectedEvent =
		events.kind === "loaded" ? (events.items.find((event) => event.sequence === selectedSequence) ?? null) : null;
	const modelId = events.kind === "loaded" ? readModel(events.items) : "—";

	return (
		<section className={styles.page}>
			<ConfirmModal
				open={fullExportOpen}
				title="确认完整导出"
				body="完整包包含会话正文和工具载荷等敏感内容。导出操作会写入审计日志。"
				confirmLabel={exporting === "full" ? "导出中…" : "确认并下载"}
				typeToConfirm="完整导出"
				onConfirm={() => downloadExport("full")}
				onCancel={() => setFullExportOpen(false)}
			/>
			<div className={styles.topLine}>
				<button type="button" className={styles.back} onClick={() => navigate("/conversations")}>
					←&nbsp; 返回 Session 日志列表
				</button>
				<button type="button" className={styles.refresh} onClick={load}>
					<Icon name="refresh" />
					刷新
				</button>
			</div>
			<div className={styles.titleRow}>
				<h1>Session 详情</h1>
				<div className={styles.actions}>
					<select aria-label="时间范围">
						<option>全部时间</option>
					</select>
					<button type="button" disabled={exporting !== null} onClick={() => void downloadExport("transcript")}>
						导出日志
					</button>
				</div>
			</div>
			{exportError ? <div className={styles.errorBanner}>导出失败：{exportError}</div> : null}
			{detail.kind === "loading" ? <p className={styles.loading}>加载中…</p> : null}
			{detail.kind === "error" ? (
				<div className={styles.errorBanner}>
					加载失败：{detail.message}
					<button type="button" onClick={load}>
						重试
					</button>
				</div>
			) : null}
			{detail.kind === "loaded" ? (
				<LoadedDetail
					data={detail.data}
					modelId={modelId}
					timeline={timeline}
					eventState={events}
					query={query}
					onQuery={setQuery}
					selectedSequence={selectedSequence}
					onSelect={setSelectedSequence}
					selectedEvent={selectedEvent}
					onFullExport={() => setFullExportOpen(true)}
				/>
			) : null}
		</section>
	);
}

function LoadedDetail({
	data,
	modelId,
	timeline,
	eventState,
	query,
	onQuery,
	selectedSequence,
	onSelect,
	selectedEvent,
}: {
	readonly data: DetailData;
	readonly modelId: string;
	readonly timeline: readonly TimelineItem[];
	readonly eventState: EventState;
	readonly query: string;
	readonly onQuery: (value: string) => void;
	readonly selectedSequence: number | null;
	readonly onSelect: (sequence: number) => void;
	readonly selectedEvent: ConversationAdminEvent | null;
	readonly onFullExport: () => void;
}): React.ReactElement {
	const conversation = data.conversation;
	return (
		<>
			<div className={styles.summaryGrid}>
				<InfoCard title="会话信息">
					<Info label="会话 ID" value={conversation.id} copy />
					<Info label="创建时间" value={formatDate(conversation.createdAt)} />
					<Info label="状态" value={statusLabel(conversation.status)} status />
					<Info label="最后活跃时间" value={formatDate(conversation.lastActiveAt)} />
					<Info label="用户标识" value={conversation.principalDisplayId} />
					<Info label="会话时长" value={duration(conversation.createdAt, conversation.lastActiveAt)} />
				</InfoCard>
				<InfoCard title="运行配置">
					<Info label="应用" value={conversation.appName} />
					<Info label="实际模型" value={modelId} />
					<Info label="Agent" value={conversation.agentId || "—"} />
					<Info label="思考强度" value="—" />
					<Info label="Agent 版本" value="—" />
				</InfoCard>
			</div>
			<div className={styles.workspace}>
				<div className={styles.timelinePanel}>
					<div className={styles.timelineHeader}>
						<strong>对话时间线</strong>
						<span>共 {conversation.messageCount} 条消息</span>
						<label>
							<Icon name="search" />
							<input
								value={query}
								onChange={(event) => onQuery(event.currentTarget.value)}
								placeholder="搜索消息内容"
							/>
						</label>
						<button type="button">
							<Icon name="calendar" />
							跳转到
						</button>
					</div>
					<div className={styles.timelineBody}>
						<aside>
							<strong>全部时间</strong>
							<span>
								今天
								<br />
								{timeline.length} 条
							</span>
						</aside>
						<main>
							<div className={styles.dayTitle}>{formatDay(conversation.lastActiveAt)}</div>
							{eventState.kind === "loading" ? <p className={styles.loading}>加载消息中…</p> : null}
							{eventState.kind === "error" ? (
								<div className={styles.errorBanner}>{eventState.message}</div>
							) : null}
							{timeline.map((item) => (
								<TimelineRow
									key={item.event.sequence}
									item={item}
									selected={selectedSequence === item.event.sequence}
									onSelect={() => onSelect(item.event.sequence)}
								/>
							))}
							{eventState.kind === "loaded" && timeline.length === 0 ? (
								<p className={styles.empty}>暂无消息</p>
							) : null}
						</main>
					</div>
				</div>
				<DetailPanel event={selectedEvent} />
			</div>
		</>
	);
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
	return (
		<section className={styles.infoCard}>
			<h2>{title}</h2>
			<div>{children}</div>
		</section>
	);
}
function Info({
	label,
	value,
	copy = false,
	status = false,
}: {
	label: string;
	value: string;
	copy?: boolean;
	status?: boolean;
}): React.ReactElement {
	return (
		<div className={styles.info}>
			<span>{label}</span>
			<strong className={status ? styles.infoStatus : ""}>{value}</strong>
			{copy ? (
				<button type="button" onClick={() => void navigator.clipboard.writeText(value)} aria-label="复制会话 ID">
					□
				</button>
			) : null}
		</div>
	);
}

function TimelineRow({
	item,
	selected,
	onSelect,
}: {
	item: TimelineItem;
	selected: boolean;
	onSelect: () => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			className={`${styles.messageRow} ${item.kind === "error" ? styles.messageError : ""} ${selected ? styles.messageSelected : ""}`}
			onClick={onSelect}
		>
			<time>
				{new Date(item.event.createdAt).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
				})}
			</time>
			<div className={`${styles.avatar} ${styles[`avatar${item.kind[0]!.toUpperCase()}${item.kind.slice(1)}`]}`}>
				{item.kind === "user" ? "人" : item.kind === "tool" ? "T" : "A"}
			</div>
			<div className={styles.messageContent}>
				<div>
					<strong>{item.label}</strong>
					<span className={item.kind === "error" ? styles.failed : styles.success}>
						{item.kind === "error" ? "失败" : "成功"}
					</span>
				</div>
				<p>{item.text}</p>
				{item.kind === "error" ? <ErrorInline event={item.event} /> : null}
			</div>
			<span className={styles.expand}>⌄</span>
		</button>
	);
}

function ErrorInline({ event }: { event: ConversationAdminEvent }): React.ReactElement {
	const payload = asRecord(event.payload);
	return (
		<div className={styles.errorInline}>
			<span>
				错误类型<strong>{readString(payload, "error_type") || "TurnError"}</strong>
			</span>
			<span>
				错误信息<strong>{errorText(event)}</strong>
			</span>
			<span>
				发生时间<strong>{formatDate(event.createdAt)}</strong>
			</span>
		</div>
	);
}

function DetailPanel({ event }: { event: ConversationAdminEvent | null }): React.ReactElement {
	if (event === null)
		return (
			<aside className={styles.detailPanel}>
				<h2>消息详情</h2>
				<p className={styles.empty}>选择一条消息查看详情</p>
			</aside>
		);
	const error = isErrorEvent(event);
	return (
		<aside className={styles.detailPanel}>
			<h2>{error ? "错误详情" : "消息详情"}</h2>
			<dl>
				<dt>事件位置</dt>
				<dd>{event.eventType}</dd>
				<dt>事件类型</dt>
				<dd>{event.kind}</dd>
				<dt>发生时间</dt>
				<dd>{formatDate(event.createdAt)}</dd>
				{error ? (
					<>
						<dt>错误信息</dt>
						<dd>{errorText(event)}</dd>
					</>
				) : null}
			</dl>
			<Technical title="技术详情" value={event.payload} />
			<Technical
				title="消息信息"
				value={{
					eventId: event.eventId,
					sequence: event.sequence,
					turnId: event.turnId,
					payloadBytes: event.payloadBytes,
				}}
			/>
		</aside>
	);
}

function Technical({ title, value }: { title: string; value: unknown }): React.ReactElement {
	return (
		<details className={styles.technical} open>
			<summary>
				{title}
				<span>⌃</span>
			</summary>
			<pre>{safeJson(value)}</pre>
		</details>
	);
}

function toTimelineItem(event: ConversationAdminEvent): TimelineItem | null {
	if (event.eventType === "user/message")
		return { event, kind: "user", label: "用户", text: payloadText(event.payload) };
	if (event.eventType === "assistant/message")
		return { event, kind: "assistant", label: "Agent", text: payloadText(event.payload) };
	if (event.eventType === "tool/call" || event.eventType === "tool/result")
		return { event, kind: "tool", label: "工具", text: payloadText(event.payload) };
	if (isErrorEvent(event)) return { event, kind: "error", label: "Agent", text: errorText(event) };
	return null;
}

function isErrorEvent(event: ConversationAdminEvent): boolean {
	return event.eventType === "turn/failed" || event.eventType === "tool/error" || event.kind === "unknown";
}
function payloadText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	const record = asRecord(payload);
	return readString(record, "text") || readString(record, "message") || safeJson(payload);
}
function errorText(event: ConversationAdminEvent): string {
	const record = asRecord(event.payload);
	const nested = asRecord(record.error);
	return (
		readString(record, "error") ||
		readString(record, "message") ||
		readString(nested, "message") ||
		safeJson(event.payload)
	);
}
function readModel(events: readonly ConversationAdminEvent[]): string {
	const start = events.find((event) => event.eventType === "turn/start");
	return readString(asRecord(start?.payload), "model") || "—";
}
function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function readString(record: Record<string, unknown>, key: string): string {
	return typeof record[key] === "string" ? record[key] : "";
}
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return "（不可展示）";
	}
}
function formatDate(value: string): string {
	return new Date(value).toLocaleString();
}
function formatDay(value: string): string {
	return new Date(value).toLocaleDateString(undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		weekday: "short",
	});
}
function duration(start: string, end: string): string {
	const milliseconds = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
	const minutes = Math.floor(milliseconds / 60000);
	return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 时 ${minutes % 60} 分`;
}
function statusLabel(status: string): string {
	if (status === "active") return "进行中";
	if (status === "archived") return "已结束";
	if (status === "deleted") return "已删除";
	return status;
}

function Icon({ name }: { name: "search" | "calendar" | "refresh" }): React.ReactElement {
	const paths = {
		search: (
			<>
				<circle cx="11" cy="11" r="7" />
				<path d="m20 20-4-4" />
			</>
		),
		calendar: (
			<>
				<rect x="3" y="5" width="18" height="16" rx="2" />
				<path d="M16 3v4M8 3v4M3 10h18" />
			</>
		),
		refresh: (
			<>
				<path d="M20 11a8 8 0 1 0-2.34 5.66" />
				<path d="M20 5v6h-6" />
			</>
		),
	};
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			{paths[name]}
		</svg>
	);
}

export type { ConversationAdminEventListResponse, ConversationAdminListResponse };
