/** Agent 列表与详情入口。列表只展示 Control API 返回的真实数据。 */
import type {
	AgentDefinitionDetail,
	AgentDefinitionSummary,
	AgentPublicId,
	LlmAvailableModel,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type AgentDetailData,
	AgentDetailPreview,
	type AgentEditableDraft,
	type AgentListItem,
	AgentListPreview,
} from "../../ui-preview/agent-redesign.tsx";
import { AgentApi } from "../api/agent-api.ts";
import { newIdempotencyKey } from "../api/idempotency.ts";
import { LlmApi } from "../api/llm-api.ts";
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

const CARD_TONES = ["blue", "green", "violet", "amber", "orange", "teal", "red", "slate"] as const;

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
	const [state, setState] = useState<DetailState>({ kind: "loading" });
	const [models, setModels] = useState<ModelsState>({ kind: "loading" });
	const load = useCallback(() => {
		setState({ kind: "loading" });
		void api.getAgentDetail(agentId).then(
			(detail) => setState({ kind: "loaded", detail }),
			(error: unknown) =>
				setState({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
		);
	}, [agentId, api]);

	useEffect(() => {
		load();
	}, [load]);
	useEffect(() => {
		setModels({ kind: "loading" });
		void llmApi.listModels().then(
			(result) => setModels({ kind: "loaded", items: result.items }),
			(error: unknown) =>
				setModels({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
		);
	}, [llmApi]);

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
				},
				changeSummary: "Updated from Agent design",
			},
			newIdempotencyKey({ operation: "agent.save" }),
		);
		const refreshed = await api.getAgentDetail(agentId);
		setState({ kind: "loaded", detail: refreshed });
	};
	return (
		<AgentDetailPreview
			key={`${agentId}:${state.detail.currentRevision}`}
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
			onTest={() => navigate(`/?agentId=${agentId}`)}
		/>
	);
}

function RealAgentList(): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useMemo(() => new AgentApi({ auth: controller }), [controller]);
	const [state, setState] = useState<ListState>({ kind: "loading" });

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
