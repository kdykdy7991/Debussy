import type { LiveSpeechJobHandle } from "@earendil-works/pi-client";
import type { SessionSnapshot, TranscriptItem } from "@earendil-works/pi-protocol";
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ConversationComposer } from "./conversation/conversation-composer.tsx";
import { ConversationSidebar } from "./conversation/conversation-sidebar.tsx";
import { type VisualTheme, WorkspaceMasthead } from "./conversation/workspace-masthead.tsx";
import { LiveStatusRow } from "./features/voice/live-status-row.tsx";
import type { LivePlaybackState } from "./features/voice/live-types.ts";
import { PlaybackArbiter } from "./features/voice/playback-arbiter.ts";
import { SpeechButton } from "./features/voice/speech-button.tsx";
import type { SpeechController } from "./features/voice/speech-controller.ts";
import type { SpeechControllerSource } from "./features/voice/types.ts";
import { useLiveSpeech } from "./features/voice/use-live-speech.ts";
import type { PiConnectionStore } from "./lib/connection-controller.ts";
import type { SessionBrowserStore } from "./lib/session-controller.ts";

export interface AppProps {
	connection: PiConnectionStore;
	sessions: SessionBrowserStore;
	variant?: "standalone" | "admin";
	contextHeader?: ReactNode;
	enableVoice?: boolean;
}

const EMPTY_PROMPTS = [
	"梳理这个项目的核心架构",
	"检查最近的代码改动",
	"定位一个难以复现的问题",
	"为下一阶段制定实施计划",
];

const THEME_STORAGE_KEY = "pi-web-theme";

