/**
 * WB-006: administrator user-conversation detail page (SPEC §5.4).
 *
 * Tabs:
 *   - 概览: redacted header (title / app / principal / status / times), the
 *     rollover chain navigation and the latest summary body.
 *   - 事件日志 (Event Log): paged, incrementally loaded by `afterSequence`.
 *     Known event types are rendered with a payload table; unknown/new types
 *     are rendered read-only via a safe placeholder instead of crashing the
 *     page (per WB-006 禁止:未知事件不得导致整个页面崩溃).
 *   - Summary: all persisted summary snapshots, newest first.
 *
 * Entering the detail / events / summary endpoints writes audit events
 * server-side (conversation.read-transcript / read-events / read-summary).
 */
import type {
	ConversationAdminAttachmentListResponse,
	ConversationAdminEvent,
	ConversationAdminEventListResponse,
	ConversationAdminListResponse,
	ConversationAdminSummary,
	ConversationAdminSummaryEntry,
	ConversationAdminSummaryListResponse,
	ConversationExportMode,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationsApi } from "../api/conversations-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { ConfirmModal } from "../components/confirm-modal.tsx";
import { navigate } from "../router.ts";

type Tab = "overview" | "events" | "summary" | "attachments";

interface DetailData {
	readonly conversation: ConversationAdminSummary;
	readonly rollover: {
		readonly previousConversationId: string | null;
		readonly nextConversationId: string | null;
		readonly rolledOverAt: string | null;
	};
	readonly latestSummary: ConversationAdminSummaryEntry | null;
}

type DetailState = { kind: "loading" } | { kind: "loaded"; data: DetailData } | { kind: "error"; message: string };

type EventState =
	| { kind: "idle" }
	| { kind: "loading"; items: readonly ConversationAdminEvent[]; done: boolean }
	| { kind: "loaded"; items: readonly ConversationAdminEvent[]; done: boolean }
	| { kind: "error"; message: string };

type SummaryState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "loaded"; data: ConversationAdminSummaryListResponse }
	| { kind: "error"; message: string };

function statusLabel(status: string): string {
	switch (status) {
		case "active":
			return "进行中";
		case "archived":
			return "已归档";
		case "deleted":
			return "已删除";
		default:
			return status;
	}
}

