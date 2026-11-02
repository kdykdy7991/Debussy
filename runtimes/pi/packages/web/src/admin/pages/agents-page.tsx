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
import { useDialogs } from "../components/use-dialogs.tsx";

/**
 * MCP catalog 条目。`toolNames` 记录该 server 当前 revision 冻结的工具名,
 * 供 agent 编辑器在新增绑定时作为默认 allowlist(服务端要求绑定 allowlist 必须非空)。
 */
interface McpCatalogServer extends McpServerSummary {
	readonly toolNames?: readonly string[];
	readonly connectionStatus?: "connected" | "failed" | "untested";
}

import {
	type AgentDetailData,
	AgentDetailPreview,
	type AgentEditableDraft,
	type AgentListItem,
	AgentListPreview,
	type AgentPublishData,
	type AgentResource,
	type VersionHistoryItem,
} from "../../ui-preview/agent-redesign.tsx";
import { AgentApi } from "../api/agent-api.ts";
import { newIdempotencyKey } from "../api/idempotency.ts";
import { LlmApi } from "../api/llm-api.ts";
import { McpApi } from "../api/mcp-api.ts";
import { SkillApi } from "../api/skill-api.ts";
import { PublishDrawer } from "../apps/publish-drawer.tsx";
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

type TrustedSystem = {
	readonly id: string;
	readonly name: string;
	readonly client_id: string;
	readonly enabled: boolean;
	readonly published_app_id: string;
};

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
	const [trustedSystems, setTrustedSystems] = useState<readonly TrustedSystem[]>([]);
	const [trustedError, setTrustedError] = useState<string | null>(null);
	const [trustedBusy, setTrustedBusy] = useState(false);
	const [pendingRotation, setPendingRotation] = useState<string | null>(null);
	const [newSecret, setNewSecret] = useState<{ readonly clientId: string; readonly value: string } | null>(null);
	const [copiedSecret, setCopiedSecret] = useState(false);
	const [skillCatalog, setSkillCatalog] = useState<CatalogState<SkillSummary>>({ kind: "loading" });
	const [mcpCatalog, setMcpCatalog] = useState<CatalogState<McpCatalogServer>>({ kind: "loading" });
	const [publishDrawerMode, setPublishDrawerMode] = useState<"closed" | "open">("closed");
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const handleDirtyChange = useCallback((dirty: boolean) => setHasUnsavedChanges(dirty), []);

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

	const loadTrustedSystems = useCallback(() => {
		void api.listTrustedSystems().then(
			(items) => {
				setTrustedSystems(items);
				setTrustedError(null);
			},
			(error: unknown) => setTrustedError(errorMessage(error)),
		);
	}, [api]);

	useEffect(() => {
		load();
		loadRevisions();
		loadApps();
		loadTrustedSystems();
	}, [load, loadRevisions, loadApps, loadTrustedSystems]);

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
		let cancelled = false;
		const refresh = () => {
			void mcpApi
				.list(100)
				.then(async (result) => {
					// 服务端会给绑定非空 allowlist,且发布时校验 allowlist 与冻结快照一致;
					// 因此这里补拉每个 server 当前 revision 的工具名,供新增绑定时使用。
					const items: McpCatalogServer[] = await Promise.all(
						result.items.map(async (item) => {
							try {
								const detail = await mcpApi.get(item.id);
								const current = detail.revisions.find((rev) => rev.revision === detail.currentRevision);
								return {
									...item,
									toolNames: current?.tools.map((tool) => tool.name) ?? [],
									connectionStatus:
										detail.lastTest === null ? "untested" : detail.lastTest.ok ? "connected" : "failed",
								} satisfies McpCatalogServer;
							} catch {
								return { ...item, connectionStatus: "untested" } satisfies McpCatalogServer;
							}
						}),
					);
					if (!cancelled) setMcpCatalog({ kind: "loaded", items });
				})
				.catch((error: unknown) => {
					if (!cancelled) setMcpCatalog({ kind: "error", message: errorMessage(error) });
				});
		};
		refresh();
		const timer = setInterval(refresh, 60_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
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
		reasoningEnabled: state.detail.parameters.reasoning?.enabled ?? false,
		reasoningEffort: state.detail.parameters.reasoning?.effort,
		attachments: state.detail.capabilities.attachments,
		avatar: state.detail.capabilities.avatar,
		realtimeVoice: state.detail.capabilities.realtimeVoice === true,
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
					realtimeVoice: draft.realtimeVoice,
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

	// ---- 侧栏：Revision 历史 / 发布状态 ----
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
	const updatedAtLabel = new Date(state.detail.updatedAt).toLocaleString("zh-CN", { hour12: false });
	const liveApp =
		apps.kind === "loaded"
			? [...apps.items]
					.filter((app) => app.status === "active")
					.sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""))[0]
			: undefined;
	const publishData: AgentPublishData = {
		status: liveApp === undefined ? "draft" : "online",
		draftRevision: `Revision ${currentRevision}`,
		draftSavedAt: updatedAtLabel,
		currentVersion: liveApp?.sourceAgentRevision !== undefined ? `Revision ${liveApp.sourceAgentRevision}` : "",
		lastPublishedAt:
			liveApp?.publishedAt === undefined
				? ""
				: new Date(liveApp.publishedAt).toLocaleString("zh-CN", { hour12: false }),
		externalLink: liveApp?.embedUrl,
		versionHistory,
	};
	const trustedAppIds = new Set(
		apps.kind === "loaded"
			? apps.items.filter((app) => app.accessMode === "trusted_app").map((app) => app.appId.slice(4))
			: [],
	);
	const agentTrustedSystems = trustedSystems.filter((system) => trustedAppIds.has(system.published_app_id));
	const trustedAccessPanel =
		trustedAppIds.size > 0 ? (
			<section className="ard-side-card ard-trusted-card" aria-label="受信任系统接入">
				<h3>受信任系统接入</h3>
				{trustedError !== null ? (
					<p className="ard-trusted-error" role="alert">
						{trustedError}
					</p>
				) : null}
				{agentTrustedSystems.length === 0 ? <p className="ard-side-empty">尚未签发接入密钥</p> : null}
				{agentTrustedSystems.map((system) => (
					<div className="ard-trusted-system" key={system.id}>
						<div className="ard-trusted-heading">
							<strong>{system.name}</strong>
							<span className={system.enabled ? "is-enabled" : ""}>{system.enabled ? "已启用" : "已停用"}</span>
						</div>
						<span className="ard-trusted-label">Client ID</span>
						<code className="ard-trusted-value">{system.client_id}</code>
						{pendingRotation === system.client_id ? (
							<div className="ard-trusted-confirm">
								<p>重新生成后，旧 Secret 立即失效。</p>
								<div>
									<button type="button" onClick={() => setPendingRotation(null)} disabled={trustedBusy}>
										取消
									</button>
									<button
										type="button"
										className="ard-trusted-confirm-action"
										disabled={trustedBusy}
										onClick={() => {
											setTrustedBusy(true);
											setTrustedError(null);
											void api.updateTrustedSystem(system.client_id, "rotate").then(
												(result) => {
													if (result.clientSecret !== undefined) {
														setNewSecret({ clientId: system.client_id, value: result.clientSecret });
														setCopiedSecret(false);
													}
													setPendingRotation(null);
													setTrustedBusy(false);
												},
												(error: unknown) => {
													setTrustedError(errorMessage(error));
													setTrustedBusy(false);
												},
											);
										}}
									>
										{trustedBusy ? "生成中…" : "确认重新生成"}
									</button>
								</div>
							</div>
						) : (
							<button
								className="ard-trusted-rotate"
								type="button"
								disabled={trustedBusy}
								onClick={() => setPendingRotation(system.client_id)}
							>
								重新生成密钥
							</button>
						)}
						{newSecret?.clientId === system.client_id ? (
							<output className="ard-trusted-issued">
								<span className="ard-trusted-label">新 Client Secret · 仅本次显示</span>
								<code className="ard-trusted-value">{newSecret.value}</code>
								<button
									className="ard-trusted-copy"
									type="button"
									onClick={() => {
										void navigator.clipboard.writeText(newSecret.value).then(
											() => setCopiedSecret(true),
											(error: unknown) => setTrustedError(errorMessage(error)),
										);
									}}
								>
									{copiedSecret ? "已复制" : "复制 Secret"}
								</button>
								<p>请保存到宿主后端。刷新页面后无法再次查看。</p>
							</output>
						) : null}
					</div>
				))}
			</section>
		) : null;

	// ---- 主区：Skill / MCP 绑定，id 引用经目录翻译成可读名称 ----
	const skillItems: readonly AgentResource[] = (state.detail.skills ?? []).map((ref) => {
		const catalog =
			skillCatalog.kind === "loaded" ? skillCatalog.items.find((item) => item.id === ref.skillId) : undefined;
		return {
			id: ref.skillId,
			name: catalog?.name ?? ref.skillId,
			version: `v${ref.revision}`,
			revision: ref.revision,
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
			revision: ref.revision,
			enabled: catalog?.status === "enabled",
			connectionStatus: catalog?.connectionStatus,
			toolCount: ref.toolNames.length,
			toolNames: ref.toolNames,
			outdated: catalog !== undefined && ref.revision < catalog.currentRevision,
		};
	});

	return (
		<>
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
				onPublish={() => setPublishDrawerMode("open")}
				onDirtyChange={handleDirtyChange}
				createdAt={updatedAtLabel}
				createdBy={state.detail.updatedBy}
				agentId={state.detail.id}
				publishData={publishData}
				trustedAccessPanel={trustedAccessPanel}
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
								connectionStatus: item.connectionStatus,
								toolCount: item.toolCount,
								toolNames: item.toolNames,
							}))
						: undefined
				}
				hasDraft={state.detail.hasDraft}
			/>
			<PublishDrawer
				agentId={agentId}
				apps={apps.kind === "loaded" ? apps.items : []}
				appsLoading={apps.kind === "loading"}
				appsError={apps.kind === "error" ? apps.message : undefined}
				onReloadApps={loadApps}
				hasDraft={hasUnsavedChanges}
				mode={publishDrawerMode}
				onClose={() => setPublishDrawerMode("closed")}
				onPublished={() => {
					setPublishDrawerMode("closed");
					load();
					loadRevisions();
					loadApps();
				}}
			/>
		</>
	);
}

