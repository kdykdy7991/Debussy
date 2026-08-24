/**
 * WB-006 / M1: 会话详情"思考强度"（reasoning）tab（V2-README §4.3）。
 *
 * 调用 `ConversationsApi.getReasoning` / `putReasoning`。
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
 * UI 状态机（与 metrics / context tab 一致，复用 `DataState`）：
 * - `loading`：进入 tab 后立即拉取；
 * - `loaded` + `effort=null`：显示"使用 Agent Revision 默认"；
 * - `loaded` + `effort="..."`：显示当前覆盖 + 清除按钮；
 * - `error`：由 `describeError` 给出 title/description（错误码透传到 `code` 字段，
 *   UI 不做字符串翻译，保持与 metrics 一致）。
 *
 * 不复制 DTO：组件 import `ReasoningUpdateRequest` / `ConversationReasoningState`
 * / `ReasoningEffort` 直接用于 wire 与渲染；`null = 使用 Agent 默认` 文案只是
 * label，不是协议字段。
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

export interface ReasoningTabProps {
	readonly conversationId: string;
	readonly api: ConversationsApi;
}

/** Save 操作的本地状态。`saving` 时禁用输入；失败时 `code` 透传到错误壳。 */
type SaveState =
	| { kind: "idle" }
	| { kind: "saving"; effort: ReasoningEffort | null }
	| { kind: "error"; code: string; message: string; lastEffort: ReasoningEffort | null };

/**
 * 把协议 `ReasoningEffort` union 字面量直接渲染为标签（与 `reasoning-efforts.ts`
 * 6 档透传口径一致）。前端不引入产品语义翻译——`minimal` / `low` / `medium`
 * / `high` / `xhigh` / `max` 都是合法 wire 值。
 */
export function formatReasoningEffort(effort: ReasoningEffort): string {
	return effort;
}

export function ReasoningTab({ conversationId, api }: ReasoningTabProps): React.ReactElement {
	const [state, setState] = useState<DataState<ConversationReasoningState>>({ kind: "idle" });
	const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

	/** 用户正在编辑的 draft effort（未保存）。初始值与已加载状态一致。 */
	const [draft, setDraft] = useState<ReasoningEffort | "">("");

	// 防止过期响应覆盖最新请求结果（与 metrics / context tab 同一模式）。
	const guardRef = useRef<ReturnType<typeof createStaleResponseGuard> | null>(null);
	if (guardRef.current === null) guardRef.current = createStaleResponseGuard();
	const guard = guardRef.current;

	const load = useCallback(() => {
		const cid = asConversationPublicId(conversationId);
		if (cid === null) {
			setState(routeMismatchError(conversationId));
			return;
		}
		const ticket = guard.begin();
		setState({ kind: "loading" });
		api.getReasoning(cid, ticket.signal)
			.then((data) => {
				ticket.commit(() => {
					setState({ kind: "loaded", data });
					setDraft(data.effort ?? "");
				});
			})
			.catch((err: unknown) => {
				if (err instanceof DOMException && err.name === "AbortError") return;
				ticket.commit(() => setState(toDataStateError(err)));
			});
	}, [api, conversationId, guard]);

	useEffect(() => {
		load();
		return () => {
			guard.cancel();
		};
	}, [load, guard]);

	const onRetryLoad = () => load();

	const onSave = useCallback(async () => {
		if (state.kind !== "loaded") return;
		const cid = asConversationPublicId(conversationId);
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
		setSaveState({ kind: "saving", effort: nextEffort });
		const body: ReasoningUpdateRequest = { effort: nextEffort };
		try {
			const updated = await api.putReasoning(cid, body);
			setState({ kind: "loaded", data: updated });
			setDraft(updated.effort ?? "");
			setSaveState({ kind: "idle" });
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return;
			// 错误码透传：`ConversationsApiError.code` 直接来自服务端 envelope；
			// `REASONING_INVALID_EFFORT` / `REASONING_NOT_CONFIGURABLE` 由此到达 UI。
			const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "HTTP_ERROR";
			const message = err instanceof Error ? err.message : String(err);
			setSaveState({ kind: "error", code, message, lastEffort: nextEffort });
		}
	}, [api, conversationId, draft, state.kind]);

	const onClearOverride = useCallback(() => {
		setDraft("");
	}, []);

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
		// reasoning 的事实源对单条会话而言不是"分页空态"——`GET .../reasoning` 永远有
		// `effort` 字段（`null` 也是合法值）。这里只是 DataState 兜底分支，正常不命中。
		return (
			<EmptyState
				kind="empty"
				title="暂无思考强度覆盖"
				description="服务端表示此会话没有覆盖，使用 Agent Revision 默认 effort。"
				compact
			/>
		);
	}
	// loaded 分支：渲染 form
	const current = state.data;
	const isSaving = saveState.kind === "saving";
	return (
		<div className="card reasoning-tab">
			<p className="conversation-meta">
				会话 {current.conversationId} · 最近覆盖时间 {new Date(current.updatedAt).toLocaleString()}
			</p>
			{current.effort === null ? (
				<p>当前未设置覆盖，使用 Agent Revision 默认 effort。</p>
			) : (
				<p>
					当前会话覆盖 effort：<strong>{formatReasoningEffort(current.effort)}</strong>
				</p>
			)}

			<div>
				<label htmlFor="reasoning-effort-draft">覆盖档位（空 = 使用 Agent Revision 默认）</label>
				<input
					id="reasoning-effort-draft"
					type="text"
					value={draft}
					onChange={(e) => setDraft(e.currentTarget.value as ReasoningEffort | "")}
					placeholder="minimal / low / medium / high / xhigh / max"
					disabled={isSaving}
				/>
				<small>前端不做档位翻译：服务端依据模型能力目录校验档位（422 REASONING_INVALID_EFFORT）。</small>
			</div>

			<div>
				<button type="button" onClick={onSave} disabled={isSaving}>
					{isSaving ? "保存中…" : "保存覆盖"}
				</button>
				<button type="button" onClick={onClearOverride} disabled={isSaving || draft === ""}>
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
