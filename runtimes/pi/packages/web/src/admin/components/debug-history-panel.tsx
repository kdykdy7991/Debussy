/**
 * Phase 2E: Admin Debug "History" sidebar.
 *
 * Renders the per-agent conversation list as a slim left rail, plus the
 * "New Conversation" button. The data source is the History list API (a
 * per-agent projection of the `debug_conversations` table) — NOT the
 * `SessionController` runtime list. The runtime is a transient execution
 * resource; the History list is the persistent identity a user can switch
 * between. Mixing the two would tie the UI to the runtime's transient
 * lifetime and break reload-resume semantics (Phase 2E principle:
 * "History UI ≠ runtime 身份").
 *
 * Clicking a row resolves to `onSelect(id)`, which the parent page routes
 * through `SessionController.openDebugSession`. Clicking "New Conversation"
 * resolves to `onNew()`, which the parent page treats as a pure local
 * binding reset — no backend call.
 *
 * The component is intentionally minimal: it does not own any state
 * mutations, does not call APIs directly, and does not try to mirror the
 * embed "ConversationSidebar" (which is driven by the runtime sessions
 * list and therefore would conflict with the History list semantics).
 */
import type { DebugConversationListItem } from "../api/agent-api.ts";

export type DebugHistoryState =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly DebugConversationListItem[] }
	| { readonly kind: "error"; readonly message: string };

export interface DebugHistoryPanelProps {
	readonly open: boolean;
	readonly state: DebugHistoryState;
	readonly activeConversationId: string | null;
	readonly busy: boolean;
	readonly onToggle: () => void;
	readonly onNew: () => void;
	readonly onSelect: (conversationId: string) => void;
}

const PREVIEW_FALLBACK = "（尚无消息）";

function formatRelativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return "";
	const diffMs = Date.now() - then;
	if (diffMs < 0) return "刚刚";
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (diffMs < minute) return "刚刚";
	if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`;
	if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`;
	if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} 天前`;
	return new Date(iso).toLocaleDateString();
}

function shortConversationId(id: string): string {
	// `dconv_<uuid>` -> `dconv_<last 6 hex>` so the user can distinguish
	// conversations in a glance without a full tooltip on every row.
	return id.length > 12 ? `…${id.slice(-6)}` : id;
}

export function DebugHistoryPanel(props: DebugHistoryPanelProps): React.ReactElement {
	const { open, state, activeConversationId, busy, onToggle, onNew, onSelect } = props;
	const items = state.kind === "loaded" ? state.items : [];
	const isLoading = state.kind === "loading" || state.kind === "idle";
	const errorMessage = state.kind === "error" ? state.message : null;
	return (
		<aside className={`debug-history-panel ${open ? "open" : "collapsed"}`} aria-label="Debug 历史会话">
			<header className="debug-history-panel__header">
				<button
					type="button"
					className="debug-history-panel__new"
					onClick={onNew}
					disabled={busy}
					aria-label="新建调试会话"
					title="新建对话（不创建 DB 记录，下一次发送才创建）"
				>
					<span aria-hidden="true">+</span>
					<span>新建对话</span>
				</button>
				<button
					type="button"
					className="debug-history-panel__toggle"
					onClick={onToggle}
					aria-label={open ? "收起历史面板" : "展开历史面板"}
				>
					{open ? "‹" : "›"}
				</button>
			</header>
			{open ? (
				<div className="debug-history-panel__body" aria-busy={isLoading}>
					{errorMessage !== null ? (
						<p className="debug-history-panel__error" role="alert">
							{errorMessage}
						</p>
					) : null}
					{isLoading && items.length === 0 ? (
						<p className="debug-history-panel__empty">正在加载历史会话…</p>
					) : items.length === 0 ? (
						<p className="debug-history-panel__empty">该 Agent 暂无历史会话</p>
					) : (
						<nav className="debug-history-panel__list" aria-label="历史会话列表">
							{items.map((item) => {
								const isActive = item.conversationId === activeConversationId;
								const preview = item.firstUserMessagePreview ?? PREVIEW_FALLBACK;
								return (
									<button
										key={item.conversationId}
										type="button"
										className={`debug-history-panel__row${isActive ? " is-active" : ""}`}
										onClick={() => onSelect(item.conversationId)}
										disabled={busy && !isActive}
										title={preview}
									>
										<span className="debug-history-panel__preview">{preview}</span>
										<span className="debug-history-panel__meta">
											<span className="debug-history-panel__id">
												{shortConversationId(item.conversationId)}
											</span>
											<time dateTime={item.lastActiveAt}>{formatRelativeTime(item.lastActiveAt)}</time>
										</span>
									</button>
								);
							})}
						</nav>
					)}
				</div>
			) : null}
		</aside>
	);
}
