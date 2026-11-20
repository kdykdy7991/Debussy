import type {
	ConversationAdminDetailResponse,
	ConversationAdminEvent,
	ConversationAdminEventListResponse,
	ConversationAdminListResponse,
	ConversationExportMode,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationsApi } from "../api/conversations-api.ts";
import { AuroraPillTabs } from "../aurora/PillTabs.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { formatBeijing } from "../beijing-time.ts";
import { ConfirmModal } from "../components/confirm-modal.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { createStaleResponseGuard } from "../data-state.ts";
import { WORK_STATUS } from "../pages/orchestration-ui.ts";
import { navigate } from "../router.ts";
import styles from "./conversation-detail.module.css";
import { Info, InfoCard } from "./execution-info.tsx";
import { TrajectoryView } from "./trajectory-view.tsx";
import { UsageView } from "./usage-view.tsx";

type DetailData = ConversationAdminDetailResponse;
type SessionTab = "trajectory" | "usage";

type DetailState = { kind: "loading" } | { kind: "loaded"; data: DetailData } | { kind: "error"; message: string };
interface EventPageState {
	readonly kind: "loading" | "loaded" | "error";
	readonly message?: string;
	readonly items: readonly ConversationAdminEvent[];
	readonly nextAfterSequence: number | null;
}
const EMPTY_EVENT_PAGE: EventPageState = { kind: "loading", items: [], nextAfterSequence: null };

export function AdminConversationDetail({ conversationId }: { conversationId: string }): React.ReactElement {
	const { dialog, ...dialogs } = useDialogs();
	const { controller } = useAdminAuth();
	const api = useRef(new ConversationsApi({ auth: controller })).current;
	const guardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (guardRef.current === null) guardRef.current = createStaleResponseGuard();
	const guard = guardRef.current;
	const [detail, setDetail] = useState<DetailState>({ kind: "loading" });
	const [eventPage, setEventPage] = useState<EventPageState>(EMPTY_EVENT_PAGE);
	const [tab, setTab] = useState<SessionTab>("trajectory");
	const [loadingMore, setLoadingMore] = useState(false);
	const [fullExportOpen, setFullExportOpen] = useState(false);
	const [exporting, setExporting] = useState<ConversationExportMode | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	const [lifecycleBusy, setLifecycleBusy] = useState<"archive" | "delete" | null>(null);

	const load = useCallback(() => {
		const ticket = guard.begin();
		setDetail({ kind: "loading" });
		setEventPage(EMPTY_EVENT_PAGE);
		void Promise.all([
			api.getDetail(conversationId, ticket.signal),
			api.listEvents(conversationId, { limit: 200 }, ticket.signal),
		]).then(
			([detailData, firstPage]) => {
				ticket.commit(() => {
					setDetail({ kind: "loaded", data: detailData });
					setEventPage({
						kind: "loaded",
						items: firstPage.items,
						nextAfterSequence: firstPage.nextAfterSequence,
					});
				});
			},
			(error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				ticket.commit(() => {
					setDetail({ kind: "error", message });
					setEventPage({ kind: "error", message, items: [], nextAfterSequence: null });
				});
			},
		);
	}, [api, conversationId, guard]);

	useEffect(() => {
		load();
		return () => guard.cancel();
	}, [load, guard]);

	/** Append the next page; previously loaded events are always kept. */
	const loadMoreEvents = useCallback(() => {
		if (eventPage.kind !== "loaded" || eventPage.nextAfterSequence === null || loadingMore) return;
		const after = eventPage.nextAfterSequence;
		setLoadingMore(true);
		void api
			.listEvents(conversationId, { limit: 200, afterSequence: after })
			.then((page) => {
				setEventPage((previous) =>
					previous.kind === "loaded"
						? {
								kind: "loaded",
								items: [...previous.items, ...page.items],
								nextAfterSequence: page.nextAfterSequence,
							}
						: previous,
				);
			})
			.catch((error: unknown) => {
				setExportError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => setLoadingMore(false));
	}, [api, conversationId, eventPage, loadingMore]);

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
				if (mode === "full") throw error;
			} finally {
				setExporting(null);
			}
		},
		[api, conversationId],
	);

	const modelId = eventPage.kind === "loaded" ? readModel(eventPage.items) : "—";
	const updateLifecycle = async (action: "archive" | "delete") => {
		const message =
			action === "archive"
				? "结束后用户将不能继续在此会话中发送消息，确定结束会话吗？"
				: "删除后会话会标记为已删除，但审计记录仍会保留。确定删除吗？";
		if (
			!(await dialogs.confirm(message, {
				title: action === "archive" ? "结束会话" : "删除会话",
				confirmLabel: action === "archive" ? "确认结束" : "确认删除",
				destructive: true,
			}))
		)
			return;
		setLifecycleBusy(action);
		setExportError(null);
		try {
			if (action === "archive") await api.archive(conversationId);
			else await api.delete(conversationId);
			load();
		} catch (error) {
			setExportError(error instanceof Error ? error.message : String(error));
		} finally {
			setLifecycleBusy(null);
		}
	};

	return (
		<section className={styles.page}>
			{dialog}
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
				<button type="button" className={styles.back} onClick={() => {
					const origin = detail.kind === "loaded" ? detail.data.conversation.origin : undefined;
					navigate(origin === "aaas_key" ? "/conversations/aaas" : origin === "integration" ? "/conversations/integration" : "/conversations");
				}}>
					←&nbsp; 返回执行记录
				</button>
				<button type="button" className={styles.refresh} onClick={load}>
					<Icon name="refresh" />
					刷新
				</button>
			</div>
			<div className={styles.titleRow}>
				<h1>Session 详情</h1>
				<div className={styles.actions}>
					<button type="button" disabled={exporting !== null} onClick={() => void downloadExport("transcript")}>
						导出日志
					</button>
					<button type="button" disabled={exporting !== null} onClick={() => setFullExportOpen(true)}>
						完整导出
					</button>
					{detail.kind === "loaded" && detail.data.conversation.status === "active" ? (
						<button
							type="button"
							disabled={lifecycleBusy !== null}
							onClick={() => void updateLifecycle("archive")}
						>
							{lifecycleBusy === "archive" ? "结束中…" : "结束会话"}
						</button>
					) : null}
					{detail.kind === "loaded" && detail.data.conversation.status !== "deleted" ? (
						<button
							className={styles.danger}
							type="button"
							disabled={lifecycleBusy !== null}
							onClick={() => void updateLifecycle("delete")}
						>
							{lifecycleBusy === "delete" ? "删除中…" : "删除"}
						</button>
					) : null}
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
					api={api}
					conversationId={conversationId}
					data={detail.data}
					modelId={modelId}
					eventPage={eventPage}
					tab={tab}
					onTab={setTab}
					loadingMore={loadingMore}
					onLoadMore={loadMoreEvents}
				/>
			) : null}
		</section>
	);
}

