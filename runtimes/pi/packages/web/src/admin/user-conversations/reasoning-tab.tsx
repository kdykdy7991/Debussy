/**
 * WB-006 / M1: 会话详情"思考强度"（reasoning）tab（V2-README §4.3）。
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
 * # R8 修订（capability 数据源）
 *
 * capability 必须基于**会话固定的 PublishedAppVersion**——而非当前 Agent
 * Revision 或当前 LLM catalog。旧会话在 Agent 发 v2 后，UI 不能给 v1
 * 会话显示 v2 档位（这与"会话级覆盖"语义冲突：用户改 v1 会话的努力
 * 不能因为 Agent 升级而漂移）。
 *
 * 当前**后端只读契约待架构师确认**（M1 R8 Blocker 2 留 TODO）。FE 不能
 * 在协议未冻结前自行扩展 DTO。**临时方案**：tab 进入"等待后端契约"态，
 * 不展示档位编辑入口；只读 `getReasoning` 仍加载（事实源 + 写接口
 * 仍可用，但 UI 不暴露输入）。详见
 * `docs/development/agent-platform-v2/evidence/m1-r8-blocker2.md`。
 *
 * 一旦 BE 契约冻结（建议 endpoint
 * `GET /api/control/v1/conversations/{id}/capability` 返回
 * `{ publishedAppVersionId, modelId, parameterCapabilities }`），把
 * `loadCapability` 重新接入；`getReasoning` / `putReasoning` 不变。
 *
 * # 过期请求保护
 *
 * `stateGuard`（守护 `getReasoning`）与 `saveGuard`（守护 `putReasoning`）
 * 互不影响：重新发起保存不会取消同一会话的 in-flight load；切换
 * `conversationId` / 组件卸载时两者都 cancel。
 *
 * 不复制 DTO：组件 import `ReasoningUpdateRequest` / `ConversationReasoningState`
 * / `ReasoningEffort` / `ConversationPublicId` 直接用于 wire 与渲染；
 * 任何档位字面量都来自协议 union。
 */
import type {
	ConversationPublicId,
	ConversationReasoningState,
	ReasoningEffort,
	ReasoningUpdateRequest,
} from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationsApi } from "../api/conversations-api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { createStaleResponseGuard, type DataState, describeError, toDataStateError } from "../data-state.ts";

type ErrorDataState = Extract<DataState<ConversationReasoningState>, { kind: "error" }>;

/** 与 metrics-tab 同样的窄化 helper；上游 raw string 必须是 `conv_${string}`。 */
function asConversationPublicId(raw: string): ConversationPublicId | null {
	return raw.startsWith("conv_") ? (raw as ConversationPublicId) : null;
}

/** 上游 `props.conversationId` 路径错误（非 `conv_` 前缀）→ tab 直接进入 error 分支，不发请求。 */
function routeMismatchError(raw: string): ErrorDataState {
	return toDataStateError(new Error(`conversationId must start with "conv_", got ${JSON.stringify(raw)}`));
}

/**
 * Capability 状态。R8 之后只剩两个形态：
 *
 * - `awaiting-contract`：后端只读契约未冻结，UI 隐藏档位编辑入口（只读
 *   加载 reasoning 事实源）；
 * - `ready`：BE 契约冻结后接入——R8 暂未实现，留占位说明。
 */
export type CapabilityState =
	| { readonly kind: "awaiting-contract"; readonly reason: string }
	| { readonly kind: "ready"; readonly configuredEfforts: readonly ReasoningEffort[] };

/** Save 操作的本地状态。`saving` 时禁用输入；失败时 `code` 透传到错误壳。 */
type SaveState =
	| { kind: "idle" }
	| { kind: "saving"; effort: ReasoningEffort | null }
	| { kind: "error"; code: string; message: string; lastEffort: ReasoningEffort | null };

/** R8 之后 `ReasoningTab` 不再接 `agentApi` / `llmApi`——capability 来源待 BE 契约。 */
export interface ReasoningTabProps {
	readonly conversationId: string;
	readonly api: ConversationsApi;
}

/**
 * 把协议 `ReasoningEffort` union 字面量直接渲染为标签（与 `reasoning-efforts.ts`
 * 6 档透传口径一致）。前端不引入产品语义翻译——`minimal` / `low` / `medium`
 * / `high` / `xhigh` / `max` 都是合法 wire 值。
 */
export function formatReasoningEffort(effort: ReasoningEffort): string {
	return effort;
}

/** Capability 当前是否阻塞写操作（save）。R8 永远为 `true`（BE 契约未冻结）。 */
function isCapabilityBlockingSave(capability: CapabilityState): boolean {
	return capability.kind === "awaiting-contract";
}

