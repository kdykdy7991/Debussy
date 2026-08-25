import { useEffect, useMemo, useState } from "react";
import { AgentStatusAvatar, preloadAgentStatusAvatar } from "../ai-kit/index.ts";
import type { EmbedChatState } from "./chat-controller.ts";
import type { ChatMessage, ConversationSummary } from "./types.ts";

/**
 * Published counterpart of the admin Chat workspace. It deliberately owns no
 * admin controller or token: only the Embed conversation data and actions are
 * accepted here. This keeps the two surfaces visually aligned without leaking
 * debug controls, model selection, or management permissions into an embed.
 */
export function PublishedConversationWorkspace(props: {
	readonly title: string;
	readonly state: EmbedChatState;
	readonly error: string | null;
	readonly onSend: (text: string) => void;
	readonly onNew: () => void;
	readonly onSelect: (conversationId: string) => void;
}): React.JSX.Element {
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [query, setQuery] = useState("");
	const [message, setMessage] = useState("");
	const conversations = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		return needle === ""
			? props.state.conversations
			: props.state.conversations.filter((item) => (item.title || item.id).toLocaleLowerCase().includes(needle));
	}, [props.state.conversations, query]);
	const submit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (message.trim() === "" || props.state.sending) return;
		props.onSend(message);
		setMessage("");
	};
	return (
		<div
			className={`editorial-shell conversation-workspace conversation-workspace--admin ${sidebarOpen ? "" : "sidebar-collapsed"}`}
		>
			<PublishedSidebar
				open={sidebarOpen}
				items={conversations}
				activeId={props.state.activeId}
				query={query}
				onQueryChange={setQuery}
				onNew={props.onNew}
				onSelect={props.onSelect}
				onToggle={() => setSidebarOpen((open) => !open)}
			/>
			{!sidebarOpen ? (
				<button
					className="sidebar-reopen-button"
					type="button"
					onClick={() => setSidebarOpen(true)}
					aria-label="展开会话导航"
				>
					›
				</button>
			) : null}
			<main className="chat-workspace">
				<div className="workspace-context-header">
					<div>
						<span className="workspace-context-kicker">PUBLISHED CHAT</span>
						<strong>{props.title}</strong>
					</div>
					<output className="workspace-connection-status">
						<span aria-hidden="true" />
						{props.state.connectionStatus === "connected" ? "已连接" : "连接中"}
					</output>
				</div>
				{props.error !== null ? (
					<div className="connection-error" role="alert">
						<span>{props.error}</span>
					</div>
				) : null}
				<div className="conversation-scroll">
					<article className="conversation-article">
						<section className="message-flow" aria-live="polite">
							{props.state.messages.length === 0 ? (
								<div className="empty-conversation">
									<p>开始一段新对话吧</p>
								</div>
							) : (
								props.state.messages.map((item) => (
									<PublishedMessage key={item.id ?? `${item.role}-${item.sequence}`} message={item} />
								))
							)}
						</section>
					</article>
				</div>
				<PublishedAgentPresence sending={props.state.sending} />
			</main>
			<div className="composer-dock">
				<form className={`editorial-composer ${props.state.sending ? "running" : ""}`} onSubmit={submit}>
					<div className="composer-line">
						<textarea
							rows={1}
							value={message}
							disabled={props.state.sending}
							placeholder={props.state.sending ? "正在回复…" : "Ask anything…"}
							onChange={(event) => setMessage(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									event.currentTarget.form?.requestSubmit();
								}
							}}
						/>
					</div>
					<div className="composer-toolbar">
						<div />
						<div className="composer-submit">
							<button
								className="send-button"
								type="submit"
								disabled={props.state.sending || message.trim() === ""}
							>
								Send <span aria-hidden="true">↵</span>
							</button>
						</div>
					</div>
				</form>
			</div>
		</div>
	);
}

/**
 * The published surface uses the same designed status avatar as Chat.  It is
 * a product-level interaction asset, not a fabricated per-agent portrait:
 * published data currently carries only the avatar capability toggle, not an
 * image URL or character manifest.
 */
function PublishedAgentPresence({ sending }: { readonly sending: boolean }): React.JSX.Element {
	const [waking, setWaking] = useState(true);
	useEffect(() => {
		void preloadAgentStatusAvatar();
		const timer = window.setTimeout(() => setWaking(false), 800);
		return () => window.clearTimeout(timer);
	}, []);
	return (
		<div className="active-agent-presence" aria-label="智能体状态">
			<AgentStatusAvatar state={waking ? "waking" : sending ? "loading" : "idle"} />
		</div>
	);
}

function PublishedSidebar(props: {
	readonly open: boolean;
	readonly items: readonly ConversationSummary[];
	readonly activeId: string | null;
	readonly query: string;
	readonly onQueryChange: (value: string) => void;
	readonly onNew: () => void;
	readonly onSelect: (id: string) => void;
	readonly onToggle: () => void;
}): React.JSX.Element {
	return (
		<aside className={`chat-sidebar ${props.open ? "open" : ""}`} aria-label="会话导航">
			<div className="sidebar-actions">
				<button className="new-chat-button" type="button" onClick={props.onNew}>
					<span className="new-chat-plus" aria-hidden="true">
						＋
					</span>
					<span>新建对话</span>
				</button>
				<button
					className="sidebar-collapse-button"
					type="button"
					onClick={props.onToggle}
					aria-label="收起会话导航"
				>
					‹
				</button>
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
			{props.items.length === 0 ? (
				<div className="sidebar-empty">
					<span>—</span>
					<p>暂无会话</p>
				</div>
			) : (
				<nav className="conversation-list" aria-label="已有会话">
					{props.items.map((item) => (
						<button
							className={item.id === props.activeId ? "active" : undefined}
							type="button"
							onClick={() => props.onSelect(item.id)}
							key={item.id}
						>
							<i className="conversation-icon" aria-hidden="true">
								◇
							</i>
							<span>
								<strong>{item.title || "未命名对话"}</strong>
							</span>
						</button>
					))}
				</nav>
			)}
			<footer className="sidebar-footer">
				<strong>Published App</strong>
				<br />
				<strong>Conversations</strong> — {props.items.length}
			</footer>
		</aside>
	);
}

function PublishedMessage({ message }: { readonly message: ChatMessage }): React.JSX.Element {
	return (
		<div className={`ai-turn ${message.role === "user" ? "user-turn" : ""}`}>
			<div className="ai-prose">
				<p>{message.text}</p>
				{message.streaming ? (
					<output className="ai-cursor" aria-label="正在生成">
						▋
					</output>
				) : null}
			</div>
		</div>
	);
}
