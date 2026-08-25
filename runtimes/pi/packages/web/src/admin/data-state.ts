/**
 * 控制台通用数据状态壳（M1-R2）。
 *
 * 这是**生产模块**：仅消费协议包已冻结的 DTO/错误码；不依赖 `fixtures/`。
 * 任何控制台组件、shell、tab 都应 import 自本文件，**禁止**反向依赖 `fixtures/`。
 *
 * `fixtures/index.ts` 是开发期 mock 层，绝不进入生产 bundle（见 fixtures/adapter.ts）。
 */
import {
	AGENT_V2_METRICS_ERROR_CODES,
	AGENT_V2_METRICS_ERRORS,
	AGENT_V2_REASONING_ERROR_CODES,
	AGENT_V2_REASONING_ERRORS,
	type AgentV2MetricsErrorCode,
	type AgentV2ReasoningErrorCode,
} from "@earendil-works/pi-protocol";

/**
 * 通用数据状态：与 `conversation-detail.tsx` 里的 `DetailState` 同型，
 * 供未来提取为统一 status shell 时直接复用。
 *
 * 协议层不规定 `reason` 枚举值；前端内部用 `no_data_yet | legacy_session`
 * 区分"会话尚未产生数据"和"会话在采集开关前已存在"。
 */
export type DataState<T> =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "empty"; readonly reason: "no_data_yet" | "legacy_session" }
	| { readonly kind: "partial"; readonly data: T; readonly missing: readonly string[] }
	| { readonly kind: "loaded"; readonly data: T }
	| {
			readonly kind: "error";
			readonly code: string;
			readonly message: string;
			readonly retryable: boolean;
	  };

/**
 * 已知错误码（metrics + reasoning 协议冻结码 + API 层 transport code +
 * 兜底 `UNKNOWN_ERROR`）。
 *
 * `REQUEST_TIMEOUT` 是 **API 层 transport code**（前端 `ConversationsApi`
 * 30s 超时），非协议码——单独列出是因为它有稳定的语义与文案需求，
 * 不能被 `UNKNOWN_ERROR` 兜底吃掉。`isKnownErrorCode` 守卫仅识别协议
 * 子集，transport code 由 `readCode` 内联识别。
 */
export type KnownErrorCode =
	| AgentV2MetricsErrorCode
	| AgentV2ReasoningErrorCode
	| "REQUEST_TIMEOUT"
	| "UNKNOWN_ERROR";

/**
 * 已知错误码 → HTTP/retryable 映射（metrics + reasoning 联合）。
 *
 * 解析顺序：
 * 1. metrics 表 → `AGENT_V2_METRICS_ERRORS[code]`；
 * 2. reasoning 表 → `AGENT_V2_REASONING_ERRORS[code]`；
 * 3. 都未命中 → 兜底 `{ retryable: false, httpStatus: null }`。
 *
 * 未知 code 一律映射为 `UNKNOWN_ERROR`（由调用方在 `toDataStateError` 内收敛）。
 */
export function lookupErrorMetadata(code: string): { retryable: boolean; httpStatus: number | null } {
	if (isKnownMetricsErrorCode(code)) {
		return AGENT_V2_METRICS_ERRORS[code];
	}
	if (isKnownReasoningErrorCode(code)) {
		return AGENT_V2_REASONING_ERRORS[code];
	}
	return { retryable: false, httpStatus: null };
}

/**
 * 协议错误码类型守卫（metrics 子集）。直接基于协议常量
 * `AGENT_V2_METRICS_ERROR_CODES` 判定，不硬编码字符串。
 */
