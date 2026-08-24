/**
 * WB-006 / M1: 会话详情"思考强度"（reasoning）tab（V2-README §4.3）。
 *
 * Capability 驱动的 UI：仅渲染当前会话绑定 Agent Revision 的模型能力目录
 * 声明的 reasoning 档位（`LlmAvailableModel.parameterCapabilities.reasoning.efforts`），
 * 不允许任意字符串输入。服务端 422 `REASONING_INVALID_EFFORT` 仍是最终防线，
 * 但前端不会把任意 draft 发到服务端。
 *
 * 数据契约：
 * - 请求：`ReasoningUpdateRequest = { effort: ReasoningEffort | null }`，
 *   `null` 表示清除会话覆盖 → 回到 Agent Revision 默认。
 * - 响应：`ConversationReasoningState = { conversationId, effort, updatedAt }`。
 * - 错误码：
 *   - 404 `CONVERSATION_NOT_FOUND` → 跨租户，**不**暴露归属；
 *   - 422 `REASONING_INVALID_EFFORT` → 档位不在模型能力目录内；
 *   - 403 `REASONING_NOT_CONFIGURABLE` → 策略禁止调整。
 *
 * 数据来源（**生产路径，无 fixture**）：
 *   1. `ConversationsApi.getReasoning` 读取事实源；
 *   2. `AgentApi.getAgentDetail(conversation.agentId)` 拿到当前会话绑定的 Agent
 *      Definition（含 `modelId`）；
 *   3. `LlmApi.listModels()` 拿到模型能力目录；
 *   4. 用 `modelId` 在 catalog 中查找 `LlmAvailableModel`，把
 *      `parameterCapabilities.reasoning.efforts` 作为 `<select>` 选项集合。
 *
 * 过期请求保护：load 与 save 各持一个独立的 `StaleResponseGuard`：
 * - `loadGuard` 守护 `getReasoning` 与能力加载；
 * - `saveGuard` 守护 `putReasoning`，**关键**：`conversationId` 变化、组件卸载
 *   或新保存发起时**取消旧保存**——避免旧保存响应覆盖新 conversation 状态。
 *
 * 不复制 DTO：组件 import `ReasoningUpdateRequest` / `ConversationReasoningState`
 * / `ReasoningEffort` / `AgentDefinitionDetail` / `LlmAvailableModel` /
 * `ModelParameterCapabilities` 直接用于 wire 与渲染；任何档位字面量都来自
 * 协议 union 或 `efforts` 数组（来自 catalog），前端不构造协议外档位。
 */
import type {
	AgentDefinitionDetail,
	AgentPublicId,
	ConversationPublicId,
	ConversationReasoningState,
	LlmAvailableModel,
	ReasoningEffort,
	ReasoningUpdateRequest,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentApi } from "../api/agent-api.ts";
import type { ConversationsApi } from "../api/conversations-api.ts";
import type { LlmApi } from "../api/llm-api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { createStaleResponseGuard, type DataState, describeError, toDataStateError } from "../data-state.ts";

type ErrorDataState = Extract<DataState<ConversationReasoningState>, { kind: "error" }>;

/** 与 metrics-tab / conversation-detail 同样的窄化 helper；上游 raw string 必须是 `conv_${string}`。 */
function asConversationPublicId(raw: string): ConversationPublicId | null {
	return raw.startsWith("conv_") ? (raw as ConversationPublicId) : null;
}

/** 上游 `props.conversationId` 路径错误（非 `conv_` 前缀）→ tab 直接进入 error 分支，不发请求。 */
function routeMismatchError(raw: string): ErrorDataState {
	return toDataStateError(new Error(`conversationId must start with "conv_", got ${JSON.stringify(raw)}`));
}

/**
 * 加载能力目录的派生状态。
 *
 * 把 capability fetch + reasoning state fetch 拆成两个子状态是因为它们的失败
 * 模式不一样：capability 拉取失败时 reasoning tab 应该**完全禁用**保存（无
 * catalog → 不知道合法档位），而 reasoning state 拉取失败时可以保留按钮
 * 但展示 banner。
 */
type CapabilityState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "loaded"; model: LlmAvailableModel }
	| { kind: "missing-model"; modelId: string | null }
	| { kind: "unsupported"; model: LlmAvailableModel }
	| { kind: "no-configurable"; model: LlmAvailableModel }
	| { kind: "error"; message: string };

/** Save 操作的本地状态。`saving` 时禁用输入；失败时 `code` 透传到错误壳。 */
type SaveState =
	| { kind: "idle" }
	| { kind: "saving"; effort: ReasoningEffort | null }
	| { kind: "error"; code: string; message: string; lastEffort: ReasoningEffort | null };

