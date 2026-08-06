import type { SessionSnapshot, TranscriptItem } from "@earendil-works/pi-protocol";
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type { PiConnectionStore } from "./lib/connection-controller.ts";
import type { SessionBrowserStore } from "./lib/session-controller.ts";

export interface AppProps {
	connection: PiConnectionStore;
	sessions: SessionBrowserStore;
}

const CONNECTION_LABELS = {
	disconnected: "尚未连接",
	connecting: "正在连接",
	connected: "已连接",
} as const;

const EMPTY_PROMPTS = [
	"梳理这个项目的核心架构",
	"检查最近的代码改动",
	"定位一个难以复现的问题",
	"为下一阶段制定实施计划",
];

type VisualTheme = "editorial" | "vision-glass";

const THEME_STORAGE_KEY = "pi-web-theme";

export function App({ connection, sessions }: AppProps) {
	const connectionSnapshot = useSyncExternalStore(
		connection.subscribe,
		connection.getSnapshot,
		connection.getSnapshot,
	);
	const sessionSnapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot);
	const connected = connectionSnapshot.state === "connected";
	const connecting = connectionSnapshot.state === "connecting";
	const [message, setMessage] = useState("");
	const [sessionQuery, setSessionQuery] = useState("");
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [railOpen, setRailOpen] = useState(false);
	const [theme, setTheme] = useState<VisualTheme>(() => {
		if (typeof window === "undefined") return "editorial";
		try {
			return window.localStorage.getItem(THEME_STORAGE_KEY) === "vision-glass" ? "vision-glass" : "editorial";
		} catch {
			return "editorial";
		}
	});
	const active = sessionSnapshot.activeSession;
	const running = active !== undefined && active.phase !== "idle";
	const canSend = connected && active !== undefined && !sessionSnapshot.loading && !sessionSnapshot.submitting;
	const visibleSessions = useMemo(() => {
		const query = sessionQuery.trim().toLocaleLowerCase();
		if (!query) return sessionSnapshot.sessions;
		return sessionSnapshot.sessions.filter((session) =>
			(session.name || session.id).toLocaleLowerCase().includes(query),
		);
	}, [sessionQuery, sessionSnapshot.sessions]);

	const handleConnection = () => {
		if (connected) {
			connection.disconnect();
			return;
		}
		void connection.connect().catch(() => {});
	};
	const createSession = () => void sessions.createSession().catch(() => {});
	const selectSession = (sessionId: string) => {
		setSidebarOpen(false);
		void sessions.selectSession(sessionId).catch(() => {});
	};
	const submitMessage = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!message.trim() || running) return;
		void sessions
			.send(message)
			.then(() => setMessage(""))
			.catch(() => {});
	};
	const handleMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	};
	const handleMessageChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
		setMessage(event.target.value);
		event.target.style.height = "0";
		event.target.style.height = `${Math.min(event.target.scrollHeight, 240)}px`;
	};
	const abort = () => void sessions.abort().catch(() => {});

	useEffect(() => {
		document.body.dataset.theme = theme;
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, theme);
		} catch {
			// The visual choice still applies when browser storage is unavailable.
		}
		return () => {
			delete document.body.dataset.theme;
		};
	}, [theme]);

	return (
		<div className="editorial-shell" data-theme={theme}>
			<aside className={`chat-sidebar ${sidebarOpen ? "open" : ""}`} aria-label="会话导航">
				<header className="brand-lockup">
					<span className="brand-mark" aria-hidden="true">
						π
					</span>
					<span>
						<strong>PI</strong>
						<small>EDITORIAL INTELLIGENCE</small>
					</span>
					<button
						className="icon-button sidebar-close"
						type="button"
						onClick={() => setSidebarOpen(false)}
						aria-label="关闭会话导航"
					>
						×
					</button>
				</header>

				<button
					className="new-chat-button"
					type="button"
					disabled={!connected || sessionSnapshot.loading}
					onClick={createSession}
				>
					<span aria-hidden="true">＋</span>
					<span>新建对话</span>
					<kbd>NEW</kbd>
				</button>

				<label className="conversation-search">
					<span aria-hidden="true">⌕</span>
					<input
						value={sessionQuery}
						onChange={(event) => setSessionQuery(event.target.value)}
						placeholder="搜索会话"
						aria-label="搜索会话"
					/>
				</label>

				<div className="sidebar-section-label">
					<span>最近会话</span>
					<small>{visibleSessions.length}</small>
				</div>
				{visibleSessions.length > 0 ? (
					<nav className="conversation-list" aria-label="已有会话">
						{visibleSessions.map((session) => (
							<button
								className={session.id === sessionSnapshot.activeSessionId ? "active" : undefined}
								type="button"
								onClick={() => selectSession(session.id)}
								disabled={!connected || sessionSnapshot.loading}
								key={session.id}
							>
								<i
									className={`session-state ${session.phase === "idle" ? "idle" : "running"}`}
									aria-hidden="true"
								/>
								<span>
									<strong>{session.name || "未命名对话"}</strong>
									<small>{session.phase === "idle" ? "可继续对话" : "Agent 正在运行"}</small>
								</span>
								<time>{formatTime(session.updatedAt)}</time>
							</button>
						))}
					</nav>
				) : (
					<div className="sidebar-empty">
						<span>—</span>
						<p>{connected ? "暂无匹配会话" : "连接后载入会话"}</p>
					</div>
				)}

				<footer className="sidebar-footer">
					<div className={`connection-dot ${connectionSnapshot.state}`} aria-hidden="true" />
					<span>
						<strong>LOCAL WORKSPACE</strong>
						<small>{CONNECTION_LABELS[connectionSnapshot.state]}</small>
					</span>
					<button type="button" onClick={handleConnection} disabled={connecting}>
						{connected ? "断开" : "连接"}
					</button>
				</footer>
			</aside>

			<main className="chat-workspace">
				<header className="chat-masthead">
					<div className="masthead-group">
						<button
							className="icon-button mobile-nav"
							type="button"
							onClick={() => setSidebarOpen(true)}
							aria-label="打开会话导航"
						>
							☰
						</button>
						<span className="edition">
							PI INTELLIGENCE <i>／</i> LOCAL DESK
						</span>
					</div>
					<time className="masthead-date">{formatDate(Date.now())}</time>
					<div className="masthead-actions">
						<fieldset className="theme-switcher" aria-label="视觉主题">
							<legend className="sr-only">视觉主题</legend>
							<button
								type="button"
								className={theme === "editorial" ? "active" : undefined}
								onClick={() => setTheme("editorial")}
								aria-pressed={theme === "editorial"}
							>
								<span className="theme-swatch editorial-swatch" aria-hidden="true" />
								Editorial
							</button>
							<button
								type="button"
								className={theme === "vision-glass" ? "active" : undefined}
								onClick={() => setTheme("vision-glass")}
								aria-pressed={theme === "vision-glass"}
							>
								<span className="theme-swatch glass-swatch" aria-hidden="true" />
								Vision Glass
							</button>
						</fieldset>
						<span className={`connection-badge ${connectionSnapshot.state}`}>
							<i aria-hidden="true" />
							{CONNECTION_LABELS[connectionSnapshot.state]}
						</span>
						<button className="text-action" type="button" onClick={handleConnection} disabled={connecting}>
							{connected ? "断开" : "连接"}
						</button>
						<button
							className="icon-button rail-trigger"
							type="button"
							onClick={() => setRailOpen(true)}
							aria-label="打开会话信息"
						>
							☷
						</button>
					</div>
				</header>

				{connectionSnapshot.error ? (
					<div className="connection-error" role="alert">
						<span>{connectionSnapshot.error}</span>
						<button type="button" onClick={handleConnection}>
							重新连接
						</button>
					</div>
				) : null}

				<div className="conversation-scroll">
					{active ? (
						<Conversation active={active} abort={abort} />
					) : (
						<EmptyConversation connected={connected} createSession={createSession} setMessage={setMessage} />
					)}
				</div>

				<div className="composer-dock">
					<form className={`editorial-composer ${running ? "running" : ""}`} onSubmit={submitMessage}>
						<label className="sr-only" htmlFor="message">
							消息
						</label>
						<textarea
							id="message"
							rows={1}
							placeholder={
								active
									? running
										? "Agent 运行中，可停止后继续输入…"
										: "继续追问、要求检查，或提出新的任务…"
									: "选择或新建一个会话后开始…"
							}
							disabled={!connected || active === undefined || sessionSnapshot.loading || running}
							value={message}
							onChange={handleMessageChange}
							onKeyDown={handleMessageKeyDown}
						/>
						<div className="composer-toolbar">
							<div className="composer-context">
								<button
									className="composer-tool disabled-tool"
									type="button"
									disabled
									title="当前协议暂不支持文件上传"
								>
									＋
								</button>
								<span className="context-chip">
									<i>π</i> Pi Agent
								</span>
								{active ? (
									<span className="context-chip muted">
										{active.model.provider} / {active.model.id}
									</span>
								) : null}
							</div>
							<div className="composer-submit">
								<span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
								{running ? (
									<button
										className="stop-button"
										type="button"
										onClick={abort}
										disabled={sessionSnapshot.submitting}
									>
										<i aria-hidden="true" />
										停止
									</button>
								) : (
									<button
										className="send-button"
										type="submit"
										disabled={!canSend || !message.trim()}
										aria-label="发送消息"
									>
										↑
									</button>
								)}
							</div>
						</div>
					</form>
				</div>
			</main>

			<SessionRail active={active} open={railOpen} close={() => setRailOpen(false)} />
			<button
				className={`scrim ${sidebarOpen || railOpen ? "show" : ""}`}
				type="button"
				onClick={() => {
					setSidebarOpen(false);
					setRailOpen(false);
				}}
				aria-label="关闭面板"
			/>
		</div>
	);
}

