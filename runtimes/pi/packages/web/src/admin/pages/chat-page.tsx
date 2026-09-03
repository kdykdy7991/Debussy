import { PiClient } from "@earendil-works/pi-client";
import type {
	AgentDefinitionDetail,
	AgentDefinitionSummary,
	AgentPublicId,
	LlmAvailableModel,
	ModelRef,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationWorkspace } from "../../app.tsx";
import { useVoiceMode } from "../../features/voice/use-voice-mode.ts";
import { PiConnectionController } from "../../lib/connection-controller.ts";
import { LazyDebugSessionController, MutableEnsureAttachedRef } from "../../lib/lazy-debug-session-controller.ts";
import type { SessionController } from "../../lib/session-controller.ts";
import { createUploader } from "../../lib/uploader.ts";
import { createWebSocketTransportFactory } from "../../lib/websocket-transport.ts";
import { AgentApi, AgentApiError, type DebugConversationListItem } from "../api/agent-api.ts";
import { LlmApi } from "../api/llm-api.ts";
import { SkillApi } from "../api/skill-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { DebugHistoryPanel, type DebugHistoryState } from "../components/debug-history-panel.tsx";
import { navigate } from "../router.ts";

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

function DebugConfigurationSummary({
	model,
	agent,
}: {
	readonly model: LlmAvailableModel | undefined;
	readonly agent: AgentDefinitionDetail | null;
}) {
	const reasoning = agent?.parameters.reasoning;
	const capability = model?.parameterCapabilities.reasoning;
	const enabledLabel =
		reasoning?.enabled === true ? "已开启" : reasoning?.enabled === false ? "已关闭" : "跟随模型默认";
	const effortLabel = reasoning?.effort ?? capability?.defaultEffort ?? "模型默认";
	return (
		<dl className="debug-config-summary" aria-label="Agent Revision 调试配置">
			<div>
				<dt>模型</dt>
				<dd>{model?.name ?? agent?.modelId ?? "未配置"}</dd>
			</div>
			{capability?.supported ? (
				<>
					<div>
						<dt>深度思考</dt>
						<dd>{enabledLabel}</dd>
					</div>
					<div>
						<dt>思考强度</dt>
						<dd>{effortLabel}</dd>
					</div>
				</>
			) : null}
		</dl>
	);
}

/* ------------------------------------------------------------------
 * v2 redesign: top-bar chips (模型 / 思考 / 思考强度)
 * ------------------------------------------------------------------ */

function ChipCubeIcon(): React.ReactElement {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" focusable="false" aria-hidden="true">
			<path
				d="M8 2.5 13 5v6L8 13.5 3 11V5l5-2.5Z"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinejoin="round"
				fill="none"
			/>
			<path d="M3 5l5 2.5L13 5M8 7.5v6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
		</svg>
	);
}

function ChipBulbIcon(): React.ReactElement {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" focusable="false" aria-hidden="true">
			<path
				d="M8 2.5a3.5 3.5 0 0 0-2 6.34V11h4V8.84A3.5 3.5 0 0 0 8 2.5Z"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinejoin="round"
				fill="none"
			/>
			<path d="M6.5 12.5h3M7 14h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
		</svg>
	);
}

function ChipBarsIcon(): React.ReactElement {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" focusable="false" aria-hidden="true">
			<path d="M3 12V8M6.5 12V5M10 12V9M13 12V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
		</svg>
	);
}

function DebugModelChip({ model }: { readonly model: LlmAvailableModel | undefined }): React.ReactElement {
	return (
		<div className="admin-debug-chip" role="group" aria-label="模型">
			<span className="admin-debug-chip__icon" aria-hidden="true">
				<ChipCubeIcon />
			</span>
			<div className="admin-debug-chip__body">
				<span className="admin-debug-chip__label">模型</span>
				<span className="admin-debug-chip__value" title={model?.id ?? ""}>
					{model?.id ?? "未选择"}
				</span>
			</div>
		</div>
	);
}

