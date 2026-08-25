import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatedMarkdown } from "flowtoken";
import {
	AgentStatusAvatar,
	AgentTrace,
	AgentTraceEvent,
	AssistantResponse,
	Prose,
	preloadAgentStatusAvatar,
	Sources,
	UserMessage,
} from "../ai-kit/index.ts";
import type { EmbedChatState } from "./chat-controller.ts";
import type { ChatAttachment, ChatMessage, ConversationSummary } from "./types.ts";

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
	readonly onUpload: (file: File) => void;
	readonly onRemoveAttachment: (attachmentId: string) => void;
}): React.JSX.Element {
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [query, setQuery] = useState("");
	const [message, setMessage] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const conversationScrollRef = useRef<HTMLDivElement>(null);
	const followConversationRef = useRef(true);
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
		if (composerRef.current) composerRef.current.style.height = "auto";
	};
	useEffect(() => {
		const element = conversationScrollRef.current;
		if (element && followConversationRef.current) element.scrollTop = element.scrollHeight;
	}, [props.state.activeId, props.state.messages]);
	return (
		<div
			className={`editorial-shell conversation-workspace conversation-workspace--admin ${sidebarOpen ? "" : "sidebar-collapsed"}`}
		>
			<PublishedSidebar
				open={sidebarOpen}
				items={conversations}
				activeId={props.state.activeId}
				query={query}
				connectionStatus={props.state.connectionStatus}
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
					<svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true">
						<path d="m6.25 3.5 4.5 4.5-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
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
				<div
					className="conversation-scroll"
					ref={conversationScrollRef}
					onScroll={() => {
						const element = conversationScrollRef.current;
						if (element) followConversationRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
					}}
				>
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
					{props.state.attachments.length > 0 ? (
						<div className="composer-attachments">
							{props.state.attachments.map((attachment) => (
								<PublishedAttachment
									key={attachment.attachmentId}
									attachment={attachment}
									onRemove={props.onRemoveAttachment}
								/>
							))}
						</div>
					) : null}
					<div className="composer-line">
						<textarea
							ref={composerRef}
							rows={1}
							value={message}
							disabled={props.state.sending || props.state.activeId === null || props.state.connectionStatus !== "connected"}
							placeholder={props.state.activeId === null ? "选择或新建一个会话后开始…" : props.state.sending ? "Agent 运行中，可停止后继续输入…" : "Ask anything, or point me at a document…"}
							onChange={(event) => {
								setMessage(event.target.value);
								event.target.style.height = "0";
								event.target.style.height = `${Math.min(event.target.scrollHeight, 240)}px`;
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									event.currentTarget.form?.requestSubmit();
								}
							}}
						/>
					</div>
					<div className="composer-toolbar">
						<div className="composer-tools">
							<button
								className="composer-tool composer-attach"
								type="button"
								onClick={() => fileInputRef.current?.click()}
								disabled={!props.state.uploadsEnabled || props.state.sending || props.state.activeId === null}
								title="上传文件附件"
								aria-label="上传文件附件"
							>
								<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
									<path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
								</svg>
							</button>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								hidden
								onChange={(event) => {
									for (const file of event.currentTarget.files ? [...event.currentTarget.files] : []) props.onUpload(file);
									event.currentTarget.value = "";
								}}
							/>
						</div>
						<div className="composer-submit">
							<button
								className="send-button"
								type="submit"
								disabled={props.state.sending || props.state.activeId === null || props.state.connectionStatus !== "connected" || message.trim() === ""}
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

function PublishedAttachment({ attachment, onRemove }: { readonly attachment: ChatAttachment; readonly onRemove: (id: string) => void }) {
	return (
		<span className="attachment-chip ready">
			<span className="attachment-chip__name" title={attachment.filename}>{attachment.filename}</span>
			<button type="button" onClick={() => onRemove(attachment.attachmentId)} aria-label={`移除 ${attachment.filename}`}>×</button>
		</span>
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
	readonly connectionStatus: EmbedChatState["connectionStatus"];
	readonly onQueryChange: (value: string) => void;
	readonly onNew: () => void;
	readonly onSelect: (id: string) => void;
	readonly onToggle: () => void;
}): React.JSX.Element {
	return (
		<aside className={`chat-sidebar ${props.open ? "open" : ""}`} aria-label="会话导航">
			<div className="sidebar-actions">
				<button className="new-chat-button" type="button" disabled={props.connectionStatus !== "connected"} onClick={props.onNew}>
					<span className="new-chat-plus" aria-hidden="true">
						<svg viewBox="0 0 16 16" fill="none" focusable="false"><path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
					</span>
					<span>新建对话</span>
				</button>
				<button
					className="sidebar-collapse-button"
					type="button"
					onClick={props.onToggle}
					aria-label="收起会话导航"
				>
					<svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true"><path d="m9.75 3.5-4.5 4.5 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
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
							disabled={props.connectionStatus !== "connected"}
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
				<strong>Workspace</strong> — {props.connectionStatus === "connected" ? "已连接" : "正在连接"}
				<br />
				<strong>Conversations</strong> — {props.items.length}
				<br />
				<strong>Runtime</strong> — Published Agent
			</footer>
		</aside>
	);
}

function PublishedMessage({ message }: { readonly message: ChatMessage }): React.JSX.Element {
	if (message.role === "user") {
		const plain = message.text.length <= 24 && !message.text.includes("\n");
		return <UserMessage variant={plain ? "plain" : "default"}>{message.text}</UserMessage>;
	}
	if (message.role === "system") {
		return <output className="connection-error">{message.text}</output>;
	}
	const rail =
		message.tools && message.tools.length > 0 ? (
			<AgentTrace status={message.tools.some((tool) => tool.status === "running") ? "running" : "completed"}>
				{message.tools.map((tool) => (
					<AgentTraceEvent
						key={tool.id}
						status={tool.status}
						title={tool.name}
						detail={tool.status === "running" ? "执行中" : tool.status === "failed" ? "失败" : "完成"}
					/>
				))}
			</AgentTrace>
		) : undefined;
	return (
		<AssistantResponse rail={rail}>
			<div className="assistant-output-card">
				{!message.streaming ? (
					<button
						className="assistant-output-copy"
						type="button"
						onClick={() => void navigator.clipboard?.writeText(message.text).catch(() => {})}
						aria-label="复制本条回答正文"
						title="复制本条回答正文"
					>
						<svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true">
							<rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.25" />
							<path d="M10.75 5.25v-1a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1" stroke="currentColor" strokeWidth="1.25" />
						</svg>
					</button>
				) : null}
				<div className="ai-reading-content">
					<Prose plain={message.text.length <= 120 && !message.text.includes("\n")} streaming={message.streaming}>
						<AnimatedMarkdown
							content={message.text}
							animation={message.streaming ? "fadeIn" : undefined}
							sep={message.streaming ? "diff" : undefined}
						/>
					</Prose>
				</div>
				{message.citations && message.citations.length > 0 ? (
					<Sources
						sources={message.citations.map((citation, index) => ({
							id: index + 1,
							title: citation.title,
							meta: citation.excerpt,
							type: "引用",
						}))}
					/>
				) : null}
			</div>
		</AssistantResponse>
	);
}
