import { useCallback, useEffect, useRef, useState } from "react";
import { EmbedApi, EmbedApiError } from "./api.ts";
import { EmbedAuthController } from "./auth-controller.ts";
import { EmbedChatController } from "./chat-controller.ts";
import { EmbedConversationWorkspace } from "./conversation-workspace-adapter.tsx";
import { EmbedShell } from "./embed-shell.tsx";
import { EmbedErrorState } from "./error-state.tsx";
import { EmbedPostMessageChannel } from "./post-message.ts";
import type { WebSocketLike } from "./realtime-transport.ts";
import type { BootstrapResponse } from "./types.ts";

type Phase = "loading" | "error" | "ready";
type EmbedMode = "anonymous" | "signed_user" | "preview";

export interface EmbedAppProps {
	readonly publicAppId: string;
	/**
	 * WB-005: when set, runs the app in preview mode. The ticket is exchanged
	 * for a short-lived token pinned to a specific (admin-chosen) version;
	 * no postMessage channel is opened (preview is admin-only, not iframe).
	 */
	readonly previewTicket?: string;
	/** 测试注入。 */
	readonly api?: EmbedApi;
	readonly storage?: Storage;
	readonly wsFactory?: (url: string) => WebSocketLike;
}

/** 宿主可接受的 resize 高度上限（与协议包 POST_MESSAGE_RESIZE_MAX_HEIGHT 一致）。 */
const RESIZE_MAX_HEIGHT = 100000;