function Conversation({ active, abort }: { active: SessionSnapshot; abort: () => void }) {
	const running = active.phase !== "idle";
	return (
		<article className="conversation-article">
			<header className="conversation-title">
				<div className="conversation-overline">
					<span>CONVERSATION</span>
					<span>#{active.id.slice(0, 8).toUpperCase()}</span>
				</div>
				<h1>{active.name || "未命名对话"}</h1>
				<p>围绕当前工作区持续展开的智能分析与协作记录。</p>
				<div className="conversation-meta">
					<span>
						<strong>PI AGENT</strong>
						<small>
							{active.model.provider} / {active.model.id}
						</small>
					</span>
					<span>
						<strong>THINKING</strong>
						<small>{active.thinkingLevel}</small>
					</span>
					<span>
						<strong>WORKSPACE</strong>
						<small title={active.cwd}>{active.cwd.split("/").filter(Boolean).at(-1) || active.cwd}</small>
					</span>
				</div>
			</header>

			{running ? (
				<section className="agent-run-strip" aria-label="Agent 运行状态">
					<span className="run-spinner" aria-hidden="true" />
					<span>
						<strong>{phaseLabel(active.phase)}</strong>
						<small>内容将随服务端事件持续更新</small>
					</span>
					<div className="run-track" aria-hidden="true">
						<i />
						<i />
						<i className="active" />
						<i />
						<i />
					</div>
					<button type="button" onClick={abort}>
						停止运行
					</button>
				</section>
			) : null}

			<section className="message-flow" aria-live="polite">
				{active.transcript.length > 0 ? (
					active.transcript.map((item, index) => <TranscriptItemView item={item} index={index} key={item.id} />)
				) : (
					<EmptyTranscript />
				)}
			</section>
		</article>
	);
}

