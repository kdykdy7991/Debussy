/**
 * M1: 单 typed fixture 适配层（FE-0）。
 *
 * 所有 mock 数据通过这一层进入控制台组件；真实接口接通后整目录删除。
 *
 * 设计要点：
 * - 仅消费协议包已冻结的 DTO 类型；不在本目录复制或发明新类型。
 * - fixture 的"值"只占位枚举/字符串/状态字段，不写伪造的业务数字
 *   （token 数、TTFT、生成耗时等）。真实数字由后端采集口径给定。
 * - 通过 `loadFixture(name)` 进入组件；函数按 `name` 选择 fixture
 *   并返回只读快照；调用方按 `kind` 字段决定如何渲染。
 *
 * 不在本目录范围：发请求、改 AdminAuth 状态、改 React 路由。
 */
import type {
	ContextUsageSnapshot,
	ConversationContextResponse,
	ConversationMetricsResponse,
	ConversationMetricsStats,
} from "@earendil-works/pi-protocol";

/**
 * 通用数据状态：与 `conversation-detail.tsx` 里的 `DetailState` 同型，
 * 供未来提取为统一 status shell 时直接复用。
 */
export type DataState<T> =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "empty"; readonly reason: "no_data_yet" | "legacy_session" }
	| { readonly kind: "partial"; readonly data: T; readonly missing: readonly string[] }
	| { readonly kind: "loaded"; readonly data: T }
	| { readonly kind: "error"; readonly code: string; readonly message: string; readonly retryable: boolean };

/** 已知 fixture 名称（穷举；新增需在此声明）。 */
export type FixtureName =
	| "conversation/metrics/loaded-empty"
	| "conversation/metrics/loaded-with-sample"
	| "conversation/metrics/unavailable"
	| "conversation/metrics/invalid-filter"
	| "conversation/context/loaded-no-snapshot"
	| "conversation/context/loaded-with-snapshot"
	| "conversation/context/legacy-no-snapshot"
	| "conversation/context/unavailable";

/**
 * 单 fixture 条目：与协议 DTO 同型；不引入新字段。
 *
 * `loaded-empty` / `loaded-no-snapshot` 表示"会话存在但暂无数据"——返回的 `data`
 * 仍然是合法 DTO（例如 `stats.available=false`），方便组件走"正常 200 但空"
 * 分支而不是错误分支。
 */
export interface FixtureEntry<T> {
	readonly name: FixtureName;
	readonly data: T;
}

/**
 * 空 stats：会话存在但无指标数据；与 protocol `ConversationMetricsStats` 同型，
 * 不伪造 0。
 */
function emptyStats(): ConversationMetricsStats {
	return {
		available: false,
		turnCount: 0,
		sampleCount: 0,
		ttftMs: { mean: null, count: 0, p50: null, p95: null },
		generationMs: { mean: null, count: 0, p50: null, p95: null },
		totalLatencyMs: { mean: null, count: 0, p50: null, p95: null },
		outputTokensPerSecond: { mean: null, count: 0, p50: null, p95: null },
	};
}

/** fixture 字段只占位枚举/字符串；不写业务数字。 */
function noopMetricsResponse(
	conversationId: ConversationContextResponse["conversationId"],
): ConversationMetricsResponse {
	return {
		conversationId,
		stats: emptyStats(),
		items: [],
		nextAfterSequence: null,
	};
}

/** 完整结构占位（不出数字）：measurement 标 `estimated`，breakdown 各项为 0 视为"未拆分"。 */
function placeholderContextSnapshot(): ContextUsageSnapshot {
	return {
		usedTokens: 0,
		contextWindow: 0,
		remainingTokens: 0,
		reservedOutputTokens: 0,
		usagePercent: 0,
		measurement: "estimated",
		breakdown: {
			systemPrompt: 0,
			skillInstructions: 0,
			toolDefinitions: 0,
			conversationMessages: 0,
			toolResults: 0,
			retrievalContext: 0,
			attachments: 0,
		},
	};
}