export function AdminConversationDetail({ conversationId }: { conversationId: string }): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useRef(new ConversationsApi({ auth: controller })).current;
	const [tab, setTab] = useState<Tab>("overview");
	const [detail, setDetail] = useState<DetailState>({ kind: "loading" });
	const [events, setEvents] = useState<EventState>({ kind: "idle" });
	const [summaries, setSummaries] = useState<SummaryState>({ kind: "idle" });
	const [attachments, setAttachments] = useState<
		| { kind: "idle" }
		| { kind: "loading" }
		| { kind: "loaded"; data: ConversationAdminAttachmentListResponse }
		| { kind: "error"; message: string }
	>({ kind: "idle" });
	const [fullExportOpen, setFullExportOpen] = useState(false);
	const [exporting, setExporting] = useState<ConversationExportMode | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);

	const loadDetail = useCallback(() => {
		setDetail({ kind: "loading" });
		void api.getDetail(conversationId).then(
			(data) => setDetail({ kind: "loaded", data }),
			(err: Error) => setDetail({ kind: "error", message: err.message }),
		);
	}, [api, conversationId]);

	const loadEvents = useCallback(
		(afterSequence: number, keep: boolean) => {
			setEvents((prev) =>
				keep && prev.kind === "loaded"
					? { kind: "loading", items: prev.items, done: prev.done }
					: { kind: "loading", items: [], done: false },
			);
			void api.listEvents(conversationId, { limit: 50, afterSequence }).then(
				(res) => {
					setEvents((prev) => {
						const base = prev.kind === "loaded" || prev.kind === "loading" ? prev.items : [];
						const items = keep ? [...base, ...res.items] : res.items;
						return { kind: "loaded", items, done: res.nextAfterSequence === null };
					});
				},
				(err: Error) => setEvents({ kind: "error", message: err.message }),
			);
		},
		[api, conversationId],
	);

	const loadSummaries = useCallback(() => {
		setSummaries({ kind: "loading" });
		void api.listSummaries(conversationId).then(
			(data) => setSummaries({ kind: "loaded", data }),
			(err: Error) => setSummaries({ kind: "error", message: err.message }),
		);
	}, [api, conversationId]);

	useEffect(() => {
		setTab("overview");
		setEvents({ kind: "idle" });
		setSummaries({ kind: "idle" });
		setAttachments({ kind: "idle" });
		setExportError(null);
		loadDetail();
	}, [loadDetail]);

	useEffect(() => {
		if (tab === "events" && events.kind === "idle") loadEvents(0, false);
		if (tab === "summary" && summaries.kind === "idle") loadSummaries();
		if (tab === "attachments" && attachments.kind === "idle") {
			setAttachments({ kind: "loading" });
			void api.listAttachments(conversationId).then(
				(data) => setAttachments({ kind: "loaded", data }),
				(err: Error) => setAttachments({ kind: "error", message: err.message }),
			);
		}
	}, [api, attachments.kind, conversationId, events.kind, loadEvents, loadSummaries, summaries.kind, tab]);

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

	const onNextEvents = () => {
		if (events.kind === "loaded" && events.items.length > 0) {
			const last = events.items[events.items.length - 1]!;
			loadEvents(last.sequence, true);
		}
	};

	return (
		<section>
			<ConfirmModal
				open={fullExportOpen}
				title="确认完整导出"
				body="完整包包含会话正文和工具载荷等敏感内容。导出操作会写入审计日志。"
				confirmLabel={exporting === "full" ? "导出中…" : "确认并下载"}
				typeToConfirm="完整导出"
				onConfirm={() => downloadExport("full")}
				onCancel={() => setFullExportOpen(false)}
			/>
			<nav className="detail-breadcrumb">
				<button type="button" onClick={() => navigate("/conversations")}>
					← 返回会话列表
				</button>
			</nav>
			{detail.kind === "loading" && <p>加载中…</p>}
			{detail.kind === "error" && (
				<div className="banner error">
					加载失败：{detail.message}{" "}
					<button type="button" onClick={loadDetail}>
						重试
					</button>
				</div>
			)}
			{detail.kind === "loaded" && (
				<>
					<div className="conversation-detail-heading">
						<h1>{detail.data.conversation.title || "（无标题）"}</h1>
						<div className="conversation-export-actions">
							<button
								type="button"
								disabled={exporting !== null}
								onClick={() => void downloadExport("diagnostics")}
							>
								导出诊断包
							</button>
							<button
								type="button"
								disabled={exporting !== null}
								onClick={() => void downloadExport("transcript")}
							>
								导出 Transcript
							</button>
							<button type="button" disabled={exporting !== null} onClick={() => setFullExportOpen(true)}>
								完整导出…
							</button>
						</div>
					</div>
					{exportError !== null && <div className="banner error">导出失败：{exportError}</div>}
					<p className="conversation-meta">
						{detail.data.conversation.id} · {detail.data.conversation.appName} · 状态{" "}
						{statusLabel(detail.data.conversation.status)} · 主体 {detail.data.conversation.principalDisplayId}
					</p>
					<RolloverNav rollover={detail.data.rollover} />

					<div className="detail-tabs" role="tablist">
						<button
							type="button"
							role="tab"
							aria-selected={tab === "overview"}
							onClick={() => setTab("overview")}
						>
							概览
						</button>
						<button type="button" role="tab" aria-selected={tab === "events"} onClick={() => setTab("events")}>
							事件日志
						</button>
						<button type="button" role="tab" aria-selected={tab === "summary"} onClick={() => setTab("summary")}>
							Summary
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab === "attachments"}
							onClick={() => setTab("attachments")}
						>
							附件
						</button>
					</div>

					{tab === "overview" && <Overview conversation={detail.data.conversation} />}
					{tab === "events" && (
						<EventLogTab state={events} onLoadMore={onNextEvents} reload={() => loadEvents(0, false)} />
					)}
					{tab === "summary" && <SummaryTab state={summaries} reload={loadSummaries} />}
					{tab === "attachments" && <AttachmentsTab state={attachments} />}
				</>
			)}
		</section>
	);
}

function RolloverNav({
	rollover,
}: {
	readonly rollover: { readonly previousConversationId: string | null; readonly nextConversationId: string | null };
}): React.ReactElement | null {
	if (rollover.previousConversationId === null && rollover.nextConversationId === null) return null;
	return (
		<nav className="rollover-nav">
			{rollover.previousConversationId !== null && (
				<button type="button" onClick={() => navigate(`/conversations/${rollover.previousConversationId}`)}>
					← 上一段（续接来源）
				</button>
			)}
			{rollover.nextConversationId !== null && (
				<button type="button" onClick={() => navigate(`/conversations/${rollover.nextConversationId}`)}>
					→ 下一段（续接目标）
				</button>
			)}
		</nav>
	);
}

