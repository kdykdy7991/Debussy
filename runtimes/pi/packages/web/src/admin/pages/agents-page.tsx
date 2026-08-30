/** Agent 列表与详情入口。列表只展示 Control API 返回的真实数据。 */
import type {
	AgentDefinitionAssociatedApp,
	AgentDefinitionDetail,
	AgentDefinitionRevision,
	AgentDefinitionSummary,
	AgentPublicId,
	LlmAvailableModel,
	McpServerSummary,
	SkillSummary,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type AgentDetailData,
	AgentDetailPreview,
	type AgentEditableDraft,
	type AgentListItem,
	AgentListPreview,
	type AgentPublishData,
	type AgentResource,
	type PublishInstance,
	type VersionHistoryItem,
} from "../../ui-preview/agent-redesign.tsx";
import { AgentApi } from "../api/agent-api.ts";
import { newIdempotencyKey } from "../api/idempotency.ts";
import { LlmApi } from "../api/llm-api.ts";
import { McpApi } from "../api/mcp-api.ts";
import { SkillApi } from "../api/skill-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import type { AdminRoute } from "../router.ts";
import { navigate } from "../router.ts";

type ListState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly AgentDefinitionSummary[] }
	| { readonly kind: "error"; readonly message: string };

type DetailState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly detail: AgentDefinitionDetail }
	| { readonly kind: "error"; readonly message: string };

type ModelsState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly LlmAvailableModel[] }
	| { readonly kind: "error"; readonly message: string };

type RevisionsState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly AgentDefinitionRevision[] }
	| { readonly kind: "error"; readonly message: string };

type AppsState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly AgentDefinitionAssociatedApp[] }
	| { readonly kind: "error"; readonly message: string };

/** Skill / MCP 目录：只用来把 detail 里的 id 引用翻译成可读名称。 */
type CatalogState<T> =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly T[] }
	| { readonly kind: "error"; readonly message: string };

const CARD_TONES = ["blue", "green", "violet", "amber", "orange", "teal", "red", "slate"] as const;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function AdminAgentsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "agent-detail") {
		const agentId = route.params.agentId;
		if (agentId === undefined) return <p role="alert">缺少 Agent ID</p>;
		return <RealAgentDetail agentId={agentId as AgentPublicId} />;
	}
	return <RealAgentList />;
}