export interface ReasoningTabProps {
	readonly conversationId: string;
	/** 该会话关联的 Agent ID（从 `ConversationAdminSummary.agentId` 传入；可空表示数据未就绪）。 */
	readonly agentId: AgentPublicId | null;
	readonly api: ConversationsApi;
	readonly agentApi: AgentApi;
	readonly llmApi: LlmApi;
}

/**
 * 把协议 `ReasoningEffort` union 字面量直接渲染为标签（与 `reasoning-efforts.ts`
 * 6 档透传口径一致）。前端不引入产品语义翻译——`minimal` / `low` / `medium`
 * / `high` / `xhigh` / `max` 都是合法 wire 值。
 */
export function formatReasoningEffort(effort: ReasoningEffort): string {
	return effort;
}

export function ReasoningTab({
	conversationId,
	agentId,
	api,
	agentApi,
	llmApi,
}: ReasoningTabProps): React.ReactElement {
	const [state, setState] = useState<DataState<ConversationReasoningState>>({ kind: "idle" });
	const [capability, setCapability] = useState<CapabilityState>({ kind: "idle" });
	const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

	/** 用户正在编辑的 draft effort。空串 = "使用 Agent 默认"。 */
	const [draft, setDraft] = useState<ReasoningEffort | "">("");

	// 两个独立的代际守卫。**关键**：`loadGuard` 与 `saveGuard` 互不影响——
	// 重新发起保存不会取消同一会话的 in-flight load。
	const loadGuardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (loadGuardRef.current === null) loadGuardRef.current = createStaleResponseGuard();
	const loadGuard = loadGuardRef.current;

	const saveGuardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (saveGuardRef.current === null) saveGuardRef.current = createStaleResponseGuard();
	const saveGuard = saveGuardRef.current;

	const cid = asConversationPublicId(conversationId);

	/**
	 * 能力加载：先取 Agent Definition（拿到 `modelId`），再去 LLM catalog 查
	 * `LlmAvailableModel`。两条请求都被 `loadGuard` 守护；任一失败 tab 进入
	 * 不可用态（不显示 form）。
	 */
	const loadCapability = useCallback(
		(cancelRef: { cancelled: boolean }) => {
			if (cid === null) return;
			if (agentId === null) {
				if (!cancelRef.cancelled) {
					setCapability({ kind: "error", message: "会话尚未关联 Agent，无法获取模型能力目录" });
				}
				return;
			}
			const ticket = loadGuard.begin();
			setCapability({ kind: "loading" });
			Promise.all([agentApi.getAgentDetail(agentId), llmApi.listModels()])
				.then(([detail, models]) => {
					if (cancelRef.cancelled) return;
					ticket.commit(() => {
						const resolved = resolveCapability(detail, models.items);
						setCapability(resolved);
					});
				})
				.catch((err: unknown) => {
					if (err instanceof DOMException && err.name === "AbortError") return;
					if (cancelRef.cancelled) return;
					ticket.commit(() => {
						const message = err instanceof Error ? err.message : String(err);
						setCapability({ kind: "error", message });
					});
				});
		},
		[agentApi, agentId, cid, llmApi, loadGuard],
	);

	const loadState = useCallback(
		(cancelRef: { cancelled: boolean }) => {
			if (cid === null) return;
			const ticket = loadGuard.begin();
			setState({ kind: "loading" });
			api.getReasoning(cid, ticket.signal)
				.then((data) => {
					if (cancelRef.cancelled) return;
					ticket.commit(() => {
						setState({ kind: "loaded", data });
						setDraft(data.effort ?? "");
					});
				})
				.catch((err: unknown) => {
					if (err instanceof DOMException && err.name === "AbortError") return;
					if (cancelRef.cancelled) return;
					ticket.commit(() => setState(toDataStateError(err)));
				});
		},
		[api, cid, loadGuard],
	);

	useEffect(() => {
		if (cid === null) {
			setState(routeMismatchError(conversationId));
			setCapability({ kind: "error", message: "conversationId 非法" });
			return;
		}
		const cancelRef = { cancelled: false };
		loadCapability(cancelRef);
		loadState(cancelRef);
		return () => {
			// 卸载 / conversationId 变化：取消 in-flight load 与 save，
			// 防止旧会话保存响应覆盖新会话状态。
			cancelRef.cancelled = true;
			loadGuard.cancel();
			saveGuard.cancel();
		};
	}, [cid, conversationId, loadCapability, loadGuard, loadState, saveGuard]);

	const onRetryLoad = useCallback(() => {
		if (cid === null) {
			setState(routeMismatchError(conversationId));
			return;
		}
		const cancelRef = { cancelled: false };
		loadCapability(cancelRef);
		loadState(cancelRef);
	}, [cid, conversationId, loadCapability, loadState]);

	const onSave = useCallback(async () => {
		if (state.kind !== "loaded") return;
		if (cid === null) {
			setSaveState({
				kind: "error",
				code: "CONVERSATION_NOT_FOUND",
				message: `conversationId must start with "conv_", got ${JSON.stringify(conversationId)}`,
				lastEffort: draft === "" ? null : draft,
			});
			return;
		}
		if (capability.kind !== "loaded" && capability.kind !== "no-configurable") {
			// 没有 catalog 的情况下不应允许 save（capability 是 unsupported / error / loading）。
			setSaveState({
				kind: "error",
				code: "REASONING_INVALID_EFFORT",
				message: "模型能力目录尚未就绪，无法保存档位",
				lastEffort: draft === "" ? null : draft,
			});
			return;
		}
		const nextEffort: ReasoningEffort | null = draft === "" ? null : draft;
		// 前端校验：档位必须在 catalog 的 `efforts` 集合内。如果不在，
		// 直接进 error，不发请求（避免把无效 wire 值推到服务端）。
		if (nextEffort !== null) {
			const declared = capability.kind === "loaded" ? capability.model.parameterCapabilities.reasoning.efforts : [];
			if (!declared.includes(nextEffort)) {
				setSaveState({
					kind: "error",
					code: "REASONING_INVALID_EFFORT",
					message: `档位 ${nextEffort} 不在当前模型能力目录声明档位 [${declared.join(", ")}] 内`,
					lastEffort: nextEffort,
				});
				return;
			}
		}
		setSaveState({ kind: "saving", effort: nextEffort });
		// 发起新保存 → **取消上一代保存**（关键：避免旧 conversation 的
		// putReasoning 响应覆盖新 conversation 的状态）。
		saveGuard.cancel();
		const ticket = saveGuard.begin();
		const body: ReasoningUpdateRequest = { effort: nextEffort };
		try {
			const updated = await api.putReasoning(cid, body, ticket.signal);
			if (ticket.signal.aborted) return;
			ticket.commit(() => {
				setState({ kind: "loaded", data: updated });
				setDraft(updated.effort ?? "");
				setSaveState({ kind: "idle" });
			});
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return;
			if (ticket.signal.aborted) return;
			// 错误码透传：`ConversationsApiError.code` 直接来自服务端 envelope；
			// `REASONING_INVALID_EFFORT` / `REASONING_NOT_CONFIGURABLE` 由此到达 UI。
			const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "HTTP_ERROR";
			const message = err instanceof Error ? err.message : String(err);
			ticket.commit(() => {
				setSaveState({ kind: "error", code, message, lastEffort: nextEffort });
			});
		}
	}, [api, capability, cid, conversationId, draft, saveGuard, state.kind]);

	// capability 不在 loaded 态时：tab 进入说明壳（不显示 form）。
	if (capability.kind === "idle" || capability.kind === "loading") {
		return (
			<EmptyState
				kind="loading"
				title="加载模型能力目录…"
				description="从服务端拉取该会话绑定 Agent 的模型 capabilities。"
				compact
			/>
		);
	}
	if (capability.kind === "error") {
		return (
			<EmptyState
				kind="error"
				title="无法加载模型能力目录"
				description={capability.message}
				action={
					<button type="button" onClick={onRetryLoad}>
						重试
					</button>
				}
				compact
			/>
		);
	}
	if (capability.kind === "missing-model") {
		return (
			<EmptyState
				kind="empty"
				title="该 Agent 尚未选择模型"
				description={`modelId=${capability.modelId === null ? "null" : capability.modelId}；无法读取 reasoning 参数能力。`}
				compact
			/>
		);
	}
	if (capability.kind === "unsupported") {
		return (
			<EmptyState
				kind="empty"
				title="当前模型不支持 reasoning"
				description={`模型 ${capability.model.name} 的能力目录声明 supported=false；会话级 effort 覆盖在此模型上不适用。`}
				compact
			/>
		);
	}

	const configuredEfforts =
		capability.kind === "loaded"
			? capability.model.parameterCapabilities.reasoning.efforts
			: capability.kind === "no-configurable"
				? capability.model.parameterCapabilities.reasoning.efforts
				: [];

	if (state.kind === "loading" || state.kind === "idle") {
		return (
			<EmptyState
				kind="loading"
				title="加载思考强度覆盖…"
				description="从服务端拉取单会话 effort 事实源。"
				compact
			/>
		);
	}
	if (state.kind === "error") {
		return (
			<EmptyState
				kind="error"
				title={describeError(state).title}
				description={describeError(state).description}
				action={
					<button type="button" onClick={onRetryLoad}>
						重试
					</button>
				}
				compact
			/>
		);
	}
	if (state.kind === "partial") {
		return (
			<EmptyState
				kind="error"
				title="思考强度返回不完整"
				description={`缺字段：${state.missing.join("、")}`}
				action={
					<button type="button" onClick={onRetryLoad}>
						重试
					</button>
				}
				compact
			/>
		);
	}
	if (state.kind === "empty") {
		return (
			<EmptyState
				kind="empty"
				title="暂无思考强度覆盖"
				description="服务端表示此会话没有覆盖，使用 Agent Revision 默认 effort。"
				compact
			/>
		);
	}
	// loaded 分支：渲染 form（capability 已就绪，state 已 loaded）
	const currentState = state.data;
	const isSaving = saveState.kind === "saving";
	const canClear = !isSaving && draft !== "";
	const canSave = !isSaving && (draft === "" || configuredEfforts.includes(draft as ReasoningEffort));
	return (
		<div className="card reasoning-tab">
			<p className="conversation-meta">
				会话 {currentState.conversationId} · 最近覆盖时间 {new Date(currentState.updatedAt).toLocaleString()}
			</p>
			{currentState.effort === null ? (
				<p>当前未设置覆盖，使用 Agent Revision 默认 effort。</p>
			) : (
				<p>
					当前会话覆盖 effort：<strong>{formatReasoningEffort(currentState.effort)}</strong>
				</p>
			)}

			<div>
				<label htmlFor="reasoning-effort-draft">覆盖档位（空 = 使用 Agent Revision 默认）</label>
				<select
					id="reasoning-effort-draft"
					value={draft}
					onChange={(e) => setDraft(e.currentTarget.value as ReasoningEffort | "")}
					disabled={isSaving}
				>
					<option value="">使用 Agent Revision 默认（{configuredEfforts[0] ?? "—"}）</option>
					{configuredEfforts.map((effort) => (
						<option key={effort} value={effort}>
							{formatReasoningEffort(effort)}
						</option>
					))}
				</select>
				<small>
					选项来自模型能力目录（{configuredEfforts.length} 档）；不允许任意输入—— 服务端 422
					`REASONING_INVALID_EFFORT` 是最终防线。
				</small>
			</div>

			<div>
				<button type="button" onClick={onSave} disabled={!canSave}>
					{isSaving ? "保存中…" : "保存覆盖"}
				</button>
				<button type="button" onClick={() => setDraft("")} disabled={!canClear}>
					清除 draft
				</button>
			</div>

			{saveState.kind === "error" && (
				<div className="banner error" data-error-code={saveState.code}>
					保存失败：{saveState.message}（错误码 {saveState.code}）
				</div>
			)}
		</div>
	);
}