/**
 * 集中维护的 fixture 表。新增条目必须在此注册并在 `FixtureName` 中声明；
 * 组件调用 `useFixtureData(name)` 时按表查找。
 *
 * 注：fixture 的 `conversationId` 字段在真实场景由调用方填入；本表只放占位值，
 * 组件拿到 fixture 后立即用真实 conversationId 覆盖。
 */
const METRICS_FIXTURES: Readonly<Record<string, FixtureEntry<ConversationMetricsResponse>>> = {
	"conversation/metrics/loaded-empty": {
		name: "conversation/metrics/loaded-empty",
		data: noopMetricsResponse("conv_placeholder"),
	},
	"conversation/metrics/loaded-with-sample": {
		name: "conversation/metrics/loaded-with-sample",
		data: noopMetricsResponse("conv_placeholder"),
	},
	"conversation/metrics/unavailable": {
		name: "conversation/metrics/unavailable",
		data: noopMetricsResponse("conv_placeholder"),
	},
	"conversation/metrics/invalid-filter": {
		name: "conversation/metrics/invalid-filter",
		data: noopMetricsResponse("conv_placeholder"),
	},
};

const CONTEXT_FIXTURES: Readonly<Record<string, FixtureEntry<ConversationContextResponse>>> = {
	"conversation/context/loaded-no-snapshot": {
		name: "conversation/context/loaded-no-snapshot",
		data: {
			conversationId: "conv_placeholder",
			available: false,
			latest: null,
			atSequence: null,
		},
	},
	"conversation/context/loaded-with-snapshot": {
		name: "conversation/context/loaded-with-snapshot",
		data: {
			conversationId: "conv_placeholder",
			available: true,
			latest: placeholderContextSnapshot(),
			atSequence: null,
		},
	},
	"conversation/context/legacy-no-snapshot": {
		name: "conversation/context/legacy-no-snapshot",
		data: {
			conversationId: "conv_placeholder",
			available: false,
			latest: null,
			atSequence: null,
		},
	},
	"conversation/context/unavailable": {
		name: "conversation/context/unavailable",
		data: {
			conversationId: "conv_placeholder",
			available: false,
			latest: null,
			atSequence: null,
		},
	},
};

/**
 * 单 typed adapter：组件只通过此函数取 fixture，**禁止**绕过本适配层
 * 在组件内硬编码数据。
 *
 * 当前阶段返回 `DataState<T>` 的 `loaded` 分支；真实接入后此函数改为薄包装，
 * 由 API 调用结果直接构造 `DataState<T>`。本函数的语义在两个阶段保持稳定。
 *
 * 注意：本函数不带 `use*` 前缀——它本身不调用任何 React hooks；调用方按
 * 普通同步函数使用。命名区别于 hook，避免误触发 lint 规则。
 */
export function loadFixture<T>(name: FixtureName): DataState<T> {
	if (name in METRICS_FIXTURES) {
		const entry = METRICS_FIXTURES[name]!;
		return { kind: "loaded", data: entry.data as unknown as T };
	}
	if (name in CONTEXT_FIXTURES) {
		const entry = CONTEXT_FIXTURES[name]!;
		return { kind: "loaded", data: entry.data as unknown as T };
	}
	return {
		kind: "error",
		code: "UNKNOWN_FIXTURE",
		message: `Fixture "${name}" is not registered in packages/web/src/admin/fixtures/adapter.ts`,
		retryable: false,
	};
}

/**
 * 把 `DataState<T>` 映射为 UI 友好的错误描述，仅供状态壳使用；
 * 错误码仍以 `code` 字符串透传到调用方。
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
		case "UNKNOWN_FIXTURE":
			return {
				title: "未注册的 fixture",
				description: state.message,
			};
		default:
			return {
				title: "加载失败",
				description: state.message,
			};
	}
}