function RealAgentDetail({ agentId }: { readonly agentId: AgentPublicId }): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useMemo(() => new AgentApi({ auth: controller }), [controller]);
	const llmApi = useMemo(() => new LlmApi({ auth: controller }), [controller]);
	const skillApi = useMemo(() => new SkillApi({ auth: controller }), [controller]);
	const mcpApi = useMemo(() => new McpApi({ auth: controller }), [controller]);
	const [state, setState] = useState<DetailState>({ kind: "loading" });
	const [models, setModels] = useState<ModelsState>({ kind: "loading" });
	const [revisions, setRevisions] = useState<RevisionsState>({ kind: "loading" });
	const [apps, setApps] = useState<AppsState>({ kind: "loading" });
	const [skillCatalog, setSkillCatalog] = useState<CatalogState<SkillSummary>>({ kind: "loading" });
	const [mcpCatalog, setMcpCatalog] = useState<CatalogState<McpServerSummary>>({ kind: "loading" });

	const load = useCallback(() => {
		setState({ kind: "loading" });
		void api.getAgentDetail(agentId).then(
			(detail) => setState({ kind: "loaded", detail }),
			(error: unknown) => setState({ kind: "error", message: errorMessage(error) }),
		);
	}, [agentId, api]);

	const loadRevisions = useCallback(() => {
		setRevisions({ kind: "loading" });
		void api.listRevisions(agentId, { limit: 20 }).then(
			(result) => setRevisions({ kind: "loaded", items: result.items }),
			(error: unknown) => setRevisions({ kind: "error", message: errorMessage(error) }),
		);
	}, [agentId, api]);

	const loadApps = useCallback(() => {
		setApps({ kind: "loading" });
		void api.listAgentApps(agentId).then(
			(result) => setApps({ kind: "loaded", items: result.items }),
			(error: unknown) => setApps({ kind: "error", message: errorMessage(error) }),
		);
	}, [agentId, api]);

	useEffect(() => {
		load();
		loadRevisions();
		loadApps();
	}, [load, loadRevisions, loadApps]);

	useEffect(() => {
		setModels({ kind: "loading" });
		void llmApi.listModels().then(
			(result) => setModels({ kind: "loaded", items: result.items }),
			(error: unknown) => setModels({ kind: "error", message: errorMessage(error) }),
		);
	}, [llmApi]);

	// Skill / MCP 目录：只用于把 detail 里的 id 引用翻译成可读名称
	useEffect(() => {
		setSkillCatalog({ kind: "loading" });
		void skillApi.list(100).then(
			(result) => setSkillCatalog({ kind: "loaded", items: result.items }),
			(error: unknown) => setSkillCatalog({ kind: "error", message: errorMessage(error) }),
		);
	}, [skillApi]);

	useEffect(() => {
		setMcpCatalog({ kind: "loading" });
		void mcpApi.list(100).then(
			(result) => setMcpCatalog({ kind: "loaded", items: result.items }),
			(error: unknown) => setMcpCatalog({ kind: "error", message: errorMessage(error) }),
		);
	}, [mcpApi]);
	if (state.kind === "loading") {
		return (
			<div className="ard-empty" aria-busy="true">
				<strong>正在加载 Agent 配置…</strong>
			</div>
		);
	}
	if (state.kind === "error") {
		return (
			<div className="ard-empty" role="alert">
				<strong>加载 Agent 详情失败</strong>
				<span>{state.message}</span>
				<button type="button" onClick={load}>
					重试
				</button>
			</div>
		);
	}
	const data: AgentDetailData = {
		name: state.detail.name,
		description: state.detail.description ?? "",
		systemPrompt: state.detail.systemPrompt,
		modelId: state.detail.modelId,
		reasoningEnabled: state.detail.parameters.reasoning?.enabled ?? true,
		reasoningEffort: state.detail.parameters.reasoning?.effort,
		attachments: state.detail.capabilities.attachments,
		avatar: state.detail.capabilities.avatar,
		liveSpeech: state.detail.capabilities.liveSpeech,
		newConversations: state.detail.capabilities.newConversations !== false,
	};
	const saveDraft = async (draft: AgentEditableDraft): Promise<void> => {
		const selectedModel =
			models.kind === "loaded" ? models.items.find((item) => item.id === draft.modelId) : undefined;
		const reasoningCapability = selectedModel?.parameterCapabilities.reasoning;
		const { reasoning: _previousReasoning, ...otherParameters } = state.detail.parameters;
		const effortAllowed =
			draft.reasoningEffort !== undefined &&
			(reasoningCapability === undefined || reasoningCapability.efforts.includes(draft.reasoningEffort));
		const reasoning =
			reasoningCapability?.supported === false
				? undefined
				: {
						...(reasoningCapability?.toggle ? { enabled: draft.reasoningEnabled } : {}),
						...(effortAllowed ? { effort: draft.reasoningEffort } : {}),
					};
		await api.saveRevision(
			agentId,
			{
				name: draft.name,
				description: draft.description,
				modelId: draft.modelId,
				systemPrompt: draft.systemPrompt,
				parameters: {
					...otherParameters,
					...(reasoning === undefined ? {} : { reasoning }),
				},
				toolIds: state.detail.toolIds,
				knowledgeBaseIds: state.detail.knowledgeBaseIds,
				capabilities: {
					...state.detail.capabilities,
					attachments: draft.attachments,
					avatar: draft.avatar,
					liveSpeech: draft.liveSpeech,
					newConversations: draft.newConversations,
				},
				skills: draft.skills ?? state.detail.skills,
				mcpServers: draft.mcpServers ?? state.detail.mcpServers,
				changeSummary: "Updated from Agent design",
			},
			newIdempotencyKey({ operation: "agent.save" }),
		);
		const refreshed = await api.getAgentDetail(agentId);
		setState({ kind: "loaded", detail: refreshed });
		loadRevisions();
		loadApps();
	};

	// ---- 侧栏：Revision 历史 / 关联应用 / 发布状态 ----
	const currentRevision = state.detail.currentRevision;
	const versionHistory: readonly VersionHistoryItem[] =
		revisions.kind === "loaded"
			? revisions.items.map((rev) => ({
					version: `v${rev.revision}`,
					createdAt: new Date(rev.createdAt).toLocaleString("zh-CN", { hour12: false }),
					author: rev.createdBy,
					isCurrent: rev.revision === currentRevision,
				}))
			: [];
	const instances: readonly PublishInstance[] =
		apps.kind === "loaded"
			? apps.items.map((app) => ({
					id: app.appId,
					name: app.name,
					status: app.status === "active" ? "online" : "paused",
				}))
			: [];
	const updatedAtLabel = new Date(state.detail.updatedAt).toLocaleString("zh-CN", { hour12: false });
	const publishData: AgentPublishData = {
		status: instances.some((item) => item.status === "online") ? "online" : "draft",
		currentVersion: `v${currentRevision}`,
		lastPublishedAt: updatedAtLabel,
		instances,
		versionHistory,
	};

	// ---- 主区：Skill / MCP 绑定，id 引用经目录翻译成可读名称 ----
	const skillItems: readonly AgentResource[] = (state.detail.skills ?? []).map((ref) => {
		const catalog =
			skillCatalog.kind === "loaded" ? skillCatalog.items.find((item) => item.id === ref.skillId) : undefined;
		return {
			id: ref.skillId,
			name: catalog?.name ?? ref.skillId,
			version: `v${ref.revision}`,
			enabled: catalog?.enabled ?? false,
			outdated: catalog !== undefined && ref.revision < catalog.currentRevision,
		};
	});
	const mcpItems: readonly AgentResource[] = (state.detail.mcpServers ?? []).map((ref) => {
		const catalog =
			mcpCatalog.kind === "loaded" ? mcpCatalog.items.find((item) => item.id === ref.mcpServerId) : undefined;
		return {
			id: ref.mcpServerId,
			name: catalog?.name ?? ref.mcpServerId,
			version: `v${ref.revision}`,
			enabled: catalog?.status === "enabled",
			toolCount: ref.toolNames.length,
			outdated: catalog !== undefined && ref.revision < catalog.currentRevision,
		};
	});

	return (
		<AgentDetailPreview
			key={`${agentId}:${currentRevision}`}
			embedded
			data={data}
			saveEnabled
			identityEditable
			modelEditable={models.kind === "loaded"}
			models={models.kind === "loaded" ? models.items : undefined}
			modelsLoading={models.kind === "loading"}
			modelsError={models.kind === "error" ? models.message : undefined}
			onSave={saveDraft}
			onBack={() => navigate("/agents")}
			onTest={() => navigate(`/chat?agentId=${agentId}`)}
			createdAt={updatedAtLabel}
			createdBy={state.detail.updatedBy}
			agentId={state.detail.id}
			toolsCount={state.detail.toolIds.length}
			publishData={publishData}
			skills={skillItems}
			mcpServers={mcpItems}
			resourcesLoading={skillCatalog.kind === "loading" || mcpCatalog.kind === "loading"}
			skillCatalog={
				skillCatalog.kind === "loaded"
					? skillCatalog.items.map((item) => ({
							id: item.id,
							name: item.name,
							currentRevision: item.currentRevision,
							enabled: item.enabled,
						}))
					: undefined
			}
			mcpCatalog={
				mcpCatalog.kind === "loaded"
					? mcpCatalog.items.map((item) => ({
							id: item.id,
							name: item.name,
							currentRevision: item.currentRevision,
							enabled: item.status === "enabled",
							toolCount: item.toolCount,
						}))
					: undefined
			}
			hasDraft={state.detail.hasDraft}
		/>
	);
}

