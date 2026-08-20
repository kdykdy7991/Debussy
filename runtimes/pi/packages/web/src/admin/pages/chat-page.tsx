import { PiClient } from "@earendil-works/pi-client";
import type { AgentDefinitionSummary, AgentPublicId, LlmAvailableModel, ModelRef } from "@earendil-works/pi-protocol";
import { useEffect, useRef, useState } from "react";
import { ConversationWorkspace } from "../../app.tsx";
import { PiConnectionController } from "../../lib/connection-controller.ts";
import { SessionController } from "../../lib/session-controller.ts";
import { createUploader } from "../../lib/uploader.ts";
import { createWebSocketTransportFactory } from "../../lib/websocket-transport.ts";
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

export function AdminChatPage(): React.ReactElement {
	const { controller, snapshot: auth } = useAdminAuth();
	const agentApiRef = useRef(new AgentApi({ auth: controller })).current;
	const llmApiRef = useRef(new LlmApi({ auth: controller })).current;
	const debugSessionsRef = useRef(createDebugSessionStore()).current;
	const [agents, setAgents] = useState<AgentListState>({ kind: "loading" });
	const [models, setModels] = useState<ModelsState>({ kind: "loading" });
	const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
	const [selectedAgentId, setSelectedAgentId] = useState<AgentPublicId | null>(null);
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
				setSelectedAgentId((current) => current ?? items[0]?.id ?? null);
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
	}, [agentApiRef, auth.state]);

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
			const remembered = debugSessionsRef.get(selectedAgentId);
			if (remembered) {
				try {
					await runtime.sessions.selectSession(remembered);
					return;
				} catch {
					debugSessionsRef.clear(selectedAgentId);
				}
			}
			if (!cancelled) await runtime.sessions.createSession(selectedModel ?? undefined);
		})().catch(() => {});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [debugSessionsRef, runtime, selectedAgentId, selectedModel]);

	if (auth.state !== "connected") {
		return <section className="admin-chat-loading">请先解锁工作台。</section>;
	}
	if (runtime === null) {
		return <output className="admin-chat-loading">正在准备管理员调试工作区…</output>;
	}

	const hasAgents = agents.kind === "loaded" && agents.items.length > 0;
	const selected = hasAgents
		? (agents.items.find((agent) => agent.id === selectedAgentId) ?? agents.items[0])
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
					<span className="workspace-revision">Revision #{selected?.currentRevision ?? "—"}</span>
				</>
			}
		/>
	);
}
