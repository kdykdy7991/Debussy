import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { type FormEvent, useState, useSyncExternalStore } from "react";
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

	const handleConnection = () => {
		if (connected) {
			connection.disconnect();
			return;
		}
		void connection.connect().catch(() => {});
	};
	const createSession = () => void sessions.createSession().catch(() => {});
	const selectSession = (sessionId: string) => void sessions.selectSession(sessionId).catch(() => {});
	const submitMessage = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!message.trim()) return;
		void sessions
			.send(message)
			.then(() => setMessage(""))
			.catch(() => {});
	};
	const abort = () => void sessions.abort().catch(() => {});
	const active = sessionSnapshot.activeSession;
	const canSend = connected && active !== undefined && !sessionSnapshot.loading && !sessionSnapshot.submitting;

	return (
		<main className="app-shell">
			<div className="ambient ambient-one" aria-hidden="true" />
			<div className="ambient ambient-two" aria-hidden="true" />

			<div className="workspace glass-panel">
				<aside className="session-panel" aria-label="会话列表">
					<div className="brand-row">
						<span className="brand-mark" aria-hidden="true">
							π
						</span>
						<div>
							<p className="eyebrow">PI AGENT</p>
							<h1>会话</h1>
						</div>
					</div>

					<button
						className="glass-button primary-action"
						type="button"
						disabled={!connected || sessionSnapshot.loading}
						onClick={createSession}
					>
						<span aria-hidden="true">＋</span>
						新建会话
					</button>

					{sessionSnapshot.sessions.length > 0 ? (
						<nav className="session-list" aria-label="已有会话">
							{sessionSnapshot.sessions.map((session) => (
								<button
									className={session.id === sessionSnapshot.activeSessionId ? "active" : undefined}
									type="button"
									onClick={() => selectSession(session.id)}
									disabled={!connected || sessionSnapshot.loading}
									key={session.id}
								>
									<span>{session.name || "未命名会话"}</span>
									<small>{session.phase === "idle" ? "空闲" : "运行中"}</small>
								</button>
							))}
						</nav>
					) : (
						<output className="session-placeholder">
							<span className="pulse-dot" aria-hidden="true" />
							<p>{connected ? "还没有会话" : "等待连接后加载会话"}</p>
						</output>
					)}
					{sessionSnapshot.error ? <p className="session-error">{sessionSnapshot.error}</p> : null}
				</aside>

				<section className="chat-panel" aria-label="对话">
					<header className="chat-header">
						<div>
							<p className="eyebrow">LOCAL WORKSPACE</p>
							<h2>{sessionSnapshot.activeSessionId ? "当前会话" : "Pi Web"}</h2>
						</div>
						<button
							className={`connection-status ${connectionSnapshot.state}`}
							type="button"
							onClick={handleConnection}
							disabled={connecting}
						>
							<span aria-hidden="true" />
							{CONNECTION_LABELS[connectionSnapshot.state]}
						</button>
					</header>
					{connectionSnapshot.error ? (
						<div className="connection-error" role="alert">
							<span>{connectionSnapshot.error}</span>
							<button type="button" onClick={handleConnection}>
								重新连接
							</button>
						</div>
					) : null}

					<div className="conversation-canvas">
						{sessionSnapshot.activeSession ? (
							<div className="message-list" aria-live="polite">
								{sessionSnapshot.activeSession.transcript.length > 0 ? (
									sessionSnapshot.activeSession.transcript.map((item) => (
										<TranscriptItemView item={item} key={item.id} />
									))
								) : (
									<p className="empty-transcript">这个会话还没有消息</p>
								)}
							</div>
						) : (
							<article className="welcome-card glass-card">
								<div className="orb" aria-hidden="true">
									<span>π</span>
								</div>
								<p className="eyebrow">FRONTEND FOUNDATION</p>
								<h3>从这里开始对话</h3>
								<p>界面基础已经就绪。连接 Pi Server 后，你可以在浏览器中继续现有会话或开启新的任务。</p>
							</article>
						)}
					</div>

					<form className="composer glass-card" onSubmit={submitMessage}>
						<label htmlFor="message">消息</label>
						<textarea
							id="message"
							placeholder={active?.phase === "idle" ? "输入消息" : "输入追加指令"}
							disabled={!connected || active === undefined || sessionSnapshot.loading}
							value={message}
							onChange={(event) => setMessage(event.target.value)}
						/>
						{active && active.phase !== "idle" ? (
							<button
								className="abort-button"
								type="button"
								onClick={abort}
								disabled={sessionSnapshot.submitting}
							>
								停止
							</button>
						) : null}
						<button
							className="send-button"
							type="submit"
							disabled={!canSend || !message.trim()}
							aria-label="发送消息"
						>
							<span aria-hidden="true">↑</span>
						</button>
					</form>
				</section>
			</div>
		</main>
	);
}

function TranscriptItemView({ item }: { item: TranscriptItem }) {
	if (item.role === "tool") {
		return (
			<article className={`message tool-message ${item.status}`}>
				<header>
					<span>工具</span>
					<strong>{item.toolName}</strong>
				</header>
				{item.content.map((content, index) =>
					content.type === "text" ? (
						<p key={`${item.id}-${index}`}>{content.text}</p>
					) : (
						<p key={`${item.id}-${index}`}>[图片]</p>
					),
				)}
			</article>
		);
	}

	return (
		<article className={`message ${item.role}-message ${item.role === "assistant" ? item.status : ""}`}>
			{item.content.map((content, index) => {
				if (content.type === "text") return <p key={`${item.id}-${index}`}>{content.text}</p>;
				if (content.type === "image") return <p key={`${item.id}-${index}`}>[图片]</p>;
				if (content.type === "thinking") {
					return (
						<details className="thinking-block" key={`${item.id}-${index}`}>
							<summary>思考过程</summary>
							<p>{content.redacted ? "思考内容已隐藏" : content.thinking}</p>
						</details>
					);
				}
				return (
					<div className="tool-call" key={`${item.id}-${index}`}>
						<span>调用工具</span>
						<strong>{content.toolName}</strong>
					</div>
				);
			})}
			{item.role === "assistant" && item.status === "streaming" ? (
				<output className="streaming-indicator">正在生成</output>
			) : null}
		</article>
	);
}
