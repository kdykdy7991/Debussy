import type { LiveSpeechJobHandle } from "@earendil-works/pi-client";
import type { SessionSnapshot } from "@earendil-works/pi-protocol";
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
import { type AgentReaction, detectAgentReaction } from "./conversation/agent-reaction.ts";
import { ActiveAgentPresence, AiMessageFlow } from "./conversation/ai-message-flow.tsx";
import { ConversationComposer } from "./conversation/conversation-composer.tsx";
import { ConversationSidebar } from "./conversation/conversation-sidebar.tsx";
import { type VisualTheme, WorkspaceMasthead } from "./conversation/workspace-masthead.tsx";
import type { LivePlaybackState } from "./features/voice/live-types.ts";
import { PlaybackArbiter } from "./features/voice/playback-arbiter.ts";
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
	enableUploads?: boolean;
	showSidebar?: boolean;
	/** 已绑定 Skill（发布版本能力，review doc §4.6）：支持 `/skill:` 补全。 */
	skills?: readonly { name: string; description?: string }[];
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
	enableUploads = true,
	showSidebar = true,
	skills,
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
	const [composerFocused, setComposerFocused] = useState(false);
	const [agentReaction, setAgentReaction] = useState<AgentReaction | undefined>(undefined);
	const agentReactionTimerRef = useRef<number | undefined>(undefined);
	const [sessionQuery, setSessionQuery] = useState("");
	const [sidebarOpen, setSidebarOpen] = useState(() => variant === "admin" && showSidebar);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const conversationScrollRef = useRef<HTMLDivElement>(null);
	const followConversationRef = useRef(true);
	const pendingConversationScrollFrameRef = useRef<number | undefined>(undefined);
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
	const resetComposerPresence = () => {
		composerRef.current?.blur();
		setComposerFocused(false);
		setAgentReaction(undefined);
		if (agentReactionTimerRef.current !== undefined) {
			window.clearTimeout(agentReactionTimerRef.current);
			agentReactionTimerRef.current = undefined;
		}
	};
	const createSession = () => {
		resetComposerPresence();
		void sessions.createSession().catch(() => {});
	};
	const selectSession = (sessionId: string) => {
		resetComposerPresence();
		setSidebarOpen(false);
		void sessions.selectSession(sessionId).catch(() => {});
	};
	const submitMessage = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!message.trim() || running) return;
		const submittedMessage = message;
		const reaction = detectAgentReaction(submittedMessage);
		if (reaction) {
			setAgentReaction(reaction);
			if (agentReactionTimerRef.current !== undefined) window.clearTimeout(agentReactionTimerRef.current);
			agentReactionTimerRef.current = window.setTimeout(() => {
				agentReactionTimerRef.current = undefined;
				setAgentReaction(undefined);
			}, 1600);
		}
		setMessage("");
		if (composerRef.current) composerRef.current.style.height = "auto";
		// Sending is an explicit request to return to the live edge. Once the
		// user scrolls up again, the scroll handler below releases this lock.
		followConversationRef.current = true;
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
			const result = await sessions.send(submittedMessage, options);
			if (result.liveSpeech && client?.getLiveSpeechHandle) {
				const handle = client.getLiveSpeechHandle(result.liveSpeech.id);
				if (handle) live.bindHandle(handle);
			}
		})().catch(() => {
			// Preserve a failed prompt without overwriting anything the user has
			// already started typing while the request was in flight.
			setMessage((current) => (current === "" ? submittedMessage : current));
		});
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

	useEffect(
		() => () => {
			if (agentReactionTimerRef.current !== undefined) window.clearTimeout(agentReactionTimerRef.current);
		},
		[],
	);

	const scheduleConversationScroll = useCallback((force = false) => {
		const element = conversationScrollRef.current;
		if (!element || (!force && !followConversationRef.current)) return;
		// Streaming can update several times within a paint. One direct write per
		// frame avoids competing `smooth` animations and keeps the transcript still.
		if (pendingConversationScrollFrameRef.current !== undefined) return;
		pendingConversationScrollFrameRef.current = window.requestAnimationFrame(() => {
			pendingConversationScrollFrameRef.current = undefined;
			const currentElement = conversationScrollRef.current;
			if (!currentElement || (!force && !followConversationRef.current)) return;
			currentElement.scrollTop = currentElement.scrollHeight;
		});
	}, []);

	const handleConversationScroll = useCallback(() => {
		const element = conversationScrollRef.current;
		if (!element) return;
		const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
		// Do not pull a reader back to the live edge while they inspect history.
		followConversationRef.current = distanceFromBottom < 96;
	}, []);

	useEffect(() => {
		if (!activeId) return;
		followConversationRef.current = true;
		scheduleConversationScroll(true);
	}, [activeId, scheduleConversationScroll]);

	useEffect(() => {
		if (active) scheduleConversationScroll();
	}, [active, scheduleConversationScroll]);

	useEffect(
		() => () => {
			if (pendingConversationScrollFrameRef.current !== undefined) {
				window.cancelAnimationFrame(pendingConversationScrollFrameRef.current);
			}
		},
		[],
	);

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
		<div
			className={`editorial-shell conversation-workspace conversation-workspace--${variant} ${
				sidebarOpen ? "" : "sidebar-collapsed"
			}`}
			data-theme={theme}
		>
			{showSidebar ? (
				<ConversationSidebar
					open={sidebarOpen}
					connected={connected}
					bootstrapping={bootstrapping}
					query={sessionQuery}
					connection={connectionSnapshot}
					sessions={sessionSnapshot}
					visibleSessions={visibleSessions}
					onToggle={variant === "admin" ? () => setSidebarOpen((open) => !open) : undefined}
					onCreate={createSession}
					onQueryChange={setSessionQuery}
					onSelect={selectSession}
				/>
			) : null}

			{showSidebar && variant === "admin" && !sidebarOpen ? (
				<button
					className="sidebar-reopen-button"
					type="button"
					onClick={() => setSidebarOpen(true)}
					aria-label="展开会话导航"
				>
					<svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true">
						<title>展开会话导航</title>
						<path
							d="m6.25 3.5 4.5 4.5-4.5 4.5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			) : null}

			<main className="chat-workspace">
				{variant !== "admin" ? (
					<WorkspaceMasthead
						connection={connectionSnapshot}
						theme={theme}
						open={sidebarOpen}
						onOpenNavigation={() => setSidebarOpen((open) => !open)}
						onThemeChange={setTheme}
					/>
				) : null}

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

				<div className="conversation-scroll" ref={conversationScrollRef} onScroll={handleConversationScroll}>
					{active ? (
						<Conversation
							active={active}
							speech={speech}
							arbiter={arbiter}
							livePlaybackState={live.playbackState}
							onStopLive={live.stop}
							showTitle={variant !== "admin"}
						/>
					) : bootstrapping ? (
						<StartupConversation />
					) : (
						<EmptyConversation connected={connected} createSession={createSession} setMessage={setMessage} />
					)}
				</div>
				{active ? (
					<ActiveAgentPresence
						key={active.id}
						active={active}
						composerFocused={composerFocused}
						reaction={agentReaction}
					/>
				) : null}
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
				uploadsEnabled={enableUploads}
				skills={skills}
				onSkillPick={(name) => setMessage(`/skill:${name} `)}
				onVoiceChange={live.setEnabled}
				onSubmit={submitMessage}
				onMessageChange={handleMessageChange}
				onMessageKeyDown={handleMessageKeyDown}
				onMessageFocus={() => setComposerFocused(true)}
				onMessageBlur={() => setComposerFocused(false)}
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
	speech,
	arbiter,
	livePlaybackState,
	onStopLive,
	showTitle,
}: {
	active: SessionSnapshot;
	speech: SpeechController | undefined;
	arbiter: PlaybackArbiter | undefined;
	livePlaybackState: LivePlaybackState;
	onStopLive: () => void;
	showTitle: boolean;
}) {
	return (
		<article className="conversation-article">
			{showTitle ? (
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
			) : null}

			<section className="message-flow" aria-live="polite">
				<AiMessageFlow
					active={active}
					speech={speech}
					arbiter={arbiter}
					livePlaybackState={livePlaybackState}
					onStopLive={onStopLive}
				/>
			</section>
		</article>
	);
}

function StartupConversation() {
	return (
		<section className="empty-conversation" aria-live="polite">
			<p>正在连接并恢复最近对话…</p>
		</section>
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

function deriveSpeechHttpBaseUrl(): string {
	if (typeof window === "undefined") return "";
	return import.meta.env.VITE_PI_SPEECH_HTTP_BASE_URL ?? window.location.origin;
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