function DebugThinkingChip({
	agent,
	model,
}: {
	readonly agent: AgentDefinitionDetail | null;
	readonly model: LlmAvailableModel | undefined;
}): React.ReactElement {
	const reasoning = agent?.parameters.reasoning;
	const capabilitySupported = model?.parameterCapabilities.reasoning.supported ?? false;
	const explicitlyOn = reasoning?.enabled === true;
	const explicitlyOff = reasoning?.enabled === false;
	const enabled = explicitlyOn || (!explicitlyOff && capabilitySupported);
	const label = enabled ? "已启用" : "未启用";
	return (
		<div className={`admin-debug-chip ${enabled ? "is-on" : "is-off"}`} role="group" aria-label="思考">
			<span className="admin-debug-chip__icon" aria-hidden="true">
				<ChipBulbIcon />
			</span>
			<div className="admin-debug-chip__body">
				<span className="admin-debug-chip__label">思考</span>
				<span className="admin-debug-chip__value">
					{label}
					{enabled ? <span className="admin-debug-chip__dot" aria-hidden="true" /> : null}
				</span>
			</div>
		</div>
	);
}

function DebugThinkingEffortChip({
	agent,
	model,
}: {
	readonly agent: AgentDefinitionDetail | null;
	readonly model: LlmAvailableModel | undefined;
}): React.ReactElement {
	const reasoning = agent?.parameters.reasoning;
	const capability = model?.parameterCapabilities.reasoning;
	const effort = reasoning?.effort ?? capability?.defaultEffort ?? null;
	const display = effort ?? "未设置";
	return (
		<div className="admin-debug-chip" role="group" aria-label="思考强度">
			<span className="admin-debug-chip__icon" aria-hidden="true">
				<ChipBarsIcon />
			</span>
			<div className="admin-debug-chip__body">
				<span className="admin-debug-chip__label">思考强度</span>
				<span className="admin-debug-chip__value">{display}</span>
			</div>
		</div>
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
	// Phase 2E explicit-new flag. Set when the user clicks "New Conversation";
	// cleared when (a) the user picks an existing conversation from the
	// History list, (b) the agent changes, or (c) the bootstrap successfully
	// creates + attaches a brand-new conversation. While true, the bootstrap
	// skips `resumeDebugConversation` and goes directly to
	// `createDebugConversation` so the next send never resurrects the
	// previously-active conversation.
	const explicitNewRef = useRef<boolean>(false);
	const [agents, setAgents] = useState<AgentListState>({ kind: "loading" });
	const [models, setModels] = useState<ModelsState>({ kind: "loading" });
	const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
	const [selectedAgentId, setSelectedAgentId] = useState<AgentPublicId | null>(null);
	const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentDefinitionDetail | null>(null);
	const [runtime, setRuntime] = useState<ChatRuntime | null>(null);
	const [debugSessionId, setDebugSessionId] = useState<string | null>(null);
	const realtimeVoiceAvailable = selectedAgentDetail?.capabilities.realtimeVoice === true;
	// Voice MVP: reuses the same VoiceEngineTransport / VoiceAsrSession /
	// VoiceTtsSession stack the published chat uses; the admin bearer is
	// forwarded so the ticket endpoint (when reachable) issues a usable ticket.
	const adminWebToken = import.meta.env.VITE_PI_WEB_TOKEN;
	const voiceEngine = useVoiceMode({ token: adminWebToken, available: realtimeVoiceAvailable });
	// skillId -> { name, enabled } for resolving bound Skill references into the
	// Composer's `/skill:` completion list (Agent detail only carries skillIds).
	const [skillLookup, setSkillLookup] = useState<Map<
		string,
		{ readonly name: string; readonly enabled: boolean }
	> | null>(null);
	// Phase 2E: History panel state. The list is re-fetched on agent change
	// and after every successful Turn (lastSequence bump), not on a timer —
	// the panel always reflects the conversation's last persisted activity.
	const [history, setHistory] = useState<DebugHistoryState>({ kind: "idle" });
	// v2 redesign: history is now a right-side *floating* overlay (default
	// closed). The hamburger in the top bar opens it; opening the panel
	// does not change the chat layout. Clicking outside / the X close / a
	// history-row click closes it.
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyCleared, setHistoryCleared] = useState(false);

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
		// Phase 2E: explicit-new is scoped to the currently selected agent.
		// When the user switches agents the flag has no meaning for the new
		// agent's conversation list, so we clear it here. The effect below
		// will then either resume the new agent's recent conversation or
		// stay empty — never silently resurrect the previous agent's row.
		explicitNewRef.current = false;
		let cancelled = false;
		void (async () => {
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
		})().catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [agentApiRef, runtime, agents, selectedAgentId, selectedModel]);

	// Strict lazy-create bootstrap: the LazyDebugSessionController invokes this
	// before EVERY send. It is a no-op once a conversation is attached; when a
	// bound Agent still has no DebugConversation, the first real message creates
	// + attaches it (and only then) before the send proceeds.
	//
	// Phase 2E explicit-new: when the user clicks "New Conversation", the
	// previous DB row remains `active` for the agent. Without this branch the
	// first send after "New" would silently re-attach the just-cleared
	// conversation. We instead skip `resumeDebugConversation` and go directly
	// to `createDebugConversation`, then clear the explicit-new flag so
	// subsequent sends on the new conversation resume normally.
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
				await runtime?.connection.connect();
				let convId: string;
				if (explicitNewRef.current) {
					// explicit-new: do NOT resume the previous conversation, even
					// though the DB still has it as `active`. The user's intent
					// is to start fresh.
					const created = await agentApiRef.createDebugConversation(selectedAgent.id);
					convId = created.conversation.conversationId;
				} else {
					const resumed = await agentApiRef.resumeDebugConversation(selectedAgent.id);
					convId =
						resumed.conversation !== null
							? resumed.conversation.conversationId
							: (await agentApiRef.createDebugConversation(selectedAgent.id)).conversation.conversationId;
				}
				await runtime?.sessions.openDebugSession(convId);
				debugSessionIdRef.current = convId;
				setDebugSessionId(convId);
				// The bootstrap has now attached a conversation; the explicit-new
				// flag's job is done. If the user wants ANOTHER new conversation
				// they have to click the button again.
				explicitNewRef.current = false;
			})();
			debugCreateGuardRef.current = guard;
			try {
				await guard;
			} finally {
				debugCreateGuardRef.current = null;
			}
		};
	}, [agentApiRef, runtime, agents, selectedAgentId]);

	// Phase 2E: History refresh. Two triggers:
	//   1. `selectedAgentId` change — load the new agent's conversation list.
	//   2. A turn just completed in the bound conversation — the new
	//      `lastActiveAt` should bubble that conversation to the top of the
	//      list. The cleanest signal is the `activeSession.phase` transition
	//      from "turn" to "idle"; we use a ref to remember the previous phase
	//      so the effect does not re-fire on every event inside a turn.
	const prevPhaseRef = useRef<string | null>(null);
	useEffect(() => {
		if (selectedAgentId === null) {
			setHistory({ kind: "idle" });
			return;
		}
		let cancelled = false;
		setHistory((current) =>
			current.kind === "loaded" ? { kind: "loaded", items: current.items } : { kind: "loading" },
		);
		void agentApiRef.listDebugConversations(selectedAgentId, 50).then(
			(result: { readonly items: readonly DebugConversationListItem[] }) => {
				if (!cancelled) setHistory({ kind: "loaded", items: result.items });
			},
			(error: unknown) => {
				if (cancelled) return;
				setHistory({
					kind: "error",
					message: error instanceof AgentApiError ? error.message : "加载历史会话失败",
				});
			},
		);
		return () => {
			cancelled = true;
		};
	}, [agentApiRef, selectedAgentId, debugSessionId]);

	// Phase 2E: refetch the history list when the bound conversation finishes
	// a turn. We only fire on the `turn -> idle` phase transition so the
	// streaming deltas inside a turn never trigger a refetch. The previous
	// phase is captured in a ref because the effect should not depend on the
	// entire active session (which would re-run on every streaming event).
	useEffect(() => {
		if (runtime === null) return;
		const unsubscribe = runtime.sessions.subscribe(() => {
			const next = runtime.sessions.getSnapshot().activeSession;
			const phase = next?.phase ?? null;
			const previous = prevPhaseRef.current;
			prevPhaseRef.current = phase;
			if (phase === "idle" && previous === "turn" && selectedAgentId !== null) {
				void agentApiRef
					.listDebugConversations(selectedAgentId, 50)
					.then((result) => {
						setHistory({ kind: "loaded", items: result.items });
					})
					.catch((error: unknown) => {
						setHistory({
							kind: "error",
							message: error instanceof AgentApiError ? error.message : "加载历史会话失败",
						});
					});
			}
		});
		return () => {
			unsubscribe();
		};
	}, [agentApiRef, runtime, selectedAgentId]);

	// Phase 2E: "New Conversation" handler. Does NOT call any backend API:
	//   - No `createDebugConversation` (the first send does that via the
	//     explicit-new bootstrap branch).
	//   - No delete of the prior conversation (DB row stays `active` and
	//     History still shows it).
	// It releases the current WS handle, clears the page-level binding, and
	// sets `explicitNewRef` so the next send goes through `createNew` instead
	// of `resume`.
	//
	// `activePhase` is mirrored into React state via a subscription effect so
	// we do not invoke `useSyncExternalStore` conditionally (rules of hooks).
	const [activePhase, setActivePhase] = useState<string>("idle");
	useEffect(() => {
		if (runtime === null) return undefined;
		setActivePhase(runtime.sessions.getSnapshot().activeSession?.phase ?? "idle");
		return runtime.sessions.subscribe(() => {
			setActivePhase(runtime.sessions.getSnapshot().activeSession?.phase ?? "idle");
		});
	}, [runtime]);
	const handleNewConversation = useCallback(() => {
		if (runtime === null) return;
		if (activePhase !== "idle") return; // never drop a turn in flight
		void runtime.sessions
			.resetActive()
			.then(() => {
				debugSessionIdRef.current = null;
				debugSessionKeyRef.current = null;
				explicitNewRef.current = true;
				setDebugSessionId(null);
			})
			.catch(() => {
				// resetActive only fails on the inner handle dispose; the local
				// state still needs to reflect the user's intent, so we apply
				// it here even if the WS tear-down rejected.
				debugSessionIdRef.current = null;
				debugSessionKeyRef.current = null;
				explicitNewRef.current = true;
				setDebugSessionId(null);
			});
	}, [runtime, activePhase]);

	// Phase 2E: History item click. Resets the explicit-new flag (the user
	// just made a deliberate choice between existing conversations) and binds
	// the picked conversation. The SessionController handles the previous
	// handle disposal via #activate.
	const handleSelectHistory = useCallback(
		async (conversationId: string) => {
			if (runtime === null) return;
			if (activePhase !== "idle") return;
			if (debugSessionIdRef.current === conversationId) return;
			explicitNewRef.current = false;
			await runtime.sessions.openDebugSession(conversationId);
			debugSessionIdRef.current = conversationId;
			setDebugSessionId(conversationId);
		},
		[runtime, activePhase],
	);

	useEffect(
		() => () => {
			// DebugConversations persist server-side: unlike the legacy ephemeral
			// debug-session path there is nothing to destroy on unmount.
			debugSessionIdRef.current = null;
			debugSessionKeyRef.current = null;
		},
		[],
	);

	// v2 redesign: the History list is now client-side state only.
	// The control API has no `clearList` operation, so the button is wired
	// to a confirm dialog + optimistic local clear. Refusing here keeps the
	// UX honest — there is no server-side wipe hidden behind this button.
	const handleClearHistory = useCallback(() => {
		if (typeof window !== "undefined") {
			const ok = window.confirm("确定要清空当前 Agent 的对话列表吗？此操作仅影响本地视图。");
			if (!ok) return;
		}
		setHistoryCleared(true);
		setHistory({ kind: "loaded", items: [] });
		setHistoryOpen(false);
	}, []);

	// Click-outside-to-close: the floating panel is not a docked sidebar, so
	// there is no `scrim` overlay. Listen for clicks on the document and close
	// the panel when the click landed outside both the panel and the
	// hamburger trigger. Bound only while the panel is open.
	useEffect(() => {
		if (!historyOpen) return undefined;
		const handleDocumentClick = (event: MouseEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest(".debug-history-panel")) return;
			if (target.closest(".admin-debug-topbar__menu")) return;
			setHistoryOpen(false);
		};
		document.addEventListener("mousedown", handleDocumentClick);
		return () => document.removeEventListener("mousedown", handleDocumentClick);
	}, [historyOpen]);

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
	// When the cleared flag is set we suppress the History list for the rest
	// of the page session, but a fresh agent switch resets it so the user
	// can still inspect another agent's list.
	const visibleHistory =
		historyCleared && history.kind === "loaded" && history.items.length === 0
			? { kind: "loaded" as const, items: [] }
			: history;

	return (
		<div className="admin-debug-shell">
			<DebugHistoryPanel
				open={historyOpen}
				state={visibleHistory}
				activeConversationId={debugSessionId}
				busy={activePhase !== "idle"}
				onClose={() => setHistoryOpen(false)}
				onNew={handleNewConversation}
				onSelect={async (id) => {
					await handleSelectHistory(id);
					setHistoryOpen(false);
				}}
				onClearAll={handleClearHistory}
			/>
			<ConversationWorkspace
				connection={runtime.connection}
				sessions={runtime.sessions}
				variant="admin"
				showSidebar={false}
				enableVoice={false}
				enableRealtimeVoice={realtimeVoiceAvailable}
				voiceEngine={realtimeVoiceAvailable ? voiceEngine : undefined}
				skills={composerSkills}
				emptySendable={selected !== undefined && debugSessionId === null}
				postComposer={
					<p className="admin-debug-composer-hint">
						<span>
							<kbd>Enter</kbd> 发送
						</span>
						<span className="admin-debug-composer-hint__sep" aria-hidden="true">
							·
						</span>
						<span>
							<kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
						</span>
					</p>
				}
				contextHeader={
					<div className="admin-debug-header">
						<div className="admin-debug-topbar">
							<div className="admin-debug-topbar__left">
								<button
									type="button"
									className="workspace-debug-back"
									onClick={() => navigate(selected ? `/agents/${selected.id}` : "/agents")}
								>
									<svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
										<path
											d="M16.25 10H3.75m0 0 5-5m-5 5 5 5"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.6"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
									<span>返回 Agent</span>
								</button>
							</div>
							<div className="admin-debug-topbar__right">
								<div className="admin-debug-topbar__agent">
									<label className="admin-debug-topbar__select">
										<select
											aria-label="选择调试 Agent"
											value={selectedAgentId ?? ""}
											onChange={(event) => setSelectedAgentId(event.target.value as AgentPublicId)}
											disabled={!hasAgents}
										>
											{agents.kind === "loaded" ? (
												agents.items.map((agent) => (
													<option value={agent.id} key={agent.id}>
														{agent.name}
														{agent.hasDraft ? "（含草稿）" : ""}
													</option>
												))
											) : (
												<option value="">暂无 Agent</option>
											)}
										</select>
										<svg
											className="admin-debug-topbar__select-caret"
											viewBox="0 0 16 16"
											focusable="false"
											aria-hidden="true"
										>
											<path
												d="m4.5 6 3.5 3.5L11.5 6"
												fill="none"
												stroke="currentColor"
												strokeWidth="1.5"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									</label>
								</div>
								<DebugModelChip model={selectedModelMetadata} />
								<DebugThinkingChip agent={selectedAgentDetail} model={selectedModelMetadata} />
								<DebugThinkingEffortChip agent={selectedAgentDetail} model={selectedModelMetadata} />
								<button
									type="button"
									className={`admin-debug-topbar__menu ${historyOpen ? "is-active" : ""}`}
									onClick={() => setHistoryOpen((value) => !value)}
									aria-label={historyOpen ? "关闭对话历史" : "打开对话历史"}
									aria-expanded={historyOpen}
									title="对话历史"
								>
									<svg viewBox="0 0 16 16" width="16" height="16" focusable="false" aria-hidden="true">
										<path
											d="M3 4h10M3 8h10M3 12h10"
											stroke="currentColor"
											strokeWidth="1.5"
											strokeLinecap="round"
										/>
									</svg>
								</button>
							</div>
						</div>
					</div>
				}
			/>
		</div>
	);
}
