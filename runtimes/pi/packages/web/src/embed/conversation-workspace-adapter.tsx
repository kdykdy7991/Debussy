import type {
	Attachment,
	ModelRef,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import { useMemo, useSyncExternalStore } from "react";
import { ConversationWorkspace } from "../app.tsx";
import type { PiConnectionSnapshot, PiConnectionStore } from "../lib/connection-controller.ts";
import type {
	SessionBrowserSnapshot,
	SessionBrowserStore,
	SessionPromptPayload,
	SessionSendResult,
} from "../lib/session-controller.ts";
import type { EmbedChatController, EmbedChatState } from "./chat-controller.ts";
import type { ChatAttachment, ChatMessage, ConversationSummary } from "./types.ts";
import type { VoiceAsrState } from "./voice-asr-session.ts";
import type { VoiceEngineStatus } from "./voice-engine-transport.ts";
import type { PublishedChatMode } from "./voice-mode.ts";
import type { VoiceTtsPhase } from "./voice-tts-session.ts";

/**
 * Embed owns authentication and wire transport, but it does not own a second
 * Chat UI. These stores adapt its real state/actions to the exact contracts
 * consumed by the control Chat's ConversationWorkspace.
 */
export function EmbedConversationWorkspace(props: {
	readonly title: string;
	readonly controller: EmbedChatController;
	/** 已绑定 Skill（发布版本能力）：传入后聊天输入支持 `/skill:` 补全。 */
	readonly skills?: readonly { name: string; description?: string }[];
	/**
	 * Task 5：发布页同源 Voice Engine WS 状态与 toggle 回调。仅当发布版
	 * 本 `features.realtimeVoice === true` 时由父组件传入。
	 */
	readonly voiceEngine?: {
		readonly status: VoiceEngineStatus;
		readonly asr: VoiceAsrState;
		readonly mode: PublishedChatMode;
		readonly tts: VoiceTtsPhase;
		readonly replyAudioEnabled: boolean;
		readonly onToggle: () => void;
		readonly onReplyAudioToggle: () => void;
		readonly onTextSubmit: () => void;
	};
}): React.JSX.Element {
	const stores = useMemo(() => createEmbedWorkspaceStores(props.controller), [props.controller]);
	const state = useSyncExternalStore(
		(listener) => props.controller.subscribe(listener),
		() => props.controller.getState(),
		() => props.controller.getState(),
	);
	return (
		<ConversationWorkspace
			connection={stores.connection}
			sessions={stores.sessions}
			variant="admin"
			showSidebar={state.newConversationsEnabled !== false}
			enableVoice={false}
			enableRealtimeVoice={props.voiceEngine !== undefined}
			voiceEngine={props.voiceEngine}
			enableUploads={state.uploadsEnabled}
			skills={props.skills}
			contextHeader={
				<>
					<div>
						<span className="workspace-context-kicker">PUBLISHED CHAT</span>
						<strong>{props.title}</strong>
					</div>
					<output className="workspace-connection-status">
						<span aria-hidden="true" />
						{connectionLabel(state.connectionStatus)}
					</output>
				</>
			}
		/>
	);
}

export function createEmbedWorkspaceStores(controller: EmbedChatController): {
	readonly connection: PiConnectionStore;
	readonly sessions: SessionBrowserStore;
} {
	let cachedConnection = connectionSnapshot(controller.getState());
	let cachedSessions = sessionSnapshot(controller.getState());
	const subscribe = (listener: () => void): (() => void) =>
		controller.subscribe(() => {
			const state = controller.getState();
			cachedConnection = connectionSnapshot(state);
			cachedSessions = sessionSnapshot(state);
			listener();
		});
	const connection: PiConnectionStore = {
		subscribe,
		getSnapshot: (): PiConnectionSnapshot => cachedConnection,
		connect: () => controller.reconnect(),
		disconnect: () => controller.close(),
	};
	const sessions: SessionBrowserStore = {
		subscribe,
		getSnapshot: (): SessionBrowserSnapshot => cachedSessions,
		createSession: async (_model?: ModelRef) => controller.newConversation(),
		createDebugSession: async (_model?: ModelRef) => controller.newConversation(),
		openDebugSession: async (sessionId: string) => controller.openConversation(sessionId),
		openDefaultSession: async () => {
			const first = controller.getState().conversations[0];
			if (first) await controller.openConversation(first.id);
			else await controller.newConversation();
		},
		selectSession: (sessionId) => controller.openConversation(sessionId),
		send: async (text: string, _options?: SessionPromptPayload): Promise<SessionSendResult> => {
			controller.send(text);
			const active = sessionSnapshot(controller.getState()).activeSession;
			if (!active) throw new Error("请先选择一个会话");
			return { session: active };
		},
		abort: async () => controller.cancel(),
		setThinking: async (_thinkingLevel: ThinkingLevel) => {},
		uploadFiles: async (files: File[]) => {
			for (const file of files) {
				await controller.uploadFile({
					filename: file.name,
					contentType: file.type || "application/octet-stream",
					data: new Uint8Array(await file.arrayBuffer()),
				});
			}
		},
		removeAttachment: (attachmentId) => controller.removeAttachment(attachmentId),
		dismissUpload: () => {},
		// The embed controller clears its error state on the next successful
		// action, so there is nothing extra to do on manual dismiss.
		clearError: () => {},
	};
	return { connection, sessions };
}

function connectionSnapshot(state: EmbedChatState): PiConnectionSnapshot {
	if (state.connectionStatus === "connected") return { state: "connected", error: undefined };
	// The workspace is rendered only after authentication + conversation-list
	// initialization. With an empty list there is intentionally no conversation
	// WebSocket yet; treating this idle state as disconnected would disable the
	// very action that creates the first conversation (a UI deadlock).
	if (state.connectionStatus === "idle" && state.error === null) return { state: "connected", error: undefined };
	if (state.connectionStatus === "connecting" || state.connectionStatus === "reconnecting") {
		return { state: "connecting", error: undefined };
	}
	return { state: "disconnected", error: state.error?.message };
}

function sessionSnapshot(state: EmbedChatState): SessionBrowserSnapshot {
	const sessions = state.conversations.map((conversation) => summaryFromConversation(conversation, state));
	const activeConversation = state.conversations.find((conversation) => conversation.id === state.activeId);
	return {
		sessions,
		activeSessionId: state.activeId ?? undefined,
		activeSession: activeConversation ? snapshotFromConversation(activeConversation, state) : undefined,
		uploads: [],
		loading: state.connectionStatus === "connecting" || state.connectionStatus === "reconnecting",
		submitting: state.sending || state.uploading,
		error: state.error?.message,
	};
}

function summaryFromConversation(conversation: ConversationSummary, state: EmbedChatState): SessionSummary {
	const createdAt = Date.parse(conversation.createdAt) || 0;
	return {
		id: conversation.id,
		name: conversation.title || undefined,
		cwd: "published",
		createdAt,
		updatedAt: createdAt + conversation.lastEventSequence,
		phase: conversation.id === state.activeId && state.sending ? "turn" : "idle",
		model: publishedModel(conversation),
		thinkingLevel: "off",
		attached: conversation.id === state.activeId,
		locked: conversation.id === state.activeId,
	};
}

function snapshotFromConversation(conversation: ConversationSummary, state: EmbedChatState): SessionSnapshot {
	return {
		...summaryFromConversation(conversation, state),
		lastSequence: conversation.lastEventSequence,
		revision: conversation.lastEventSequence,
		transcript: transcriptFromMessages(state.messages, conversation),
		queuedSteer: [],
		queuedSteerCount: 0,
		attachments: state.attachments.map(attachmentFromChat),
	};
}

function transcriptFromMessages(messages: readonly ChatMessage[], conversation: ConversationSummary): TranscriptItem[] {
	const model = publishedModel(conversation);
	const transcript: TranscriptItem[] = [];
	for (const [index, message] of messages.entries()) {
		const id = message.id ?? `embed-${message.role}-${message.sequence}-${index}`;
		const timestamp = Math.max(0, message.sequence);
		if (message.role === "user") {
			transcript.push({ id, role: "user", content: [{ type: "text", text: message.text }], timestamp });
			continue;
		}
		const assistantContent = [
			...(message.thinking ? [{ type: "thinking" as const, thinking: message.thinking }] : []),
			...(message.text ? [{ type: "text" as const, text: message.text }] : []),
		];
		transcript.push(
			message.role === "system"
				? {
						id,
						role: "assistant",
						content: assistantContent,
						model,
						timestamp,
						status: "error",
						stopReason: "error",
						errorMessage: message.text,
					}
				: message.streaming
					? { id, role: "assistant", content: assistantContent, model, timestamp, status: "streaming" }
					: {
							id,
							role: "assistant",
							content: assistantContent,
							model,
							timestamp,
							status: "complete",
							stopReason: "stop",
						},
		);
		for (const tool of message.tools ?? []) {
			const base = {
				id: tool.id,
				role: "tool" as const,
				toolCallId: tool.id,
				toolName: tool.name,
				input: {},
				content: [],
				timestamp,
			};
			transcript.push(
				tool.status === "running"
					? { ...base, status: "running", isError: false }
					: tool.status === "failed"
						? { ...base, status: "error", isError: true }
						: { ...base, status: "complete", isError: false },
			);
		}
	}
	return transcript;
}

function attachmentFromChat(attachment: ChatAttachment): Attachment {
	const allowed = new Set<Attachment["status"]>([
		"uploading",
		"scanning",
		"parsing",
		"indexing",
		"ready",
		"restricted",
		"failed",
		"removed",
	]);
	return {
		id: attachment.attachmentId,
		name: attachment.filename,
		mediaType: attachment.contentType,
		size: attachment.sizeBytes,
		sha256: attachment.checksumSha256,
		status: allowed.has(attachment.status as Attachment["status"])
			? (attachment.status as Attachment["status"])
			: "ready",
		createdAt: Date.parse(attachment.createdAt) || 0,
	};
}

function publishedModel(conversation: ConversationSummary): ModelRef {
	return { provider: "published", id: conversation.publishedAppVersionId };
}

function connectionLabel(status: EmbedChatState["connectionStatus"]): string {
	switch (status) {
		case "connected":
			return "已连接";
		case "reconnecting":
			return "正在重连";
		case "closed":
			return "连接已断开";
		case "idle":
			return "可新建对话";
		case "connecting":
			return "正在连接";
	}
}