export function isKnownMetricsErrorCode(code: string): code is AgentV2MetricsErrorCode {
	return (AGENT_V2_METRICS_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * 协议错误码类型守卫（reasoning 子集）。直接基于协议常量
 * `AGENT_V2_REASONING_ERROR_CODES` 判定，不硬编码字符串。
 */
export function isKnownReasoningErrorCode(code: string): code is AgentV2ReasoningErrorCode {
	return (AGENT_V2_REASONING_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * 协议错误码联合守卫（metrics + reasoning）。生产模块的"已知码全集"，
 * **不**允许把上游任意字符串（路径错误、HTTP 兜底消息）当成"已知"。
 *
 * 注意：返回类型是 `KnownErrorCode`（含 `"UNKNOWN_ERROR"` 兜底），
 * 调用方需要进一步 narrow 才能拿到具体协议错误码类型。
 */
export function isKnownErrorCode(code: string): code is Exclude<KnownErrorCode, "UNKNOWN_ERROR"> {
	return isKnownMetricsErrorCode(code) || isKnownReasoningErrorCode(code);
}

/**
 * 把任意错误对象归一化为 `DataState.error`，错误码严格落在协议声明的
 * `AgentV2MetricsErrorCode` 集合内；未知码一律映射为 `UNKNOWN_ERROR`，
 * `retryable` 由协议 `AGENT_V2_METRICS_ERRORS[code].retryable` 决定。
 *
 * 注意：`ConversationsApiError` 已经在 API 层按协议填充 `retryable`，
 * 本函数优先采用 `error.retryable`；HTTP status 也透传。
 */
export interface SourceError {
	readonly code?: string | null;
	readonly message?: string;
	readonly retryable?: boolean;
	readonly httpStatus?: number;
}

export function toDataStateError(err: SourceError | Error | unknown): Extract<DataState<never>, { kind: "error" }> {
	const code = readCode(err);
	const retryable = readRetryable(err, code);
	const message = readMessage(err, code);
	return { kind: "error", code, message, retryable };
}

function readCode(err: unknown): KnownErrorCode {
	if (err && typeof err === "object" && "code" in err) {
		const raw = (err as { code?: unknown }).code;
		if (typeof raw === "string" && raw.length > 0) {
			// 把"已知协议码"（metrics 或 reasoning 子集）保留为字面量；
			// transport code（`REQUEST_TIMEOUT`）也保留；其它字符串（HTTP 兜底
			// 消息、未知上游代码）一律收敛为 `UNKNOWN_ERROR`。
			if (isKnownErrorCode(raw)) return raw;
			if (raw === "REQUEST_TIMEOUT") return "REQUEST_TIMEOUT";
			return "UNKNOWN_ERROR";
		}
	}
	return "UNKNOWN_ERROR";
}

function readRetryable(err: unknown, code: KnownErrorCode): boolean {
	// 协议已知码（metrics 或 reasoning 子集）→ 以各自的协议表为权威，
	// **不**允许传入错误的 `retryable` 覆盖（防止任意上游把已知协议码标记为
	// "不重试"导致 UI 行为漂移）。未知码才退回到传入值兜底
	// （HTTP 状态推断留给 API 层做）。
	if (isKnownMetricsErrorCode(code)) {
		return AGENT_V2_METRICS_ERRORS[code].retryable;
	}
	if (isKnownReasoningErrorCode(code)) {
		return AGENT_V2_REASONING_ERRORS[code].retryable;
	}
	// API 层 transport code（REQUEST_TIMEOUT）→ 可重试，由 UI 引导手动重试。
	if (code === "REQUEST_TIMEOUT") return true;
	if (err && typeof err === "object" && "retryable" in err) {
		const raw = (err as { retryable?: unknown }).retryable;
		if (typeof raw === "boolean") return raw;
	}
	return lookupErrorMetadata(code).retryable;
}

function readMessage(err: unknown, code: KnownErrorCode): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object" && "message" in err) {
		const raw = (err as { message?: unknown }).message;
		if (typeof raw === "string" && raw.length > 0) return raw;
	}
	return code === "UNKNOWN_ERROR" ? "未知错误" : code;
}

/**
 * 把 `DataState.error` 映射为 UI 友好的错误描述（仅供状态壳使用）；
 * 错误码仍以 `code` 字符串透传到调用方。
 *
 * 文案是 UI 副本；翻译 / 后续国际化由消费方接管。
 */
export function describeError(state: Extract<DataState<unknown>, { kind: "error" }>): {
	readonly title: string;
	readonly description: string;
} {
	switch (state.code) {
		case "METRICS_UNAVAILABLE":
		case "CONTEXT_SNAPSHOT_UNAVAILABLE":
			return {
				title: "指标服务暂不可用",
				description: "后端采集暂不可用，请稍后重试。",
			};
		case "INVALID_METRICS_FILTER":
			return {
				title: "查询参数无效",
				description: "分页参数 `afterSequence` / `limit` 必须为正整数；请调整后重试。",
			};
		case "REASONING_INVALID_EFFORT":
			// 422：档位不在当前模型能力目录声明档位内；前端不做翻译，把档位
			// 字面量留给调用方（reasoning tab 的 `formatReasoningEffort`）。
			return {
				title: "thinking effort 档位被拒绝",
				description:
					"当前模型能力目录不接受该档位；UI 仅展示模型声明的档位，出现此错误通常是会话被切换到另一个 Agent。",
			};
		case "REASONING_NOT_CONFIGURABLE":
			// 403：会话属主合法，但策略禁止调整该会话思考强度。
			return {
				title: "策略禁止调整 thinking effort",
				description: "该会话受租户/企业策略限制，不可调整；请联系策略管理员。",
			};
		case "REQUEST_TIMEOUT":
			// API 层 transport code：30s 超时（与 stale guard 取消信号正交）。
			// PUT 幂等，重试安全；UI 引导用户手动重试。
			return {
				title: "请求超时",
				description: "reasoning 请求在 30 秒内未收到响应，请手动重试（PUT 幂等，重试安全）。",
			};
		case "UNKNOWN_ERROR":
			return {
				title: "加载失败",
				description: state.message,
			};
		default:
			// 穷举防御：`KnownErrorCode` 已限定上面五类，这里不应进入。
			return {
				title: "加载失败",
				description: state.message,
			};
	}
}

/**
 * 防止过期响应覆盖最新请求结果的小型协调器（无 React 依赖，可在 node 单测）。
 *
 * 用法（组件内）：
 * ```ts
 * const guardRef = useRef<StaleResponseGuard | null>(null);
 * if (guardRef.current === null) guardRef.current = createStaleResponseGuard();
 * const guard = guardRef.current;
 * const load = () => {
 *   const ticket = guard.begin();
 *   api.get(..., ticket.signal).then(
 *     (data) => ticket.commit(() => setState({ kind: "loaded", data })),
 *     (err)  => ticket.commit(() => setState(mapErrorToDataState(err))),
 *   );
 * };
 * useEffect(() => {
 *   load();
 *   return () => guard.cancel();
 * }, [...]);
 * ```
 *
 * `begin()` 每次调用：
 * - `++` 内部 `latest` 代号；
 * - 取消之前活动的 `AbortController`；
 * - 创建一个新的 `AbortController` 并把它装入 `current`；
 * - 返回 `{ generation, signal, commit, abort }`。
 *
 * `commit(updater)`：仅当 ticket 仍最新且 signal 未 abort 时才执行 `updater`，
 * 避免过期响应写 state。
 *
 * `cancel()`：取消当前未完成请求（effect 卸载 / 依赖变化时调用）。
 */
export interface StaleResponseTicket {
	readonly generation: number;
	readonly signal: AbortSignal;
	/**
	 * 仅当 ticket 仍最新且 signal 未 abort 时执行 `updater`。
	 * `updater` 一般是 `() => setState(...)`；不依赖 React 类型。
	 */
	commit(updater: () => void): void;
	/** 主动 abort（场景：新请求发起前、组件卸载）。 */
	abort(): void;
}

export interface StaleResponseGuard {
	begin(): StaleResponseTicket;
	cancel(): void;
	/** 仅用于测试/调试：当前活动代号。 */
	readonly latest: number;
}

export function createStaleResponseGuard(): StaleResponseGuard {
	let latest = 0;
	let current: { readonly controller: AbortController; readonly generation: number } | null = null;
	return {
		get latest() {
			return latest;
		},
		begin() {
			latest += 1;
			const generation = latest;
			current?.controller.abort();
			const controller = new AbortController();
			current = { controller, generation };
			return {
				generation,
				signal: controller.signal,
				commit(updater) {
					if (current === null) return;
					if (current.generation !== generation) return;
					if (controller.signal.aborted) return;
					updater();
				},
				abort() {
					controller.abort();
				},
			};
		},
		cancel() {
			current?.controller.abort();
			current = null;
		},
	};
}
