import { PiClient } from "@earendil-works/pi-client";
import type {
	AgentDefinitionDetail,
	AgentDefinitionSummary,
	AgentPublicId,
	LlmAvailableModel,
	ModelRef,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConversationWorkspace } from "../../app.tsx";
import { PiConnectionController } from "../../lib/connection-controller.ts";
import { LazyDebugSessionController, MutableEnsureAttachedRef } from "../../lib/lazy-debug-session-controller.ts";
import type { SessionController } from "../../lib/session-controller.ts";
import { createUploader } from "../../lib/uploader.ts";
import { createWebSocketTransportFactory } from "../../lib/websocket-transport.ts";
import { productReasoningEfforts } from "../agents/reasoning-efforts.ts";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";
import { LlmApi } from "../api/llm-api.ts";
import { SkillApi } from "../api/skill-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";

interface AgentOption {
	readonly id: AgentPublicId;
	readonly name: string;
	readonly currentRevision: number;
	readonly hasDraft: boolean;
}

type AgentListState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly AgentOption[] }
	| { readonly kind: "error"; readonly message: string };

type ModelsState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly LlmAvailableModel[] }
	| { readonly kind: "error"; readonly message: string };

interface ChatRuntime {
	readonly connection: PiConnectionController<PiClient>;
	readonly sessions: SessionController;
}

function requestedAgentIdFromHash(): AgentPublicId | null {
	if (typeof window === "undefined") return null;
	const queryIndex = window.location.hash.indexOf("?");
	if (queryIndex === -1) return null;
	const value = new URLSearchParams(window.location.hash.slice(queryIndex + 1)).get("agentId");
	return value !== null && /^agent_[0-9a-fA-F-]{36}$/.test(value) ? (value as AgentPublicId) : null;
}

/**
 * Stable identity of the WS debug session this page should be bound to.
 *
 * The interactive Agent Chat streams over the persistent DebugConversation
 * path for a bound Agent: the session identity is the AGENT's conversation,
 * never the revision (a revision change is handled per-Turn server-side). A
 * bound-Agent session key is therefore agent-only; the plain (no imported
 * Agent) path keys on model so its legacy ephemeral session still turns over.
 */
function debugSessionKeyFor(args: { readonly agentId: AgentPublicId | null; readonly model: ModelRef | null }): string {
	if (args.agentId === null) {
		const modelKey = args.model !== null ? `${args.model.provider}/${args.model.id}` : "default";
		return `plain:${modelKey}`;
	}
	return `agent:${args.agentId}`;
}

function describeDebugSessionError(error: unknown): string {
	return error instanceof Error ? error.message : "调试会话建立失败";
}

function ThinkingControl({
	model,
	sessions,
	defaultEffort,
}: {
	readonly model: LlmAvailableModel;
	readonly sessions: SessionController;
	readonly defaultEffort?: ThinkingLevel;
}) {
	const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot);
	const active = snapshot.activeSession;
	const efforts = productReasoningEfforts(model.parameterCapabilities.reasoning.efforts);
	if (efforts.length === 0) return null;
	const enabled = active?.thinkingLevel !== "off";
	const selectedEffort = efforts.some((effort) => effort.value === active?.thinkingLevel)
		? active?.thinkingLevel
		: defaultEffort && efforts.some((effort) => effort.value === defaultEffort)
			? defaultEffort
			: (model.parameterCapabilities.reasoning.defaultEffort ?? efforts[0]?.value ?? "");
	return (
		<>
			<label className="admin-thinking-switch">
				<span>深度思考</span>
				<input
					type="checkbox"
					checked={enabled}
					disabled={!active || active.phase !== "idle"}
					onChange={(event) =>
						void sessions.setThinking(event.currentTarget.checked ? (selectedEffort as ThinkingLevel) : "off")
					}
				/>
				<i aria-hidden="true" />
			</label>
			<label>
				<span>思考强度</span>
				<select
					aria-label="思考强度"
					value={selectedEffort}
					disabled={!active || active.phase !== "idle" || !enabled}
					onChange={(event) => void sessions.setThinking(event.currentTarget.value as ThinkingLevel)}
				>
					{efforts.map((effort) => (
						<option key={effort.value} value={effort.value}>
							{effort.label}
						</option>
					))}
				</select>
			</label>
		</>
	);
}