export function ReasoningTab({ conversationId, api }: ReasoningTabProps): React.ReactElement {
	const [state, setState] = useState<DataState<ConversationReasoningState>>({ kind: "idle" });
	const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

	/** 用户正在编辑的 draft effort。空串 = "使用 Agent 默认"。 */
	const [draft, setDraft] = useState<ReasoningEffort | "">("");

	// R8 修订：`loadGuard` → `stateGuard`，命名明示它只守护 `getReasoning`。
	// 与 `saveGuard` 严格区分——避免 R7 那种"两个 begin() 共享 guard 互相
	// 取消"的隐式死锁。
	const stateGuardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (stateGuardRef.current === null) stateGuardRef.current = createStaleResponseGuard();
	const stateGuard = stateGuardRef.current;

	const saveGuardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (saveGuardRef.current === null) saveGuardRef.current = createStaleResponseGuard();
	const saveGuard = saveGuardRef.current;

	const cid = asConversationPublicId(conversationId);

	const loadState = useCallback(
		(cancelRef: { cancelled: boolean }) => {
			if (cid === null) return;
			const ticket = stateGuard.begin();
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
		[api, cid, stateGuard],
	);

	useEffect(() => {
		if (cid === null) {
			setState(routeMismatchError(conversationId));
			return;
		}
		const cancelRef = { cancelled: false };
		loadState(cancelRef);
		return () => {
			// 卸载 / conversationId 变化：取消 in-flight state 与 save，
			// 防止旧会话保存响应覆盖新会话状态。
			cancelRef.cancelled = true;
			stateGuard.cancel();
			saveGuard.cancel();
		};
	}, [cid, conversationId, loadState, saveGuard, stateGuard]);

	const onRetryLoad = useCallback(() => {
		if (cid === null) {
			setState(routeMismatchError(conversationId));
			return;
		}
		const cancelRef = { cancelled: false };
		loadState(cancelRef);
	}, [cid, conversationId, loadState]);

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
		const nextEffort: ReasoningEffort | null = draft === "" ? null : draft;
		// R8：capability 永远阻塞非空档位保存（BE 契约未冻结）。等到契约
		// 接入后，这里改成"如果 `nextEffort` 不在 `configuredEfforts` 内
		// 则 reject"。
		if (nextEffort !== null) {
			setSaveState({
				kind: "error",
				code: "REASONING_INVALID_EFFORT",
				message: "前端 capability 数据源待后端契约冻结（详见 m1-r8-blocker2.md）；暂不允许保存档位。",
				lastEffort: nextEffort,
			});
			return;
		}
		// `null` 清除覆盖在 capability 未就绪时**仍可发**——服务端 422 是
		// 最终防线，前端不阻塞。
		setSaveState({ kind: "saving", effort: nextEffort });
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
	}, [api, cid, conversationId, draft, saveGuard, state.kind]);

	// R8：capability 固定为 awaiting-contract（BE 契约待架构师确认）。
	const capability: CapabilityState = {
		kind: "awaiting-contract",
		reason: "本会话 capability 需通过会话固定 PublishedAppVersion 的只读契约获取；BE 契约冻结前前端不展示档位编辑。",
	};

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

	// loaded 分支：渲染只读事实 + capability 等待契约提示（不暴露档位输入）。
	const currentState = state.data;
	const isSaving = saveState.kind === "saving";
	const canClear = !isSaving && draft !== "";
	// 写能力受限：draft === ""（清除覆盖）允许；非空 draft 在 capability
	// 阻塞期间不允许 save。
	const saveBlocked = isCapabilityBlockingSave(capability) && draft !== "";
	const canSave = !isSaving && !saveBlocked;
	return (
		<div className="card reasoning-tab">
			<p className="conversation-meta">
				会话 {currentState.conversationId} · 最近覆盖时间{" "}
				{new Date(currentState.updatedAt).toLocaleString()}
			</p>
			{currentState.effort === null ? (
				<p>当前未设置覆盖，使用 Agent Revision 默认 effort。</p>
			) : (
				<p>
					当前会话覆盖 effort：<strong>{formatReasoningEffort(currentState.effort)}</strong>
				</p>
			)}

			{capability.kind === "awaiting-contract" && (
				<EmptyState
					kind="empty"
					title="档位编辑待后端契约冻结"
					description={capability.reason}
					compact
				/>
			)}

			<div>
				<button type="button" onClick={onSave} disabled={!canSave}>
					{isSaving ? "保存中…" : saveBlocked ? "档位编辑未开放" : "保存覆盖（清除）"}
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

/** 重新导出协议 DTO，便于上游 tests 直接 import 同一来源。 */
export type { ConversationReasoningState, ReasoningUpdateRequest };