export function ConversationWorkspace({
	connection,
	sessions,
	variant = "standalone",
	contextHeader,
	enableVoice = true,
}: AppProps) {
	const connectionSnapshot = useSyncExternalStore(
		connection.subscribe,
		connection.getSnapshot,
		connection.getSnapshot,
	);
	const sessionSnapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot);
	const connected = connectionSnapshot.state === "connected";
	const client = (
		connection as unknown as {
			client?: SpeechControllerSource & {
				getLiveSpeechHandle?: (id: string) => LiveSpeechJobHandle | undefined;
				onLiveSpeechJob?: (listener: (handle: LiveSpeechJobHandle) => void) => () => void;
			};
		}
	).client;
	const baseUrl = useMemo(() => deriveSpeechHttpBaseUrl(), []);
	const webToken = useMemo(() => deriveSpeechWebToken(), []);
	const arbiterRef = useRef<PlaybackArbiter | undefined>(undefined);
	const arbiterDisposeGenerationRef = useRef(0);
	if (!arbiterRef.current && client) {
		arbiterRef.current = new PlaybackArbiter({
			source: client,
			baseUrl,
			token: webToken,
		});
	}
	const arbiter = arbiterRef.current;
	const speech = enableVoice ? arbiter?.manual : undefined;
	const [liveHint, setLiveHint] = useState<string | undefined>(undefined);
	const live = useLiveSpeech({
		snapshot: client?.snapshot,
		sessionId: sessionSnapshot.activeSessionId,
		connectionState: connectionSnapshot.state,
		arbiter,
		onUnlockFailed: (reason) => {
			setLiveHint(
				reason === "resume_rejected" || reason === "create_failed"
					? "浏览器阻止了自动播放，已改用文字模式；可在地址栏授权音频后再次发送。"
					: "本次未在用户手势内发起语音请求；已发送文字消息。",
			);
		},
	});
	useEffect(() => {
		if (!client?.onLiveSpeechJob) return undefined;
		return client.onLiveSpeechJob((handle) => {
			const matchesActiveSession = handle.job.sessionId === sessionSnapshot.activeSessionId;
			if (matchesActiveSession) live.bindHandle(handle);
		});
	}, [client, live.bindHandle, sessionSnapshot.activeSessionId]);

	const [message, setMessage] = useState("");
	const [sessionQuery, setSessionQuery] = useState("");
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const conversationScrollRef = useRef<HTMLDivElement>(null);
	const [theme, setTheme] = useState<VisualTheme>(() => {
		if (typeof window === "undefined") return "editorial";
		try {
			return window.localStorage.getItem(THEME_STORAGE_KEY) === "vision-glass" ? "vision-glass" : "editorial";
		} catch {
			return "editorial";
		}
	});
	const active = sessionSnapshot.activeSession;
	const activeId = active?.id;
	const hasActive = active !== undefined;
	const running = active !== undefined && active.phase !== "idle";
	const canSend = connected && active !== undefined && !sessionSnapshot.loading && !sessionSnapshot.submitting;
	const bootstrapping = !active && sessionSnapshot.loading && !connectionSnapshot.error;
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
		const attachmentIds = active?.attachments?.map((attachment) => attachment.id);
		// Phase 2 live朗读: ask the hook whether to attach `speech` before the
		// prompt leaves the page. The hook owns the AudioContext unlock and the
		// persisted toggle; this layer only wires it through.
		void (async () => {
			const prep = enableVoice ? await live.preparePrompt() : { attachSpeech: false };
			const baseOptions = attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : undefined;
			const options =
				prep.attachSpeech && baseOptions
					? { ...baseOptions, speech: { mode: "live" as const } }
					: prep.attachSpeech
						? { speech: { mode: "live" as const } }
						: baseOptions;
			const result = await sessions.send(message, options);
			setMessage("");
			if (result.liveSpeech && client?.getLiveSpeechHandle) {
				const handle = client.getLiveSpeechHandle(result.liveSpeech.id);
				if (handle) live.bindHandle(handle);
			}
		})().catch(() => {});
	};

	const dismissLiveHint = useCallback(() => setLiveHint(undefined), []);
	const handleFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
		const files = event.target.files ? [...event.target.files] : [];
		event.target.value = "";
		if (files.length === 0) return;
		void sessions.uploadFiles(files).catch(() => {});
	};
	const removeAttachment = (attachmentId: string) => void sessions.removeAttachment(attachmentId).catch(() => {});
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
		if (!connected || !hasActive || !activeId) return;
		const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
		return () => window.cancelAnimationFrame(frame);
	}, [activeId, connected, hasActive]);

	useEffect(() => {
		const element = conversationScrollRef.current;
		if (!element || !activeId) return;
		const frame = window.requestAnimationFrame(() => {
			element.scrollTop = element.scrollHeight;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [activeId]);

	useEffect(() => {
		const element = conversationScrollRef.current;
		if (!element || !active) return;
		const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
		if (distanceFromBottom < 180) {
			element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
		}
	}, [active]);

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

	// Stop playback (manual + live) when the active session changes, the
	// connection drops, the page hides, or the component unmounts. The arbiter
	// routes every path through both controllers so timers / readers / Audio
	// nodes / listeners are released regardless of which was active.
	const previousSessionIdRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (previousSessionIdRef.current === activeId) return;
		previousSessionIdRef.current = activeId;
		arbiter?.handleSessionChanged();
	}, [activeId, arbiter]);

	useEffect(() => {
		if (!connected) arbiter?.handleDisconnected();
	}, [connected, arbiter]);

	// pagehide is already handled inside useLiveSpeech via the arbiter; the
	// additional handler here also covers the SpeechController surface for
	// manual playback so both paths clean up identically.
	useEffect(() => {
		if (typeof window === "undefined" || !arbiter) return;
		const onPageHide = () => arbiter.handlePageHide();
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	}, [arbiter]);

	useEffect(() => {
		const generation = ++arbiterDisposeGenerationRef.current;
		return () => {
			// React StrictMode runs a development-only cleanup/setup probe. Delay
			// destructive teardown so that probe cannot dispose the live arbiter.
			window.setTimeout(() => {
				if (arbiterDisposeGenerationRef.current === generation) arbiter?.dispose();
			}, 0);
		};
	}, [arbiter]);

	return (
		<div className={`editorial-shell conversation-workspace conversation-workspace--${variant}`} data-theme={theme}>
			<ConversationSidebar
				open={sidebarOpen}
				connected={connected}
				bootstrapping={bootstrapping}
				query={sessionQuery}
				connection={connectionSnapshot}
				sessions={sessionSnapshot}
				visibleSessions={visibleSessions}
				onClose={() => setSidebarOpen(false)}
				onCreate={createSession}
				onQueryChange={setSessionQuery}
				onSelect={selectSession}
			/>

			<main className="chat-workspace">
				<WorkspaceMasthead
					connection={connectionSnapshot}
					theme={theme}
					onOpenNavigation={() => setSidebarOpen(true)}
					onThemeChange={setTheme}
				/>

				{contextHeader ? <div className="workspace-context-header">{contextHeader}</div> : null}

				{connectionSnapshot.error ? (
					<div className="connection-error" role="alert">
						<span>{connectionSnapshot.error}</span>
						<button type="button" onClick={handleConnection}>
							重新连接
						</button>
					</div>
				) : null}

				{liveHint ? (
					<output className="live-hint" aria-live="polite">
						<span>{liveHint}</span>
						<button type="button" onClick={dismissLiveHint} aria-label="关闭语音提示">
							×
						</button>
					</output>
				) : null}

				<div className="conversation-scroll" ref={conversationScrollRef}>
					{active ? (
						<Conversation
							active={active}
							abort={abort}
							speech={speech}
							arbiter={arbiter}
							livePlaybackState={live.playbackState}
							onStopLive={live.stop}
						/>
					) : bootstrapping ? (
						<StartupConversation />
					) : (
						<EmptyConversation connected={connected} createSession={createSession} setMessage={setMessage} />
					)}
				</div>
			</main>

			<ConversationComposer
				active={active}
				connected={connected}
				running={running}
				canSend={canSend}
				message={message}
				sessions={sessionSnapshot}
				composerRef={composerRef}
				fileInputRef={fileInputRef}
				voice={enableVoice ? speech?.voice : undefined}
				voiceEnabled={live.enabled}
				voiceAvailable={live.available}
				onVoiceChange={live.setEnabled}
				onSubmit={submitMessage}
				onMessageChange={handleMessageChange}
				onMessageKeyDown={handleMessageKeyDown}
				onFilesSelected={handleFilesSelected}
				onDismissUpload={(localId) => sessions.dismissUpload(localId)}
				onRemoveAttachment={removeAttachment}
				onAbort={abort}
			/>

			<button
				className={`scrim ${sidebarOpen ? "show" : ""}`}
				type="button"
				onClick={() => {
					setSidebarOpen(false);
				}}
				aria-label="关闭面板"
			/>
		</div>
	);
}

