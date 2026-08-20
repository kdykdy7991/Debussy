import type { PiConnectionSnapshot } from "../lib/connection-controller.ts";
import type { SessionBrowserSnapshot } from "../lib/session-controller.ts";

const CONNECTION_LABELS = {
	disconnected: "尚未连接",
	connecting: "正在连接",
	connected: "已连接",
} as const;

export interface ConversationSidebarProps {
	readonly open: boolean;
	readonly connected: boolean;
	readonly bootstrapping: boolean;
	readonly query: string;
	readonly connection: PiConnectionSnapshot;
	readonly sessions: SessionBrowserSnapshot;
	readonly visibleSessions: SessionBrowserSnapshot["sessions"];
	readonly onToggle?: () => void;
	readonly onCreate: () => void;
	readonly onQueryChange: (query: string) => void;
	readonly onSelect: (sessionId: string) => void;
}

export function ConversationSidebar(props: ConversationSidebarProps): React.ReactElement {
	return (
		<aside className={`chat-sidebar ${props.open ? "open" : ""}`} aria-label="会话导航">
			<div className="sidebar-actions">
				{!props.bootstrapping ? (
					<button
						className="new-chat-button"
						type="button"
						disabled={!props.connected || props.sessions.loading}
						onClick={props.onCreate}
					>
						<span className="new-chat-plus" aria-hidden="true">
							<svg viewBox="0 0 16 16" fill="none" focusable="false">
								<title>新建对话</title>
								<path
									d="M8 3.25v9.5M3.25 8h9.5"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
								/>
							</svg>
						</span>
						<span>新建对话</span>
					</button>
				) : null}
				{props.onToggle ? (
					<button
						className="sidebar-collapse-button"
						type="button"
						onClick={props.onToggle}
						aria-label="收起会话导航"
					>
						<svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true">
							<title>收起会话导航</title>
							<path
								d="m9.75 3.5-4.5 4.5 4.5 4.5"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				) : null}
			</div>

			<label className="conversation-search">
				<span aria-hidden="true">⌕</span>
				<input
					value={props.query}
					onChange={(event) => props.onQueryChange(event.target.value)}
					placeholder="搜索会话"
					aria-label="搜索会话"
				/>
			</label>

			<div className="sidebar-section-label">
				<span>Conversations</span>
			</div>
			{props.visibleSessions.length > 0 ? (
				<nav className="conversation-list" aria-label="已有会话">
					{props.visibleSessions.map((session) => (
						<button
							className={session.id === props.sessions.activeSessionId ? "active" : undefined}
							type="button"
							onClick={() => props.onSelect(session.id)}
							disabled={!props.connected || props.sessions.loading}
							key={session.id}
						>
							<i className="conversation-icon" aria-hidden="true">
								◇
							</i>
							<span>
								<strong>{session.name || "未命名对话"}</strong>
							</span>
						</button>
					))}
				</nav>
			) : props.bootstrapping ? (
				<div className="sidebar-empty">
					<span>—</span>
					<p>正在恢复最近会话…</p>
				</div>
			) : (
				<div className="sidebar-empty">
					<span>—</span>
					<p>{props.connected ? "暂无匹配会话" : "连接后载入会话"}</p>
				</div>
			)}

			<footer className="sidebar-footer">
				<strong>Workspace</strong> — {CONNECTION_LABELS[props.connection.state]}
				<br />
				<strong>Conversations</strong> — {props.sessions.sessions.length}
				<br />
				<strong>Runtime</strong> — Pi Agent
			</footer>
		</aside>
	);
}
