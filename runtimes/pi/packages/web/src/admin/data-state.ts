/**
 * 控制台通用数据状态壳（M1-R2）。
 *
 * 这是**生产模块**：仅消费协议包已冻结的 DTO/错误码；不依赖 `fixtures/`。
 * 任何控制台组件、shell、tab 都应 import 自本文件，**禁止**反向依赖 `fixtures/`。
 *
 * `fixtures/index.ts` 是开发期 mock 层，绝不进入生产 bundle（见 fixtures/adapter.ts）。
 */
import { AGENT_V2_METRICS_ERRORS, type AgentV2MetricsErrorCode } from "@earendil-works/pi-protocol";

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
 * 已知错误码（协议冻结）。`UNKNOWN_ERROR` 是前端兜底，非协议码。
 */
export type KnownErrorCode = AgentV2MetricsErrorCode | "UNKNOWN_ERROR";

/**
 * 已知错误码 → HTTP/retryable 映射（直接来自协议）。
 * 未知 code 一律映射为 `UNKNOWN_ERROR`。
 */
export function lookupErrorMetadata(code: string): { retryable: boolean; httpStatus: number | null } {
	if (isKnownErrorCode(code)) {
		return AGENT_V2_METRICS_ERRORS[code];
	}
	return { retryable: false, httpStatus: null };
}

/**
 * 协议错误码类型守卫。未知 code 在调用方应统一映射为 `UNKNOWN_ERROR`。
 */
export function isKnownErrorCode(code: string): code is AgentV2MetricsErrorCode {
	return (
		code === "METRICS_UNAVAILABLE" || code === "CONTEXT_SNAPSHOT_UNAVAILABLE" || code === "INVALID_METRICS_FILTER"
	);
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
			return isKnownErrorCode(raw) ? raw : "UNKNOWN_ERROR";
		}
	}
	return "UNKNOWN_ERROR";
}

function readRetryable(err: unknown, code: KnownErrorCode): boolean {
	if (err && typeof err === "object" && "retryable" in err) {
		const raw = (err as { retryable?: unknown }).retryable;
		if (typeof raw === "boolean") return raw;
	}
	// 协议权威：直接查表，避免重复硬编码。
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
		case "UNKNOWN_ERROR":
			return {
				title: "加载失败",
				description: state.message,
			};
		default:
			// 穷举防御：`isKnownErrorCode` 已限定上面四类，这里不应进入。
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