function ChatConnectionState({
	auth,
}: {
	readonly auth: ReturnType<typeof useAdminAuth>["snapshot"];
}): React.ReactElement {
	const isError = auth.state === "error";
	return (
		<section className="admin-chat-connection" aria-live="polite">
			<div className={`admin-chat-connection__card${isError ? " is-error" : ""}`}>
				<span className="admin-chat-connection__signal" aria-hidden="true">
					<span />
				</span>
				<p className="admin-chat-connection__eyebrow">ADMIN DEBUG SESSION</p>
				<h1>{isError ? "工作台连接失败" : "正在连接工作台"}</h1>
				<p className="admin-chat-connection__description">
					{isError
						? "无法建立管理员会话，请确认本地服务与控制平面正在运行。"
						: "正在验证管理员会话并准备 Chat 调试环境…"}
				</p>
				<div className="admin-chat-connection__status">
					<span className="admin-chat-connection__dot" aria-hidden="true" />
					<span>{isError ? "连接失败" : "连接中"}</span>
				</div>
				{isError ? (
					<>
						{auth.error ? <p className="admin-chat-connection__error">{auth.error}</p> : null}
						<button type="button" onClick={() => window.location.reload()}>
							重新连接
						</button>
					</>
				) : null}
			</div>
		</section>
	);
}