function RealAgentList(): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useMemo(() => new AgentApi({ auth: controller }), [controller]);
	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [creating, setCreating] = useState(false);

	const load = useCallback(() => {
		let cancelled = false;
		setState({ kind: "loading" });
		void api.listAgents({ limit: 100 }).then(
			(result) => {
				if (!cancelled) setState({ kind: "loaded", items: result.items });
			},
			(error: unknown) => {
				if (cancelled) return;
				setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [api]);

	useEffect(() => load(), [load]);

	const items: readonly AgentListItem[] =
		state.kind === "loaded"
			? state.items.map((agent, index) => ({
					id: agent.id,
					name: agent.name,
					description: `Agent ID：${agent.id}`,
					status: "saved" as const,
					updatedAt: new Date(agent.createdAt).toLocaleString(),
					version: agent.revision,
					tone: CARD_TONES[index % CARD_TONES.length],
					glyph: agent.name.trim().slice(0, 1).toUpperCase() || "A",
					timestampLabel: "创建时间",
				}))
			: [];

	return (
		<AgentListPreview
			embedded
			items={items}
			loadState={state.kind === "loaded" ? "ready" : state.kind}
			errorMessage={state.kind === "error" ? state.message : undefined}
			onRetry={load}
			createPending={creating}
			onCreate={() => {
				if (creating) return;
				const name = window.prompt("请输入 Agent 名称：")?.trim();
				if (!name) return;
				setCreating(true);
				void api
					.createAgent(
						{
							name,
							description: "",
							modelId: null,
							systemPrompt: "",
							parameters: {},
							toolIds: [],
							knowledgeBaseIds: [],
							capabilities: {
								liveSpeech: false,
								avatar: false,
								attachments: false,
								citations: false,
								realtime: false,
								webSearch: false,
							},
							skills: [],
							mcpServers: [],
						},
						newIdempotencyKey({ operation: "agent.create" }),
					)
					.then(
						(created) => navigate(`/agents/${created.id}`),
						(error: unknown) => {
							setCreating(false);
							window.alert(error instanceof Error ? error.message : String(error));
						},
					);
			}}
			onOpen={(agent) => navigate(`/agents/${agent.id as AgentPublicId}`)}
			onDelete={(agent) => {
				const confirmation = window.prompt(
					`删除 Agent 前会检查关联应用。请输入 Agent 名称“${agent.name}”确认删除：`,
				);
				if (confirmation === null) return;
				if (confirmation !== agent.name) {
					window.alert("输入的 Agent 名称不匹配，未执行删除");
					return;
				}
				void api.deleteAgent(agent.id as AgentPublicId, confirmation).then(load, (error: unknown) => {
					window.alert(error instanceof Error ? error.message : String(error));
				});
			}}
		/>
	);
}