/**
 * 把 agent detail + LLM catalog 合并为 `CapabilityState`：
 *
 *   - `modelId === null` → `missing-model`（Agent 还没选模型）；
 *   - 找不到 catalog 条目 → `missing-model`（modelId 非空但 catalog 没有，可能是已下线）；
 *   - `parameterCapabilities.reasoning.supported === false` → `unsupported`；
 *   - `efforts: []` → `unsupported`（声明支持但档位为空，按不支持处理）；
 *   - 其它 → `loaded`，**附带完整 model 引用**供 UI 渲染档位集合。
 */
function resolveCapability(detail: AgentDefinitionDetail, models: readonly LlmAvailableModel[]): CapabilityState {
	if (detail.modelId === null) return { kind: "missing-model", modelId: null };
	const model = models.find((m) => m.id === detail.modelId);
	if (model === undefined) return { kind: "missing-model", modelId: detail.modelId };
	const reasoning = model.parameterCapabilities.reasoning;
	if (!reasoning.supported) return { kind: "unsupported", model };
	if (reasoning.efforts.length === 0) return { kind: "unsupported", model };
	// `toggle=false` 也允许覆盖（很多 reasoning 模型是 always-on，没有 toggle 但能选档位）；
	// UI 仍按 catalog 的 `efforts` 渲染，保存仍受服务端档位校验。
	return { kind: "loaded", model };
}

/** 重新导出协议 DTO，便于上游 tests 直接 import 同一来源。 */
export type { ConversationReasoningState, ReasoningUpdateRequest };