export function AdminChatPage(): React.ReactElement {
	const { controller, snapshot: auth } = useAdminAuth();
	const agentApiRef = useRef(new AgentApi({ auth: controller })).current;
	const llmApiRef = useRef(new LlmApi({ auth: controller })).current;
	const skillApiRef = useRef(new SkillApi({ auth: controller })).current;
	const requestedAgentIdRef = useRef(requestedAgentIdFromHash()).current;
	const debugSessionIdRef = useRef<string | null>(null);
	// Identity of the debug session the page is currently bound to (see
	// debugSessionKeyFor); used to skip needless destroy+recreate cycles.
	const debugSessionKeyRef = useRef<string | null>(null);
	// Strict-lazy bootstrap: opening Debug never creates a conversation when none
	// exists. `debugBootstrapRef.current` is the "ensure attached" hook the
	// LazyDebugSessionController invokes before a real send; `debugCreateGuardRef`
	// collapses double-clicks / rapid sends into ONE create promise per page.
	const debugBootstrapRef = useRef(new MutableEnsureAttachedRef());
	const debugCreateGuardRef = useRef<Promise<void> | null>(null);
	const [agents, setAgents] = useState<AgentListState>({ kind: "loading" });
	const [models, setModels] = useState<ModelsState>({ kind: "loading" });
	const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
	const [selectedAgentId, setSelectedAgentId] = useState<AgentPublicId | null>(null);
	const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentDefinitionDetail | null>(null);
	const [runtime, setRuntime] = useState<ChatRuntime | null>(null);
	const [debugSessionId, setDebugSessionId] = useState<string | null>(null);
	// Session-establishment failure surfaced in the context header with a
	// retry button (previously these failures were swallowed by `.catch`).
	const [debugSessionError, setDebugSessionError] = useState<string | null>(null);
	const [debugSessionRetry, setDebugSessionRetry] = useState(0);
	const [exporting, setExporting] = useState(false);
	// skillId -> { name, enabled } for resolving bound Skill references into the
	// Composer's `/skill:` completion list (Agent detail only carries skillIds).
	const [skillLookup, setSkillLookup] = useState<Map<
		string,
		{ readonly name: string; readonly enabled: boolean }
	> | null>(null);

	useEffect(() => {
		if (auth.state !== "connected") return;
		let cancelled = false;
		void agentApiRef.listAgents({ limit: 100 }).then(
			(result: unknown) => {
				if (cancelled) return;
				const response = result as { readonly items: readonly AgentDefinitionSummary[] };
				const items = response.items.map((agent) => ({
					id: agent.id as AgentPublicId,
					name: agent.name,
					currentRevision: agent.revision,
					hasDraft: false,
				}));
				setAgents({ kind: "loaded", items });
				setSelectedAgentId((current) => {
					if (requestedAgentIdRef !== null && items.some((item) => item.id === requestedAgentIdRef)) {
						return requestedAgentIdRef;
					}
					return current ?? items[0]?.id ?? null;
				});
			},
			(error: unknown) => {
				if (cancelled) return;
				setAgents({
					kind: "error",
					message: error instanceof AgentApiError ? error.message : "加载 Agent 列表失败",
				});
			},
		);
		return () => {
			cancelled = true;
		};
	}, [agentApiRef, auth.state, requestedAgentIdRef]);

	useEffect(() => {
		if (auth.state !== "connected") return;
		let cancelled = false;
		void llmApiRef.listModels().then(
			(result: unknown) => {
				if (cancelled) return;
				const response = result as { readonly items: readonly LlmAvailableModel[] };
				const items = response.items;
				setModels({ kind: "loaded", items });
				setSelectedModel((current) => current ?? (items[0] ? items[0] : null));
			},
			(error: unknown) => {
				if (cancelled) return;
				setModels({ kind: "error", message: error instanceof AgentApiError ? error.message : "加载模型列表失败" });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [llmApiRef, auth.state]);

	useEffect(() => {
		if (auth.state !== "connected") {
			setSkillLookup(null);
			return;
		}
		let cancelled = false;
		void skillApiRef.list(100).then(
			(result: unknown) => {
				if (cancelled) return;
				const response = result as {
					readonly items: readonly { readonly id: string; readonly name: string; readonly enabled: boolean }[];
				};
				const lookup = new Map<string, { readonly name: string; readonly enabled: boolean }>();
				for (const skill of response.items) lookup.set(skill.id, { name: skill.name, enabled: skill.enabled });
				setSkillLookup(lookup);
			},
			() => {
				if (!cancelled) setSkillLookup(null);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [skillApiRef, auth.state]);

	useEffect(() => {
		if (auth.state !== "connected" || selectedAgentId === null) {
			setSelectedAgentDetail(null);
			return;
		}
		let cancelled = false;
		void agentApiRef.getAgentDetail(selectedAgentId).then(
			(detail) => {
				if (cancelled) return;
				setSelectedAgentDetail(detail);
				if (models.kind === "loaded" && detail.modelId !== null) {
					const model = models.items.find((item) => item.id === detail.modelId);
					if (model !== undefined) setSelectedModel({ provider: model.provider, id: model.id });
				}
			},
			() => {
				if (!cancelled) setSelectedAgentDetail(null);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [agentApiRef, auth.state, models, selectedAgentId]);

	useEffect(() => {
		if (auth.state !== "connected") {
			setRuntime(null);
			return;
		}
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const websocketUrl = import.meta.env.VITE_PI_WS_URL ?? `${protocol}//${window.location.host}/api/pi/v1/ws`;
		const webToken = import.meta.env.VITE_PI_WEB_TOKEN;
		const client = new PiClient({
			transportFactory: createWebSocketTransportFactory({
				url: websocketUrl,
				...(webToken ? { protocols: [`pi-auth.${webToken}`] } : {}),
			}),
		});
		const connection = new PiConnectionController(client);
		const sessions = new LazyDebugSessionController(
			client,
			createUploader({
				baseUrl: new URL(websocketUrl).origin.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
				...(webToken ? { token: webToken } : {}),
			}),
			debugBootstrapRef.current,
		);
		const nextRuntime = { connection, sessions };
		setRuntime(nextRuntime);
		void connection.connect().catch(() => {});
		return () => {
			setRuntime((current) => (current === nextRuntime ? null : current));
			void sessions.dispose().finally(() => connection.dispose());
		};
	}, [auth.state]);

	useEffect(() => {
		// The "重新建立会话" button bumps `debugSessionRetry` solely to re-run this
		// effect (re-resolve the conversation); the value itself is not used.
		void debugSessionRetry;
		if (runtime === null) return;
		const selectedAgent =
			agents.kind === "loaded" && selectedAgentId !== null
				? agents.items.find((item) => item.id === selectedAgentId)
				: undefined;
		// While the agent is still resolving (list loading / entry missing),
		// do not touch the session — the next run settles it.
		if (selectedAgentId !== null && selectedAgent === undefined) return;
		// A bound Agent's conversation is keyed by the AGENT alone: a revision or
		// model change never recreates the WS session (resolved per-Turn server
		// side). The plain (no imported Agent) path still keys on model so its
		// legacy ephemeral session turns over.
		const sessionKey = debugSessionKeyFor({ agentId: selectedAgentId, model: selectedModel });
		// Key-based dedupe: only re-resolve when the (agent) or (model, for the
		// plain path) actually changed, so the agent detail finishing its load
		// does not detach + re-attach the same conversation.
		const active = runtime.sessions.activeHandle;
		if (
			debugSessionKeyRef.current === sessionKey &&
			debugSessionIdRef.current !== null &&
			active !== undefined &&
			active.active &&
			active.id === debugSessionIdRef.current
		) {
			return undefined;
		}
		let cancelled = false;
		void (async () => {
			setDebugSessionError(null);
			await runtime.connection.connect();
			if (cancelled) return;
			if (selectedAgent === undefined) {
				// 没有已导入 Agent：直接以当前所选模型开新会话。
				await runtime.sessions.createDebugSession(selectedModel ?? undefined);
				if (cancelled) return;
				debugSessionIdRef.current = runtime.sessions.activeHandle?.id ?? null;
				setDebugSessionId(debugSessionIdRef.current);
			} else {
				// Bound Agent: resume its persistent DebugConversation only.
				// Strict lazy-create — if none exists, the page stays EMPTY and a
				// DB conversation is NOT created. The first real user message
				// creates + attaches it via the send bootstrap. The identity is
				// the AGENT: a revision change never replaces the WS session.
				const resumed = await agentApiRef.resumeDebugConversation(selectedAgent.id);
				if (cancelled) return;
				if (resumed.conversation !== null) {
					const convId = resumed.conversation.conversationId;
					await runtime.sessions.openDebugSession(convId);
					if (cancelled) return;
					debugSessionIdRef.current = convId;
					debugSessionKeyRef.current = sessionKey;
					setDebugSessionId(convId);
				} else {
					// No conversation yet: stay empty, record the resolved-empty
					// binding so a later dep change is a cheap resume, not a create.
					// Clear the initial bootstrapping loading flag so the Composer is
					// usable; the first Send lazily creates + attaches the conversation.
					runtime.sessions.clearBootstrapping();
					debugSessionIdRef.current = null;
					debugSessionKeyRef.current = sessionKey;
					setDebugSessionId(null);
				}
			}
		})().catch((error: unknown) => {
			// 不再静默吞掉：会话建立失败必须在界面上可见，并允许重试。
			if (!cancelled) setDebugSessionError(describeDebugSessionError(error));
		});
		return () => {
			cancelled = true;
		};
	}, [agentApiRef, runtime, agents, selectedAgentId, selectedModel, debugSessionRetry]);

	// Strict lazy-create bootstrap: the LazyDebugSessionController invokes this
	// before EVERY send. It is a no-op once a conversation is attached; when a
	// bound Agent still has no DebugConversation, the first real message creates
	// + attaches it (and only then) before the send proceeds.
	useEffect(() => {
		const selectedAgent =
			agents.kind === "loaded" && selectedAgentId !== null
				? agents.items.find((agent) => agent.id === selectedAgentId)
				: undefined;
		debugBootstrapRef.current.current = async () => {
			if (debugSessionIdRef.current !== null) return; // already attached
			if (selectedAgent === undefined) return; // plain path is eager in the effect above
			if (debugCreateGuardRef.current !== null) {
				await debugCreateGuardRef.current; // collapse double-click / rapid sends
				return;
			}
			const guard = (async () => {
				setDebugSessionError(null);
				await runtime?.connection.connect();
				const resumed = await agentApiRef.resumeDebugConversation(selectedAgent.id);
				const convId =
					resumed.conversation !== null
						? resumed.conversation.conversationId
						: (await agentApiRef.createDebugConversation(selectedAgent.id)).conversation.conversationId;
				await runtime?.sessions.openDebugSession(convId);
				debugSessionIdRef.current = convId;
				setDebugSessionId(convId);
			})().catch((error: unknown) => {
				if (debugSessionIdRef.current === null) setDebugSessionError(describeDebugSessionError(error));
				throw error;
			});
			debugCreateGuardRef.current = guard;
			try {
				await guard;
			} finally {
				debugCreateGuardRef.current = null;
			}
		};
	}, [agentApiRef, runtime, agents, selectedAgentId]);

	useEffect(
		() => () => {
			// DebugConversations persist server-side: unlike the legacy ephemeral
			// debug-session path there is nothing to destroy on unmount.
			debugSessionIdRef.current = null;
			debugSessionKeyRef.current = null;
		},
		[],
	);

	if (auth.state !== "connected") {
		return <ChatConnectionState auth={auth} />;
	}
	if (runtime === null) {
		return <output className="admin-chat-loading">正在准备管理员调试工作区…</output>;
	}

	const hasAgents = agents.kind === "loaded" && agents.items.length > 0;
	const selected = hasAgents
		? (agents.items.find((agent) => agent.id === selectedAgentId) ?? agents.items[0])
		: undefined;
	const selectedModelMetadata =
		models.kind === "loaded"
			? models.items.find((model) => model.provider === selectedModel?.provider && model.id === selectedModel?.id)
			: undefined;
	// Resolve the agent's bound Skill references to names so `/skill:` completion
	// shows them. Only enabled skills are surfaced (runtime ignores disabled ones).
	const composerSkills =
		selectedAgentDetail?.skills !== undefined && skillLookup !== null
			? selectedAgentDetail.skills
					.map((binding) => skillLookup.get(binding.skillId))
					.filter(
						(skill): skill is { readonly name: string; readonly enabled: boolean } => skill?.enabled ?? false,
					)
					.map((skill) => ({ name: skill.name }))
			: undefined;
	const exportDebugSession = async () => {
		const sessionId = debugSessionIdRef.current;
		if (sessionId === null || exporting) return;
		setExporting(true);
		try {
			const payload = sessionId.startsWith("dconv_")
				? { conversationId: sessionId, events: await agentApiRef.listDebugConversationEvents(sessionId) }
				: await agentApiRef.exportDebugSession(sessionId);
			const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = `agent-debug-${sessionId}.json`;
			link.click();
			URL.revokeObjectURL(url);
		} finally {
			setExporting(false);
		}
	};
	return (
		<ConversationWorkspace
			connection={runtime.connection}
			sessions={runtime.sessions}
			variant="admin"
			enableVoice={false}
			skills={composerSkills}
			emptySendable={selected !== undefined && debugSessionId === null}
			contextHeader={
				<>
					<div>
						<span className="workspace-context-kicker">ADMIN DEBUG SESSION</span>
						<strong>{auth.tenant?.name ?? "当前租户"}</strong>
					</div>
					<output className="workspace-connection-status">
						<span aria-hidden="true" />
						已连接
					</output>
					{hasAgents ? (
						<label>
							<span>调试 Agent</span>
							<select
								aria-label="选择调试 Agent"
								value={selectedAgentId ?? ""}
								onChange={(event) => setSelectedAgentId(event.target.value as AgentPublicId)}
							>
								{agents.kind === "loaded"
									? agents.items.map((agent) => (
											<option value={agent.id} key={agent.id}>
												{agent.name}
												{agent.hasDraft ? "（含草稿）" : ""}
											</option>
										))
									: null}
							</select>
						</label>
					) : null}
					<label>
						<span>模型</span>
						<select
							aria-label="选择模型"
							value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""}
							onChange={(event) => {
								const raw = event.target.value;
								const slash = raw.indexOf("/");
								if (slash > 0 && raw.length > slash + 1) {
									setSelectedModel({ provider: raw.slice(0, slash), id: raw.slice(slash + 1) });
								}
							}}
						>
							{models.kind === "loaded"
								? models.items.map((model) => (
										<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
											{model.name}
										</option>
									))
								: null}
						</select>
					</label>
					{debugSessionError !== null ? (
						<div className="admin-debug-session-error" role="alert">
							<span>{debugSessionError}</span>
							<button type="button" onClick={() => setDebugSessionRetry((retry) => retry + 1)}>
								重新建立会话
							</button>
						</div>
					) : null}
					{selectedModelMetadata ? (
						<ThinkingControl
							model={selectedModelMetadata}
							sessions={runtime.sessions}
							defaultEffort={selectedAgentDetail?.parameters.reasoning?.effort as ThinkingLevel | undefined}
						/>
					) : null}
					<span className="workspace-revision">Revision #{selected?.currentRevision ?? "—"}</span>
					<button
						type="button"
						disabled={debugSessionId === null || exporting}
						onClick={() => void exportDebugSession()}
					>
						{exporting ? "导出中…" : "导出测试用例"}
					</button>
				</>
			}
		/>
	);
}