function TranscriptItemView({ item, index }: { item: TranscriptItem; index: number }) {
	if (item.role === "tool") {
		const status = item.status === "running" ? "正在执行" : item.status === "error" ? "执行失败" : "执行完成";
		return (
			<details className={`tool-report ${item.status}`} open={item.status === "error"}>
				<summary>
					<span className="tool-status" aria-hidden="true">
						{item.status === "complete" ? "✓" : item.status === "error" ? "!" : ""}
					</span>
					<span>
						<small>调查过程 · TOOL CALL</small>
						<strong>
							{status}：{item.toolName}
						</strong>
					</span>
					<span className="tool-toggle">详情⌄</span>
				</summary>
				<div className="tool-details">
					<div>
						<span>工具</span>
						<code>{item.toolName}</code>
					</div>
					<div>
						<span>输入</span>
						<pre>{JSON.stringify(item.input, null, 2)}</pre>
					</div>
					<div>
						<span>结果</span>
						<div>
							{item.content.length ? (
								item.content.map((content, contentIndex) => (
									<p key={`${item.id}-${contentIndex}`}>
										{content.type === "text" ? content.text : "[图片结果]"}
									</p>
								))
							) : (
								<p>等待结果…</p>
							)}
						</div>
					</div>
				</div>
			</details>
		);
	}

	if (item.role === "user") {
		return (
			<section className="user-brief">
				<div>
					{item.content.map((content, contentIndex) => (
						<p key={`${item.id}-${contentIndex}`}>{content.type === "text" ? content.text : "[图片附件]"}</p>
					))}
				</div>
				<footer>
					<time>{formatTime(item.timestamp)}</time>
					<button
						type="button"
						onClick={() =>
							void navigator.clipboard?.writeText(
								item.content
									.filter((content) => content.type === "text")
									.map((content) => content.text)
									.join("\n"),
							)
						}
					>
						复制
					</button>
				</footer>
			</section>
		);
	}

	return (
		<section className={`assistant-analysis ${item.status}`}>
			<header className="answer-byline">
				<span className="agent-avatar">π</span>
				<span>
					<strong>PI ANALYSIS</strong>
					<small>
						{item.model.provider} / {item.model.id} · {formatTime(item.timestamp)}
					</small>
				</span>
				<span className={`answer-status ${item.status}`}>{assistantStatus(item.status)}</span>
			</header>
			<div className="answer-content">
				{item.content.map((content, contentIndex) => {
					if (content.type === "text")
						return <MarkdownText text={content.text} key={`${item.id}-${contentIndex}`} />;
					if (content.type === "thinking")
						return (
							<details className="thinking-note" key={`${item.id}-${contentIndex}`}>
								<summary>执行思路摘要</summary>
								<p>{content.redacted ? "推理内容已隐藏" : content.thinking}</p>
							</details>
						);
					return (
						<div className="inline-tool-call" key={`${item.id}-${contentIndex}`}>
							<span>准备调用工具</span>
							<strong>{content.toolName}</strong>
						</div>
					);
				})}
				{item.status === "streaming" ? <output className="streaming-indicator" aria-label="正在生成" /> : null}
			</div>
			<footer className="answer-actions">
				<span>ANSWER {String(index + 1).padStart(2, "0")}</span>
				<div>
					<button type="button">复制</button>
					<button type="button" disabled title="当前协议暂不支持重新生成">
						重新生成
					</button>
				</div>
			</footer>
		</section>
	);
}