function Overview({ conversation }: { readonly conversation: ConversationAdminSummary }): React.ReactElement {
	const rows: readonly { readonly k: string; readonly v: string }[] = [
		{ k: "会话 ID", v: conversation.id },
		{ k: "应用", v: `${conversation.appName} (${conversation.publicAppId})` },
		{ k: "Agent", v: conversation.agentId.length === 0 ? "（未知）" : conversation.agentId },
		{ k: "主体", v: conversation.principalDisplayId },
		{ k: "消息数", v: String(conversation.messageCount) },
		{ k: "错误数", v: String(conversation.errorCount) },
		{ k: "最后序号", v: String(conversation.lastEventSequence) },
		{ k: "创建时间", v: new Date(conversation.createdAt).toLocaleString() },
		{ k: "最后活跃", v: new Date(conversation.lastActiveAt).toLocaleString() },
	];
	return (
		<div className="card">
			<table>
				<tbody>
					{rows.map((r) => (
						<tr key={r.k}>
							<td>{r.k}</td>
							<td>{r.v}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function EventLogTab({
	state,
	onLoadMore,
	reload,
}: {
	readonly state: EventState;
	readonly onLoadMore: () => void;
	readonly reload: () => void;
}): React.ReactElement {
	return (
		<div className="card">
			{state.kind === "loading" && <p>加载中…</p>}
			{state.kind === "error" && (
				<div className="banner error">
					加载失败：{state.message}{" "}
					<button type="button" onClick={reload}>
						重试
					</button>
				</div>
			)}
			{state.kind === "loaded" && (
				<>
					<table className="evt-table">
						<thead>
							<tr>
								<th>序号</th>
								<th>类型</th>
								<th>Kind</th>
								<th>载荷（安全只读）</th>
							</tr>
						</thead>
						<tbody>
							{state.items.map((event) => (
								<tr key={event.sequence}>
									<td>{event.sequence}</td>
									<td>{event.eventType}</td>
									<td>{event.kind}</td>
									<td>
										<SafePayload payload={event.payload} />
									</td>
								</tr>
							))}
							{state.items.length === 0 && (
								<tr>
									<td colSpan={4} className="empty-cell">
										暂无事件
									</td>
								</tr>
							)}
						</tbody>
					</table>
					{!state.done && state.items.length > 0 && (
						<button type="button" onClick={onLoadMore}>
							加载更多
						</button>
					)}
				</>
			)}
		</div>
	);

	/* Satisfy the "unknown event must not crash the page" requirement: */
}

function SafePayload({ payload }: { readonly payload: unknown }): React.ReactElement {
	try {
		if (typeof payload === "string") return <code className="preview-code">{payload}</code>;
		return <code className="preview-code">{JSON.stringify(payload)}</code>;
	} catch {
		return <span className="unknown-event">（不可渲染的载荷）</span>;
	}
}

function AttachmentsTab({
	state,
}: {
	readonly state:
		| { kind: "idle" }
		| { kind: "loading" }
		| { kind: "loaded"; data: ConversationAdminAttachmentListResponse }
		| { kind: "error"; message: string };
}): React.ReactElement {
	return (
		<div className="card">
			{state.kind === "loading" && <p>加载中…</p>}
			{state.kind === "error" && <div className="banner error">加载失败：{state.message}</div>}
			{state.kind === "loaded" &&
				(state.data.items.length === 0 ? (
					<p>该会话暂无附件。</p>
				) : (
					<table className="evt-table">
						<thead>
							<tr>
								<th>文件名</th>
								<th>类型</th>
								<th>大小</th>
								<th>状态</th>
								<th>上传时间</th>
							</tr>
						</thead>
						<tbody>
							{state.data.items.map((a) => (
								<tr key={a.attachmentId}>
									<td>{a.filename}</td>
									<td>{a.contentType}</td>
									<td>{formatBytes(a.sizeBytes)}</td>
									<td>{a.status}</td>
									<td>{new Date(a.createdAt).toLocaleString()}</td>
								</tr>
							))}
						</tbody>
					</table>
				))}
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SummaryTab({
	state,
	reload,
}: {
	readonly state: SummaryState;
	readonly reload: () => void;
}): React.ReactElement {
	return (
		<div className="card">
			{state.kind === "loading" && <p>加载中…</p>}
			{state.kind === "error" && (
				<div className="banner error">
					加载失败：{state.message}{" "}
					<button type="button" onClick={reload}>
						重试
					</button>
				</div>
			)}
			{state.kind === "loaded" &&
				(state.data.items.length === 0 ? (
					<p>暂无 Summary（尚未触发续接或未到达阈值）。</p>
				) : (
					state.data.items.map((entry) => <SummaryCard key={entry.summaryId} entry={entry} />)
				))}
		</div>
	);
}

function SummaryCard({ entry }: { readonly entry: ConversationAdminSummaryEntry }): React.ReactElement {
	return (
		<div className="summary-card">
			<h3>到达序号 {entry.throughSequence}</h3>
			<p className="conversation-meta">
				生成于 {new Date(entry.createdAt).toLocaleString()} · 涵盖 {entry.sourceEventCount} 事件 ·{" "}
				{entry.sourceBytes} 字节
			</p>
			<p>
				最近用户消息：<strong>{entry.lastUserMessage || "（空）"}</strong>
			</p>
			{entry.keyFacts.length > 0 && (
				<p>
					关键事实：<code className="preview-code">{entry.keyFacts.join("；")}</code>
				</p>
			)}
			{entry.openItems.length > 0 && (
				<p>
					未完成事项：<code className="preview-code">{entry.openItems.join("；")}</code>
				</p>
			)}
		</div>
	);
}

export type { ConversationAdminEventListResponse, ConversationAdminListResponse };