/** Embed 应用根组件（TASK-019/029/033）：bootstrap -> 认证 -> 会话 -> 聊天。 */
export function EmbedApp(props: EmbedAppProps): React.JSX.Element {
	const [phase, setPhase] = useState<Phase>("loading");
	const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const controllersRef = useRef<{ auth: EmbedAuthController; chat: EmbedChatController } | null>(null);
	const channelRef = useRef<EmbedPostMessageChannel | null>(null);
	const hostOriginRef = useRef<string | null>(null);

	/** 计算 iframe 内容高度并回发宿主（resize-request / 尺寸变化 / ready 后）。 */
	const reportHeight = useCallback((): void => {
		const channel = channelRef.current;
		if (channel === null) return;
		const height = Math.min(document.documentElement.scrollHeight, RESIZE_MAX_HEIGHT);
		channel.send({ type: "resize", height });
	}, []);

	const focusComposer = useCallback((): void => {
		document.getElementById("message")?.focus();
	}, []);

	/** 认证 + 会话加载（匿名直接进入；signed_user 用宿主 init 的 Launch Token）。 */
	const signInAndLoad = useCallback(
		async (mode: EmbedMode, launchToken?: string, hostOrigin?: string): Promise<void> => {
			const controllers = controllersRef.current;
			const channel = channelRef.current;
			if (controllers === null) return;
			if (mode === "signed_user" && launchToken === undefined) {
				throw new EmbedApiError("INVALID_INIT", "宿主未提供 Launch Token", false);
			}
			if (mode !== "preview" && hostOrigin === undefined) {
				throw new EmbedApiError("INVALID_INIT", "无法确认宿主 Origin", false);
			}
			const state =
				mode === "signed_user"
					? await controllers.auth.signInWithLaunchToken(props.publicAppId, launchToken!, hostOrigin!)
					: mode === "preview"
						? await controllers.auth.signInWithPreviewTicket(props.publicAppId, props.previewTicket ?? "")
						: await controllers.auth.signIn(props.publicAppId, hostOrigin!);
			// PD-18：launchToken 即用即弃（此处不留存任何引用）。
			await controllers.chat.initialize(state.features);
			setPhase("ready");
			if (mode !== "preview") {
				// WB-005: preview never postMessages the host (admin-only tab).
				channel?.send({ type: "ready", publicAppId: props.publicAppId, mode });
			}
			focusComposer();
		},
		[focusComposer, props.publicAppId, props.previewTicket],
	);

	const handleLogout = useCallback(
		async (mode: EmbedMode): Promise<void> => {
			const controllers = controllersRef.current;
			if (controllers === null) return;
			await controllers.auth.logout();
			controllers.chat.reset();
			setBootstrap(null);
			setPhase("loading");
			if (mode === "anonymous") {
				// 匿名模式无宿主会话：logout 后直接重新匿名进入。
				const hostOrigin = hostOriginRef.current;
				if (hostOrigin === null) throw new EmbedApiError("INVALID_INIT", "无法确认宿主 Origin", false);
				await signInAndLoad("anonymous", undefined, hostOrigin);
			}
			// signed_user：等宿主重新 `init`（channel 仍在监听）。
		},
		[signInAndLoad],
	);

	useEffect(() => {
		const api = props.api ?? new EmbedApi();
		const auth = new EmbedAuthController(api, props.storage ?? window.localStorage);
		const chat = new EmbedChatController({
			api,
			getToken: async () => {
				if (!auth.hasToken) throw new EmbedApiError("NOT_SIGNED_IN", "尚未完成身份交换", false);
				try {
					return auth.getToken();
				} catch {
					// 匿名可透明刷新；signed_user 过期抛 AUTH_EXPIRED。
					const hostOrigin = hostOriginRef.current;
					if (hostOrigin === null) throw new EmbedApiError("INVALID_INIT", "无法确认宿主 Origin", false);
					return (await auth.refresh(props.publicAppId, hostOrigin)).accessToken;
				}
			},
			onAuthFailure: (authError) => {
				// signed_user 无法静默刷新：清理凭据，等待宿主重新 init。
				void handleLogout("signed_user").then(() => setError(authError.message));
			},
			onConversationCreated: () => {
				// WB-010: 会话新建后回发宿主（仅非 preview 场景；preview 无宿主）。
				if (props.previewTicket !== undefined) return;
				const conv = chat.getState().activeId;
				if (conv !== null) {
					channel?.send({ type: "conversation-created", publicAppId: props.publicAppId, conversationId: conv });
				}
			},
			wsFactory: props.wsFactory,
		});
		controllersRef.current = { auth, chat };
		let channel: EmbedPostMessageChannel | undefined;
		let mode: EmbedMode = "anonymous";

		async function boot(): Promise<void> {
			if (props.previewTicket !== undefined) {
				// WB-005: preview mode skips postMessage channel (no host).
				mode = "preview";
				const summary = await api.bootstrap(props.publicAppId);
				setBootstrap(summary);
				await signInAndLoad("preview");
				return;
			}
			const summary = await api.bootstrap(props.publicAppId);
			if (summary.status !== "active") throw new EmbedApiError("APP_SUSPENDED", "应用当前不可用", false);
			setBootstrap(summary);
			hostOriginRef.current = originFromReferrer(document.referrer, summary.allowedOrigins);
			mode = summary.accessMode === "signed_user" ? "signed_user" : "anonymous";
			channel = new EmbedPostMessageChannel({
				window: window,
				parent: window.parent,
				allowedOrigins: summary.allowedOrigins,
				onInit: (launchToken, hostOrigin) => {
					hostOriginRef.current = hostOrigin;
					// anonymous/mixed：MVP 不切换身份（HANDOFF 记录）；signed_user
					// 身份只来自宿主 init 的 Launch Token（AD-11）。
					if (mode !== "signed_user") return;
					void signInAndLoad("signed_user", launchToken, hostOrigin).catch((caught: unknown) => {
						setError(caught instanceof EmbedApiError ? caught.message : "宿主初始化失败");
						setPhase("error");
					});
				},
				onLogout: () => void handleLogout(mode),
				onFocus: focusComposer,
				onResizeRequest: reportHeight,
			});
			channelRef.current = channel;
			channel.start();
			if (mode === "anonymous") {
				// anonymous / mixed：直接匿名进入；若嵌在宿主页中回发 ready。
				const hostOrigin = hostOriginRef.current;
				if (hostOrigin === null) throw new EmbedApiError("INVALID_INIT", "无法确认宿主 Origin", false);
				await signInAndLoad("anonymous", undefined, hostOrigin);
			}
			// signed_user：身份只来自宿主 postMessage init（AD-11），等待 onInit。
		}
		void boot().catch((caught: unknown) => {
			setError(caught instanceof EmbedApiError ? caught.message : "加载失败");
			setPhase("error");
		});
		const onWindowResize = (): void => {
			// 防抖：宿主页/iframe 尺寸变化后重新上报高度。
			window.setTimeout(reportHeight, 200);
		};
		window.addEventListener("resize", onWindowResize);
		return () => {
			window.removeEventListener("resize", onWindowResize);
			channel?.stop();
			chat.close();
		};
	}, [
		focusComposer,
		handleLogout,
		props.api,
		props.publicAppId,
		props.previewTicket,
		props.storage,
		props.wsFactory,
		reportHeight,
		signInAndLoad,
	]);

	if (phase === "loading") {
		return (
			<EmbedShell title="加载中…" onSend={() => {}} sending={false} disabled>
				<p className="embed-empty">正在连接…</p>
			</EmbedShell>
		);
	}
	if (phase === "error") {
		return (
			<div className="embed-shell">
				<EmbedErrorState
					message={error ?? "加载失败"}
					onRetry={props.previewTicket === undefined ? () => window.location.reload() : () => window.close()}
					retryLabel={props.previewTicket === undefined ? undefined : "关闭并重新预览"}
				/>
			</div>
		);
	}
	const summary = bootstrap;
	if (summary === null) {
		return (
			<div className="embed-shell">
				<EmbedErrorState message="应用摘要缺失" onRetry={() => window.location.reload()} />
			</div>
		);
	}
	const chatController = controllersRef.current?.chat;
	if (chatController === undefined)
		return <EmbedErrorState message="会话控制器未就绪" onRetry={() => window.location.reload()} />;
	return <EmbedConversationWorkspace title={summary.name} controller={chatController} />;
	/* Legacy EmbedShell fallback retained below temporarily for migration reference.
	return (
		<>
			{props.previewTicket !== undefined && (
				<p className="embed-preview-banner">预览模式：此对话固定使用待上线版本，不影响线上用户。</p>
			)}
			<EmbedShell
				title={summary.name}
				primaryColor={summary.theme.primaryColor}
				onSend={handleSend}
				sending={chatState.sending}
				connectionStatus={chatState.connectionStatus}
				uploadsEnabled={chatState.uploadsEnabled}
				uploading={chatState.uploading}
				onUpload={handleUpload}
				inputRef={inputRef}
				attachments={
					chatState.attachments.length > 0 ? (
						<ul className="embed-attachments" aria-label="已上传附件">
							{chatState.attachments.map((attachment) => (
								<li key={attachment.attachmentId} className="embed-attachment">
									<span className="embed-attachment-name">{attachment.filename}</span>
									<button
										type="button"
										className="embed-attachment-remove"
										aria-label={`移除附件：${attachment.filename}`}
										onClick={() =>
											void controllersRef.current?.chat.removeAttachment(attachment.attachmentId)
										}
									>
										×
									</button>
								</li>
							))}
						</ul>
					) : undefined
				}
				headerExtra={
					<button
						type="button"
						className="embed-button embed-list-toggle"
						aria-expanded={showList}
						onClick={() => setShowList((open) => !open)}
					>
						{showList ? "关闭列表" : "会话列表"}
					</button>
				}
			>
				<div className={`embed-layout${showList ? " is-list-open" : ""}`}>
					<ConversationList
						items={chatState.conversations}
						activeId={activeConversationId}
						onSelect={handleSelect}
						onNew={handleNew}
						onArchive={(id) => {
							if (id === activeConversationId) {
								handleArchive();
							} else {
								// 归档非当前会话：先切换过去再归档。
								void controllersRef.current?.chat.openConversation(id).then(() => handleArchive());
							}
						}}
					/>
					<main className="embed-chat" aria-live="polite">
						{errorBanner !== null && (
							<p className="embed-inline-error" role="alert">
								{errorBanner.message}
							</p>
						)}
						{chatState.messages.length === 0 && (
							<p className="embed-empty">{summary.theme.welcomeMessage ?? "开始对话吧"}</p>
						)}
						{chatState.messages.map((message) => (
							<MessageBubble key={message.id ?? `${message.role}-${message.sequence}`} message={message} />
						))}
					</main>
				</div>
			</EmbedShell>
		</>
	); */
}

export function originFromReferrer(referrer: string, allowedOrigins: readonly string[]): string | null {
	if (referrer === "") return null;
	try {
		const origin = new URL(referrer).origin;
		return allowedOrigins.includes(origin) ? origin : null;
	} catch {
		return null;
	}
}