function MarkdownText({ text }: { text: string }) {
	let blockOffset = 0;
	const blocks = text
		.split(/(```[\s\S]*?```)/g)
		.filter(Boolean)
		.map((value) => {
			const offset = blockOffset;
			blockOffset += value.length;
			return { offset, value };
		});
	return (
		<>
			{blocks.map((block) => {
				if (block.value.startsWith("```")) {
					const match = block.value.match(/^```([^\n]*)\n?([\s\S]*?)```$/);
					return (
						<figure className="code-exhibit" key={`code-${block.offset}`}>
							<figcaption>
								<span>EXHIBIT · {match?.[1] || "CODE"}</span>
							</figcaption>
							<pre>
								<code>{match?.[2] ?? block.value}</code>
							</pre>
						</figure>
					);
				}
				let lineOffset = block.offset;
				const lines = block.value.split("\n").map((value) => {
					const offset = lineOffset;
					lineOffset += value.length + 1;
					return { offset, value };
				});
				return (
					<div className="prose-block" key={`prose-${block.offset}`}>
						{lines.map((line) => {
							const trimmed = line.value.trim();
							const key = `line-${line.offset}`;
							if (!trimmed) return <span className="paragraph-space" key={key} />;
							if (trimmed.startsWith("### ")) return <h3 key={key}>{trimmed.slice(4)}</h3>;
							if (trimmed.startsWith("## ")) return <h2 key={key}>{trimmed.slice(3)}</h2>;
							if (trimmed.startsWith("# ")) return <h2 key={key}>{trimmed.slice(2)}</h2>;
							if (trimmed.startsWith("> ")) return <blockquote key={key}>{trimmed.slice(2)}</blockquote>;
							if (/^[-*] /.test(trimmed))
								return (
									<p className="list-line" key={key}>
										• {trimmed.slice(2)}
									</p>
								);
							if (/^\d+\. /.test(trimmed))
								return (
									<p className="list-line" key={key}>
										{trimmed}
									</p>
								);
							return <p key={key}>{line.value}</p>;
						})}
					</div>
				);
			})}
		</>
	);
}