export function App(props: AppProps): React.ReactElement {
	return <ConversationWorkspace {...props} />;
}

function Conversation({
	active,
	abort,
	speech,
	arbiter,
	livePlaybackState,
	onStopLive,
}: {
	active: SessionSnapshot;
	abort: () => void;
	speech: SpeechController | undefined;
	arbiter: PlaybackArbiter | undefined;
	livePlaybackState: LivePlaybackState;
	onStopLive: () => void;
}) {
	const running = active.phase !== "idle";
	const liveActive = livePlaybackState !== "idle" && livePlaybackState !== "ended";
	// Identify the assistant item the live job is bound to: the first streaming
	// item from the current turn, or the last assistant item while the turn is
	// still running. The status row is anchored on this item so the user
	// always sees the live pill next to the message that's being spoken.
	const liveTargetId = useMemo(() => {
		if (!liveActive) return undefined;
		const streaming = active.transcript.find((item) => item.role === "assistant" && item.status === "streaming");
		if (streaming) return streaming.id;
		for (let index = active.transcript.length - 1; index >= 0; index -= 1) {
			const item = active.transcript[index];
			if (item && item.role === "assistant") return item.id;
		}
		return undefined;
	}, [active.transcript, liveActive]);
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
				<section className="agent-run-strip proc busy" aria-label="Agent 运行状态">
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
					active.transcript.map((item, index) => (
						<TranscriptItemView
							item={item}
							index={index}
							key={item.id}
							speech={speech}
							arbiter={arbiter}
							sessionId={active.id}
							liveState={item.id === liveTargetId ? livePlaybackState : "idle"}
							onStopLive={onStopLive}
						/>
					))
				) : (
					<EmptyTranscript />
				)}
			</section>
		</article>
	);
}