function LoadedDetail({
	api,
	conversationId,
	data,
	modelId,
	eventPage,
	tab,
	onTab,
	loadingMore,
	onLoadMore,
}: {
	readonly api: ConversationsApi;
	readonly conversationId: string;
	readonly data: DetailData;
	readonly modelId: string;
	readonly eventPage: EventPageState;
	readonly tab: SessionTab;
	readonly onTab: (tab: SessionTab) => void;
	readonly loadingMore: boolean;
	readonly onLoadMore: () => void;
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
					<Info label="任务来源" value={conversation.origin === "aaas_key" ? "旧 AaaS Run" : conversation.origin === "integration" ? "Integration Run" : data.source === "chat" ? "Chat" : "历史编排"} />
					{conversation.runId && <Info label="Run ID" value={conversation.runId} copy />}
					{conversation.executionState && <Info label={conversation.runId ? "Run 状态" : "最近一轮状态"} value={conversation.executionState === "running" && !conversation.runId ? "已开始" : WORK_STATUS[conversation.executionState as keyof typeof WORK_STATUS]?.label ?? conversation.executionState} />}
					<Info label="实际模型" value={modelId} />
					<Info label="请求契约" value={data.requestContract || "—"} />
					<Info label="Agent" value={conversation.agentId || "—"} />
				</InfoCard>
			</div>
			<AuroraPillTabs
				ariaLabel="Session 视图"
				value={tab}
				onChange={onTab}
				items={[
					{ value: "trajectory", label: "执行轨迹" },
					{ value: "usage", label: "用量" },
				]}
			/>
			<div className={styles.tabPanel}>
				{tab === "trajectory" ? (
					<TrajectoryView
						key={conversationId}
						api={api}
						conversationId={conversationId}
						events={eventPage.items}
						initialTrace={data.trace}
						taskInput={data.taskInput}
						hasMoreEvents={eventPage.nextAfterSequence !== null}
						loadingMoreEvents={loadingMore}
						onLoadMoreEvents={onLoadMore}
					/>
				) : null}
				{tab === "usage" ? <UsageView api={api} conversationId={conversationId} /> : null}
			</div>
		</>
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
function formatDate(value: string): string {
	return formatBeijing(value);
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