function EmptyConversation({
	connected,
	createSession,
	setMessage,
}: {
	connected: boolean;
	createSession: () => void;
	setMessage: (message: string) => void;
}) {
	return (
		<section className="empty-conversation">
			<span className="empty-mark">π</span>
			<p className="section-kicker">EDITORIAL INTELLIGENCE</p>
			<h1>
				把问题变成一份
				<br />
				清晰、可行动的分析
			</h1>
			<p className="empty-dek">从代码审查到复杂研究，Pi 会保留会话上下文，并把过程与最终回答清晰分层。</p>
			<div className="prompt-grid">
				{EMPTY_PROMPTS.map((prompt, index) => (
					<button type="button" onClick={() => setMessage(prompt)} key={prompt}>
						<span>0{index + 1}</span>
						{prompt}
					</button>
				))}
			</div>
			<button className="empty-primary" type="button" onClick={createSession} disabled={!connected}>
				{connected ? "开始新对话" : "请先连接本地服务"}
			</button>
		</section>
	);
}

function EmptyTranscript() {
	return (
		<section className="empty-transcript">
			<span>READY FOR BRIEF</span>
			<h2>这个会话还没有内容</h2>
			<p>在下方输入你的问题。回答会以适合长文阅读的分析稿形式呈现。</p>
		</section>
	);
}

function SessionRail({
	active,
	open,
	close,
}: {
	active: SessionSnapshot | undefined;
	open: boolean;
	close: () => void;
}) {
	return (
		<aside className={`session-rail ${open ? "open" : ""}`} aria-label="会话信息">
			<header>
				<span>会话信息</span>
				<button className="icon-button rail-close" type="button" onClick={close} aria-label="关闭会话信息">
					×
				</button>
			</header>
			{active ? (
				<>
					<section className="rail-summary">
						<p>ACTIVE SESSION</p>
						<h2>{active.name || "未命名对话"}</h2>
						<span>{active.phase === "idle" ? "可继续对话" : phaseLabel(active.phase)}</span>
					</section>
					<dl className="session-facts">
						<div>
							<dt>模型</dt>
							<dd>
								{active.model.provider}
								<br />
								{active.model.id}
							</dd>
						</div>
						<div>
							<dt>Thinking</dt>
							<dd>{active.thinkingLevel}</dd>
						</div>
						<div>
							<dt>消息</dt>
							<dd>{active.transcript.length}</dd>
						</div>
						<div>
							<dt>Revision</dt>
							<dd>{active.revision}</dd>
						</div>
					</dl>
					<section className="rail-section">
						<p className="rail-label">工作目录</p>
						<code>{active.cwd}</code>
					</section>
					<section className="rail-section unavailable">
						<p className="rail-label">来源与引用</p>
						<strong>当前协议未提供来源数据</strong>
						<p>接入 Citation 与 RAG schema 后，这里将展示可追溯来源，不会使用模拟数据。</p>
					</section>
				</>
			) : (
				<section className="rail-placeholder">
					<span>—</span>
					<p>选择会话后查看运行信息</p>
				</section>
			)}
		</aside>
	);
}

function formatDate(timestamp: number): string {
	return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(
		timestamp,
	);
}

function formatTime(timestamp: number): string {
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
}

function phaseLabel(phase: SessionSnapshot["phase"]): string {
	if (phase === "compaction") return "正在整理上下文";
	if (phase === "branch_summary") return "正在生成分支摘要";
	if (phase === "retry") return "连接恢复后重试中";
	if (phase === "turn") return "Pi 正在组织回答";
	return "等待下一项任务";
}

function assistantStatus(status: Extract<TranscriptItem, { role: "assistant" }>["status"]): string {
	if (status === "streaming") return "DRAFTING";
	if (status === "error") return "FAILED";
	if (status === "aborted") return "STOPPED";
	return "COMPLETE";
}