function TranscriptItemView({
	item,
	index,
	speech,
	arbiter,
	sessionId,
	liveState,
	onStopLive,
}: {
	item: TranscriptItem;
	index: number;
	speech: SpeechController | undefined;
	arbiter: PlaybackArbiter | undefined;
	sessionId: string;
	liveState: LivePlaybackState;
	onStopLive: () => void;
}) {
	if (item.role === "tool") {
		const status = item.status === "running" ? "正在执行" : item.status === "error" ? "执行失败" : "执行完成";
		return (
			<section className={`tool-event ${item.status}`}>
				<div className={`proc ${item.status === "running" ? "busy" : ""}`}>
					<span className="proc-dot" aria-hidden="true" />
					<span>
						{status}：<b>{item.toolName}</b>
					</span>
					<span className={`proc-status ${item.status === "running" ? "live" : ""}`}>{status}</span>
				</div>
				<details className="work tool-report" open={item.status === "error"}>
					<summary>
						<span className="work-chevron" aria-hidden="true">
							▸
						</span>
						查看工具输入与结果
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
			</section>
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
				<span className="answer-dot" aria-hidden="true" />
				<span>Assistant</span>
				<span className="answer-meta">
					· {item.model.provider} / {item.model.id} · {formatTime(item.timestamp)}
				</span>
			</header>
			<div className="answer-content prose">
				{item.content.map((content, contentIndex) => {
					if (content.type === "text")
						return (
							<div className="final-answer" key={`${item.id}-${contentIndex}`}>
								<MarkdownText text={content.text} />
							</div>
						);
					if (content.type === "thinking")
						return (
							<details className="thinking-note work" key={`${item.id}-${contentIndex}`}>
								<summary>
									<span className="work-chevron" aria-hidden="true">
										▸
									</span>
									<span>思考过程</span>
									<span className="thinking-toggle">展开查看</span>
								</summary>
								<div className="thinking-body">{content.redacted ? "推理内容已隐藏" : content.thinking}</div>
							</details>
						);
					return (
						<div className="inline-tool-call proc busy" key={`${item.id}-${contentIndex}`}>
							<span className="proc-dot" aria-hidden="true" />
							<span>准备调用工具</span>
							<strong>{content.toolName}</strong>
						</div>
					);
				})}
				{item.status === "streaming" ? <output className="streaming-indicator" aria-label="正在生成" /> : null}
			</div>
			<footer className="answer-actions">
				<span>ANSWER {String(index + 1).padStart(2, "0")}</span>
				<div className="answer-actions-controls">
					{liveState !== "idle" ? <LiveStatusRow state={liveState} onStop={onStopLive} /> : null}
					{speech?.voiceAvailable && item.status === "complete" ? (
						<SpeechButton
							speech={speech && arbiter ? wrapSpeechButtonApi(speech, arbiter) : speech}
							sessionId={sessionId}
							messageId={item.id}
						/>
					) : null}
					<button type="button">复制</button>
					<button type="button" disabled title="当前协议暂不支持重新生成">
						重新生成
					</button>
				</div>
			</footer>
		</section>
	);
}

function StartupConversation() {
	return (
		<section className="empty-conversation" aria-live="polite">
			<p>正在连接并恢复最近对话…</p>
		</section>
	);
}

function MarkdownText({ text }: { text: string }) {
	const fenceCount = text.match(/^```/gm)?.length ?? 0;
	const markdown = fenceCount % 2 === 0 ? text : `${text}\n\`\`\``;
	return (
		<div className="markdown-body">
			<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
				{markdown}
			</ReactMarkdown>
		</div>
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

function deriveSpeechHttpBaseUrl(): string {
	if (typeof window === "undefined") return "";
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const webSocketUrl = import.meta.env.VITE_PI_WS_URL ?? `${protocol}//${window.location.host}/api/pi/v1/ws`;
	return new URL(webSocketUrl).origin.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function deriveSpeechWebToken(): string | undefined {
	if (typeof window === "undefined") return undefined;
	return import.meta.env.VITE_PI_WEB_TOKEN;
}

/**
 * Wrap a {@link SpeechController} so its `speak()` call routes through the
 * page-level {@link PlaybackArbiter}. The arbiter stops any active live
 * playback before the new manual job opens (manual↔live mutex). Stop is a
 * thin pass-through because the controller already routes its own job.
 */
function wrapSpeechButtonApi(
	controller: SpeechController,
	arbiter: PlaybackArbiter,
): import("./features/voice/speech-button.tsx").SpeechButtonApi {
	return {
		get activeMessageId() {
			return controller.activeMessageId;
		},
		subscribe: (listener) => controller.subscribe(listener),
		getState: () => controller.getState(),
		speak: (sessionId, messageId, voiceProfileId) =>
			arbiter.startManual(sessionId, messageId, voiceProfileId).catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				console.error("无法开始手动朗读", detail);
				throw error;
			}),
		stop: () => controller.stop(),
	};
}
