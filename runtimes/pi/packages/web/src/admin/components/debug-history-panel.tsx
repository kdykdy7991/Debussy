/**
 * Phase 2E: Admin Debug "History" panel.
 *
 * v2：原设计把面板做成左 docked 侧栏，挤掉 chat 布局。
 * 本次重做为右侧**悬浮**面板（默认关闭）：不占 chat 布局空间，
 * 浮在 chat 之上；面板顶部的 notch/角标指向触发它的汉堡按钮。
 *
 * 数据源仍是 History list API（每 agent 的 `debug_conversations` 投影），
 * 不混入 SessionController 的 runtime list — 行为契约不变。
 */
import { useMemo } from "react";
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
	readonly onClose: () => void;
	readonly onNew: () => void;
	readonly onSelect: (conversationId: string) => void;
	readonly onClearAll: () => void;
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
	return id.length > 12 ? `…${id.slice(-6)}` : id;
}

function dayBucket(iso: string): string {
	const then = new Date(iso);
	if (!Number.isFinite(then.getTime())) return "其他";
	const now = new Date();
	const sameDay =
		then.getFullYear() === now.getFullYear() &&
		then.getMonth() === now.getMonth() &&
		then.getDate() === now.getDate();
	if (sameDay) return "今天";
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	const isYesterday =
		then.getFullYear() === yesterday.getFullYear() &&
		then.getMonth() === yesterday.getMonth() &&
		then.getDate() === yesterday.getDate();
	if (isYesterday) return "昨天";
	return then.toLocaleDateString();
}

export function DebugHistoryPanel(props: DebugHistoryPanelProps): React.ReactElement {
	const { open, state, activeConversationId, busy, onClose, onNew, onSelect, onClearAll } = props;
	const items = state.kind === "loaded" ? state.items : [];
	const isLoading = state.kind === "loading" || state.kind === "idle";
	const errorMessage = state.kind === "error" ? state.message : null;

	const grouped = useMemo(() => {
		const buckets = new Map<string, DebugConversationListItem[]>();
		for (const item of items) {
			const key = dayBucket(item.lastActiveAt);
			const list = buckets.get(key) ?? [];
			list.push(item);
			buckets.set(key, list);
		}
		// Items arrive newest-first from the API; preserve that order inside each bucket.
		return [...buckets.entries()];
	}, [items]);

	return (
		<aside
			className={`debug-history-panel ${open ? "open" : "collapsed"}`}
			aria-label="Debug 历史会话"
			aria-hidden={!open}
		>
			<span className="debug-history-panel__notch" aria-hidden="true" />
			<header className="debug-history-panel__header">
				<h2 className="debug-history-panel__title">对话历史</h2>
				<button
					type="button"
					className="debug-history-panel__close"
					onClick={onClose}
					aria-label="关闭历史面板"
				>
					<svg viewBox="0 0 16 16" width="14" height="14" focusable="false" aria-hidden="true">
						<path
							d="M4 4l8 8M12 4l-8 8"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</svg>
				</button>
			</header>

			<button
				type="button"
				className="debug-history-panel__new"
				onClick={onNew}
				disabled={busy}
				aria-label="新建调试会话"
				title="新建对话（不创建 DB 记录，下一次发送才创建）"
			>
				<span aria-hidden="true" className="debug-history-panel__new-icon">
					+
				</span>
				<span>新建对话</span>
			</button>

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
						{grouped.map(([label, group]) => (
							<section key={label} className="debug-history-panel__group">
								<h3 className="debug-history-panel__group-label">{label}</h3>
								{group.map((item) => {
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
											<span className="debug-history-panel__row-line">
												<span className="debug-history-panel__preview">{preview}</span>
												<time
													className="debug-history-panel__time"
													dateTime={item.lastActiveAt}
												>
													{formatRelativeTime(item.lastActiveAt)}
												</time>
											</span>
											<span className="debug-history-panel__row-sub">
												<span className="debug-history-panel__status-dot" aria-hidden="true" />
												<span className="debug-history-panel__id">
													{shortConversationId(item.conversationId)}
												</span>
											</span>
										</button>
									);
								})}
							</section>
						))}
					</nav>
				)}
			</div>

			<footer className="debug-history-panel__footer">
				<button
					type="button"
					className="debug-history-panel__clear"
					onClick={onClearAll}
					disabled={items.length === 0}
				>
					<span aria-hidden="true" className="debug-history-panel__clear-icon">
						<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
							<path
								d="M3 4.5h10M6.5 4.5V3.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M5 4.5l.6 8a1 1 0 0 0 1 .9h2.8a1 1 0 0 0 1-.9L11 4.5"
								stroke="currentColor"
								strokeWidth="1.2"
								strokeLinecap="round"
								strokeLinejoin="round"
								fill="none"
							/>
						</svg>
					</span>
					<span>清空对话列表</span>
				</button>
			</footer>
		</aside>
	);
}
