import { PiClient } from "@earendil-works/pi-client";
import type { AgentDefinitionSummary, AgentPublicId } from "@earendil-works/pi-protocol";
import { useEffect, useRef, useState } from "react";
import { ConversationWorkspace } from "../../app.tsx";
import { PiConnectionController } from "../../lib/connection-controller.ts";
import { SessionController } from "../../lib/session-controller.ts";
import { createUploader } from "../../lib/uploader.ts";
import { createWebSocketTransportFactory } from "../../lib/websocket-transport.ts";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";
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

interface ChatRuntime {
	readonly connection: PiConnectionController<PiClient>;
	readonly sessions: SessionController;
}

export function AdminChatPage(): React.ReactElement {
	const { controller, snapshot: auth } = useAdminAuth();
	const agentApiRef = useRef(new AgentApi({ auth: controller })).current;
	const debugSessionsRef = useRef(createDebugSessionStore()).current;
	const [agents, setAgents] = useState<AgentListState>({ kind: "loading" });
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
		if (runtime === null || selectedAgentId === null) return;
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
			if (!cancelled) await runtime.sessions.createSession();
		})().catch(() => {});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [debugSessionsRef, runtime, selectedAgentId]);

	if (auth.state !== "connected") {
		return <section className="admin-chat-loading">请先解锁工作台。</section>;
	}
	if (agents.kind === "loading" || runtime === null) {
		return <output className="admin-chat-loading">正在准备管理员调试工作区…</output>;
	}
	if (agents.kind === "error") {
		return <output className="admin-chat-loading admin-shell__chat-error">{agents.message}</output>;
	}
	if (agents.items.length === 0 || selectedAgentId === null) {
		return (
			<section className="admin-chat-loading">
				<h1>对话（管理员调试）</h1>
				<p>当前租户还没有 Agent。请先到 Agent 页面导入当前 Agent。</p>
			</section>
		);
	}

	const selected = agents.items.find((agent) => agent.id === selectedAgentId) ?? agents.items[0];
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
					<label>
						<span>调试 Agent</span>
						<select
							aria-label="选择调试 Agent"
							value={selectedAgentId}
							onChange={(event) => setSelectedAgentId(event.target.value as AgentPublicId)}
						>
							{agents.items.map((agent) => (
								<option value={agent.id} key={agent.id}>
									{agent.name}
									{agent.hasDraft ? "（含草稿）" : ""}
								</option>
							))}
						</select>
					</label>
					<span className="workspace-revision">Revision #{selected?.currentRevision ?? "—"}</span>
				</>
			}
		/>
	);
}
