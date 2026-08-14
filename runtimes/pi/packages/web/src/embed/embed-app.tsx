import { useCallback, useEffect, useRef, useState } from "react";
import { EmbedApi, EmbedApiError } from "./api.ts";
import { EmbedAuthController } from "./auth-controller.ts";
import { EmbedConversationController } from "./conversation-controller.ts";
import { ConversationList } from "./conversation-list.tsx";
import { EmbedShell } from "./embed-shell.tsx";
import { EmbedErrorState } from "./error-state.tsx";
import type { BootstrapResponse, ChatMessage, ConversationSummary } from "./types.ts";

type Phase = "loading" | "error" | "ready";

export interface EmbedAppProps {
	readonly publicAppId: string;
	/** 测试注入。 */
	readonly api?: EmbedApi;
	readonly storage?: Storage;
}

/** Embed 应用根组件（TASK-019）：bootstrap -> 匿名 Exchange -> 会话 -> 聊天。 */
export function EmbedApp(props: EmbedAppProps): React.JSX.Element {
	const [phase, setPhase] = useState<Phase>("loading");
	const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
	const [conversations, setConversations] = useState<readonly ConversationSummary[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const controllersRef = useRef<{ auth: EmbedAuthController; conversations: EmbedConversationController } | null>(
		null,
	);
	const tokenRef = useRef<string | null>(null);
	const activeIdRef = useRef<string | null>(null);
	activeIdRef.current = activeId;

	const openConversation = useCallback(
		async (
			conversationId: string,
			token = tokenRef.current,
			controller = controllersRef.current?.conversations,
		): Promise<void> => {
			if (token === null || controller === undefined) return;
			const detail = await controller.open(token, conversationId);
			setActiveId(conversationId);
			setMessages(detail.messages);
		},
		[],
	);

	useEffect(() => {
		const api = props.api ?? new EmbedApi();
		const auth = new EmbedAuthController(api, props.storage ?? window.localStorage);
		const conversations = new EmbedConversationController(api);
		controllersRef.current = { auth, conversations };
		async function boot(): Promise<void> {
			try {
				const summary = await api.bootstrap(props.publicAppId);
				if (summary.status !== "active") throw new EmbedApiError("APP_SUSPENDED", "应用当前不可用", false);
				const state = await auth.signIn(props.publicAppId);
				tokenRef.current = state.accessToken;
				setBootstrap(summary);
				const items = await conversations.list(state.accessToken);
				setConversations(items);
				if (items.length > 0) {
					await openConversation(items[0]!.id, state.accessToken, conversations);
				}
				setPhase("ready");
			} catch (error) {
				setError(error instanceof EmbedApiError ? error.message : "加载失败");
				setPhase("error");
			}
		}
		void boot();
	}, [openConversation, props.api, props.publicAppId, props.storage]);

	const handleNew = useCallback(async (): Promise<void> => {
		const controller = controllersRef.current;
		const token = tokenRef.current;
		if (controller === null || token === null) return;
		try {
			const created = await controller.conversations.create(token);
			setConversations((items) => [created, ...items]);
			setActiveId(created.id);
			setMessages([]);
		} catch (error) {
			setError(error instanceof EmbedApiError ? error.message : "创建失败");
		}
	}, []);

	const handleSelect = useCallback(
		(conversationId: string): void => {
			void openConversation(conversationId);
		},
		[openConversation],
	);

	const handleSend = useCallback(async (text: string): Promise<void> => {
		const controller = controllersRef.current;
		const token = tokenRef.current;
		const conversationId = activeIdRef.current;
		if (controller === null || token === null || conversationId === null) return;
		setSending(true);
		setError(null);
		try {
			const userMessage: ChatMessage = { role: "user", text, sequence: -1 };
			setMessages((items) => [...items, userMessage]);
			const assistant = await controller.conversations.send(token, conversationId, text);
			setMessages((items) => [...items, assistant]);
		} catch (error) {
			const message = error instanceof EmbedApiError ? error.message : "发送失败";
			setMessages((items) => [...items, { role: "system", text: `发送失败：${message}`, sequence: -2 }]);
		} finally {
			setSending(false);
		}
	}, []);

	if (phase === "loading") {
		return (
			<EmbedShell title="加载中…" onSend={handleSend} sending={sending} disabled>
				<p className="embed-empty">正在连接…</p>
			</EmbedShell>
		);
	}
	if (phase === "error") {
		return (
			<div className="embed-shell">
				<EmbedErrorState message={error ?? "加载失败"} onRetry={() => window.location.reload()} />
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
	return (
		<EmbedShell title={summary.name} primaryColor={summary.theme.primaryColor} onSend={handleSend} sending={sending}>
			<div className="embed-layout">
				<ConversationList
					items={conversations}
					activeId={activeId}
					onSelect={handleSelect}
					onNew={() => void handleNew()}
				/>
				<main className="embed-chat" aria-live="polite">
					{error !== null && <p className="embed-inline-error">{error}</p>}
					{messages.length === 0 && <p className="embed-empty">{summary.theme.welcomeMessage ?? "开始对话吧"}</p>}
					{messages.map((message) => (
						<div key={`${message.role}-${message.sequence}`} className={`embed-message embed-${message.role}`}>
							{message.text}
						</div>
					))}
				</main>
			</div>
		</EmbedShell>
	);
}
