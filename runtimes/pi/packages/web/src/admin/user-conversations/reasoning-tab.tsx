/**
 * WB-006 / M1: 会话详情"思考强度"（reasoning）tab（V2-README §4.3）。
 *
 * 数据契约：
 * - 请求：`ReasoningUpdateRequest = { effort: ReasoningEffort | null }`，
 *   `null` 表示清除会话覆盖 → 回到 Agent Revision 默认（契约§11 决策）；
 * - 响应同时携带会话固定 Published App Version 的 capability 快照（pinned）；
 * - `effort === null` UI 显示"跟随 Revision 默认"，**不**展示数值；
 *   若 `pinnedCapability.reasoning.defaultEffort` 存在，可作提示文案。
 *   `defaultEffort` 是模型/Provider 默认——**不要**冒充为 Revision 默认。
 * - 错误码：
 *   - 404 `CONVERSATION_NOT_FOUND` → 跨租户，**不**暴露归属；
 *   - 422 `REASONING_INVALID_EFFORT` → 档位不在模型能力目录内；
 *   - 403 `REASONING_NOT_CONFIGURABLE` → 策略禁止调整；
 *   - 408 `REQUEST_TIMEOUT`（API 层 transport code）→ 30s 超时，可手动重试。
 *
 * # capability 数据源
 *
 * capability 必须基于**会话固定的 PublishedAppVersion**——而非当前 Agent
 * Revision 或当前 LLM catalog。旧会话在 Agent 发 v2 后，UI 不能给 v1
 * 会话显示 v2 档位（这与"会话级覆盖"语义冲突：用户改 v1 会话的努力
 * 不能因为 Agent 升级而漂移）。
 *
 * capability 与 effort 由同一个 GET DTO 原子返回，不额外调用 Agent 或
 * live LLM catalog，也没有第二个 capability 请求的竞态。
 *
 * # 过期请求保护 + 30s 超时（正交）
 *
 * `stateGuard`（守护 `getReasoning`）与 `saveGuard`（守护 `putReasoning`）
 * 互不影响：重新发起保存不会取消同一会话的 in-flight load；切换
 * `conversationId` / 组件卸载时两者都 cancel。
 *
 * 30 秒超时由 `ConversationsApi.withReasoningTimeout` 引入，**与** stale
 * guard 的 signal 通过 `AbortSignal.any` 并联——切换会话仍走 stale guard
 * 静默吞掉 abort；30s 真正到点则抛 `ConversationsApiError.code =
 * "REQUEST_TIMEOUT"`，`retryable=true`，UI 引导手动重试。
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
 * Capability 状态。两态：
 *
 * - `unavailable`：会话不能调整 thinking effort。`reason` 区分禁用原因以
 *   利于 UI 文案与单测断言，但**不**重新引入 `awaiting-contract`——契约
 *   已冻结，等不到开放日再分裂状态。
 *   - `legacy`：会话固定的 Published App Version 没沉淀 capability 快照
 *     （`pinnedCapability === null` 或 `configurable:false`）；
 *   - `unsupported`：会话模型 capability 显式 `supported:false`；
 *   - `no-efforts`：模型声明 `supported:true` 但档位白名单为空（极端配置）；
 * - `ready`：可以调整，`configuredEfforts` 是会话模型**冻结**档位白名单。
 *
 * `toggle:false` 不参与 ready/unavailable 判定——它只控制"是否能关掉思考"，
 * 仍属 ready：会话覆盖端仍可调 effort 档位。
 */
export type CapabilityState =
	| {
			readonly kind: "unavailable";
			readonly reason: "legacy" | "unsupported" | "no-efforts";
			readonly message: string;
	  }
	| { readonly kind: "ready"; readonly configuredEfforts: readonly ReasoningEffort[] };

/** Save 操作的本地状态。`saving` 时禁用输入；失败时 `code` 透传到错误壳。 */
type SaveState =
	| { kind: "idle" }
	| { kind: "saving"; effort: ReasoningEffort | null }
	| { kind: "error"; code: string; message: string; lastEffort: ReasoningEffort | null };

/** `ReasoningTab` 仅消费 `ConversationsApi`——capability 由 GET reasoning DTO 原子带回。 */
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

