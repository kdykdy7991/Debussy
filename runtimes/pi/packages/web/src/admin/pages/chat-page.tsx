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
import { SessionController } from "../../lib/session-controller.ts";
import { createUploader } from "../../lib/uploader.ts";
import { createWebSocketTransportFactory } from "../../lib/websocket-transport.ts";
import { productReasoningEfforts } from "../agents/reasoning-efforts.ts";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";
import { LlmApi } from "../api/llm-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { createDebugSessionStore } from "../conversation/debug-session-store.ts";

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
	const debugSessionsRef = useRef(createDebugSessionStore()).current;
	const requestedAgentIdRef = useRef(requestedAgentIdFromHash()).current;
	const [agents, setAgents] = useState<AgentListState>({ kind: "loading" });
	const [models, setModels] = useState<ModelsState>({ kind: "loading" });
	const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
	const [selectedAgentId, setSelectedAgentId] = useState<AgentPublicId | null>(null);
	const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentDefinitionDetail | null>(null);
	const [runtime, setRuntime] = useState<ChatRuntime | null>(null);

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
		const sessions = new SessionController(
			client,
			createUploader({
				baseUrl: new URL(websocketUrl).origin.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
				...(webToken ? { token: webToken } : {}),
			}),
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
		if (selectedAgentId === null) {
			// 没有已导入 Agent：直接以当前所选模型开新会话。
			let cancelled = false;
			void (async () => {
				await runtime.connection.connect();
				if (!cancelled) await runtime.sessions.createSession(selectedModel ?? undefined);
			})().catch(() => {});
			return () => {
				cancelled = true;
			};
		}
		let cancelled = false;
		const unsubscribe = runtime.sessions.subscribe(() => {
			const sessionId = runtime.sessions.getSnapshot().activeSessionId;
			if (sessionId) debugSessionsRef.set(selectedAgentId, sessionId);
		});
		void (async () => {
			await runtime.connection.connect();
			const applyAgentThinking = async () => {
				const reasoning = selectedAgentDetail?.parameters.reasoning;
				const thinkingLevel = reasoning?.enabled === false ? "off" : reasoning?.effort;
				if (selectedAgentDetail?.id === selectedAgentId && thinkingLevel !== undefined) {
					await runtime.sessions.setThinking(thinkingLevel as ThinkingLevel);
				}
			};
			const remembered = debugSessionsRef.get(selectedAgentId);
			if (remembered) {
				try {
					await runtime.sessions.selectSession(remembered);
					await applyAgentThinking();
					return;
				} catch {
					debugSessionsRef.clear(selectedAgentId);
				}
			}
			if (!cancelled) {
				await runtime.sessions.createSession(selectedModel ?? undefined);
				await applyAgentThinking();
			}
		})().catch(() => {});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [debugSessionsRef, runtime, selectedAgentDetail, selectedAgentId, selectedModel]);

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
	return (
		<ConversationWorkspace
			connection={runtime.connection}
			sessions={runtime.sessions}
			variant="admin"
			enableVoice={false}
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
					{selectedModelMetadata ? (
						<ThinkingControl
							model={selectedModelMetadata}
							sessions={runtime.sessions}
							defaultEffort={selectedAgentDetail?.parameters.reasoning?.effort as ThinkingLevel | undefined}
						/>
					) : null}
					<span className="workspace-revision">Revision #{selected?.currentRevision ?? "—"}</span>
				</>
			}
		/>
	);
}