function RealAgentList(): React.ReactElement {
	const { dialog, ...dialogs } = useDialogs();
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
		<>
			{dialog}
			<AgentListPreview
				embedded
				items={items}
				loadState={state.kind === "loaded" ? "ready" : state.kind}
				errorMessage={state.kind === "error" ? state.message : undefined}
				onRetry={load}
				createPending={creating}
				onCreate={async () => {
					if (creating) return;
					const name = (
						await dialogs.prompt("为新的 Agent 填写一个名称。", {
							title: "新建 Agent",
							inputLabel: "Agent 名称",
							confirmLabel: "创建",
							maxLength: 200,
						})
					)?.trim();
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
									realtimeVoice: false,
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
								void dialogs.alert(error instanceof Error ? error.message : String(error), {
									title: "创建失败",
								});
							},
						);
				}}
				onOpen={(agent) => navigate(`/agents/${agent.id as AgentPublicId}`)}
				onDelete={async (agent) => {
					const confirmation = await dialogs.prompt("删除前会检查关联应用。请输入完整的 Agent 名称以确认。", {
						title: "删除 Agent",
						typeToConfirm: agent.name,
						inputLabel: `Agent 名称：${agent.name}`,
						confirmLabel: "确认删除",
						destructive: true,
					});
					if (confirmation === null) return;
					void api.deleteAgent(agent.id as AgentPublicId, confirmation).then(load, (error: unknown) => {
						void dialogs.alert(error instanceof Error ? error.message : String(error), { title: "删除失败" });
					});
				}}
			/>
		</>
	);
}