export function capabilityStateFromReasoning(state: ConversationReasoningState): CapabilityState {
	const pinned = state.pinnedCapability;
	if (!state.configurable || pinned === null) {
		return {
			kind: "unavailable",
			reason: "legacy",
			message: "该会话固定版本没有可配置的 reasoning capability。",
		};
	}
	if (!pinned.reasoning.supported) {
		return {
			kind: "unavailable",
			reason: "unsupported",
			message: "该会话模型不提供 reasoning 能力。",
		};
	}
	if (pinned.reasoning.efforts.length === 0) {
		return {
			kind: "unavailable",
			reason: "no-efforts",
			message: "该会话模型未声明任何可用的 thinking effort 档位。",
		};
	}
	return { kind: "ready", configuredEfforts: pinned.reasoning.efforts };
}

/**
 * 提示用 hint：仅取 `pinnedCapability.reasoning.defaultEffort`（模型/Provider
 * 默认），**不**冒充 Revision 默认。Revision 默认档位属 Revision 配置面，
 * 不在会话契约里重复导出（契约§11 决策）。
 *
 * 返回 `null` 时表示无 hint 可用——UI 仍展示"跟随 Revision 默认"字样，
 * 不暴露数值。
 */
export function resolveDefaultHint(state: ConversationReasoningState): ReasoningEffort | null {
	return state.pinnedCapability?.reasoning.defaultEffort ?? null;
}

/**
 * 把 hint 渲染为 UI 副本：`null` → "未声明模型默认"，避免静默落到 Provider
 * 端黑盒值；非 `null` 直接透传档位字面量（不做产品翻译）。
 */
export function formatDefaultHint(hint: ReasoningEffort | null): string {
	return hint === null ? "未声明模型默认" : formatReasoningEffort(hint);
}

function isCapabilityBlockingSave(capability: CapabilityState): boolean {
	return capability.kind !== "ready";
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
		const capability = capabilityStateFromReasoning(state.data);
		if (capability.kind !== "ready" || (nextEffort !== null && !capability.configuredEfforts.includes(nextEffort))) {
			setSaveState({
				kind: "error",
				code: capability.kind === "ready" ? "REASONING_INVALID_EFFORT" : "REASONING_NOT_CONFIGURABLE",
				message:
					capability.kind === "ready" ? "所选档位不在该会话固定版本声明的 capability 中。" : capability.message,
				lastEffort: nextEffort,
			});
			return;
		}
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
	}, [api, cid, conversationId, draft, saveGuard, state]);

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
				description="服务端表示此会话没有覆盖，跟随 Revision 默认。"
				compact
			/>
		);
	}

	// loaded 分支：渲染只读事实 + capability 等待契约提示（不暴露档位输入）。
	const currentState = state.data;
	const capability = capabilityStateFromReasoning(currentState);
	const isSaving = saveState.kind === "saving";
	const canClear = !isSaving && draft !== "";
	// 写能力受限：draft === ""（清除覆盖）允许；非空 draft 在 capability
	// 阻塞期间不允许 save。
	const saveBlocked = isCapabilityBlockingSave(capability);
	const canSave = !isSaving && !saveBlocked;
	return (
		<div className="card reasoning-tab">
			<p className="conversation-meta">
				会话 {currentState.conversationId} · 最近覆盖时间 {new Date(currentState.updatedAt).toLocaleString()}
			</p>
			{currentState.effort === null ? (
				(() => {
					const hint = resolveDefaultHint(currentState);
					const hintLabel = formatDefaultHint(hint);
					return (
						<p>
							当前未设置覆盖，<strong>跟随 Revision 默认</strong>
							{hint === null ? null : <>（模型默认：{hintLabel}）</>}
						</p>
					);
				})()
			) : (
				<p>
					当前会话覆盖 effort：<strong>{formatReasoningEffort(currentState.effort)}</strong>
				</p>
			)}

			{capability.kind === "unavailable" && (
				<EmptyState kind="empty" title="此会话不可调整思考强度" description={capability.message} compact />
			)}
			{capability.kind === "ready" && (
				<label htmlFor="reasoning-effort-draft">
					思考强度
					<select
						id="reasoning-effort-draft"
						value={draft}
						onChange={(event) => setDraft(event.currentTarget.value as ReasoningEffort | "")}
						disabled={isSaving}
					>
						<option value="">使用 Agent Revision 默认值</option>
						{capability.configuredEfforts.map((effort) => (
							<option key={effort} value={effort}>
								{formatReasoningEffort(effort)}
							</option>
						))}
					</select>
				</label>
			)}

			<div>
				<button type="button" onClick={onSave} disabled={!canSave}>
					{isSaving ? "保存中…" : saveBlocked ? "档位编辑未开放" : "保存覆盖"}
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
