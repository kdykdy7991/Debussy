/**
 * 共享 Pi 单次执行与取消入口（R010 第一部分）。
 *
 * 一条执行语义同时服务 Chat、AaaS Run 与 Router Operation：
 *
 *   订阅进度 -> 提交输入 -> 传播取消/执行截止 -> 提取结果与用量
 *
 * 入口只负责「一次执行」的行为，不创建 Conversation、Work Item 或
 * Assignment，也不认识任何业务表；执行归属只由 {@link PiExecutionIdentity}
 * 表达。会话（内存 Pi Session）的打开与关闭仍由调用方决定：
 * Chat/AaaS 复用 RuntimeManager 的既有生命周期，Router Operation 打开一个
 * 只属于该 Operation 的内存会话。
 *
 * 取消语义：
 * - 取消信号先标记「已取消」，再中止底层 Pi，保证「已取消的执行不返回成功」；
 * - 取消或截止到达时，结果为 `cancelled`，并保留取消前已经流出的文本、
 *   thinking 与已确认的用量（不伪造缺失值）。
 */
import type { AssistantTranscriptItem, SessionSnapshot, TranscriptProgress, Usage } from "@earendil-works/pi-protocol";
import type { ConversationId } from "../publishing/domain/ids.ts";
import type { LlmCallTiming, LlmCallTrace, RetrievalInput } from "../types.ts";
import type { ConversationRuntime } from "./conversation-runtime.ts";
import type { RestoredContext } from "./context-restore.ts";

/** Terminal state of a real provider call, derived from the response trace message. */
export type TurnLlmCallStatus = "completed" | "failed" | "aborted" | "unknown";

export interface TurnLlmCallUsage {
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** True only when the provider explicitly reported prompt-cache read tokens (including an explicit 0). */
	readonly cacheReadReported?: boolean;
	readonly totalTokens: number;
	/**
	 * Stable intra-Turn index of the real provider call, allocated by the runtime
	 * at the streamFunction boundary (`CodingAgentPiSessionRuntime.llmCallCounter`)
	 * and shared with the AaaS Trace `callIndex`. Absent when no authoritative
	 * trace was captured for this call (e.g. legacy data or a Chat session
	 * without the trace wrapper) — never inferred from array position.
	 */
	readonly callIndex?: number;
	/** Outcome of the call. "unknown" when only a request boundary was observed. */
	readonly status: TurnLlmCallStatus;
	/**
	 * True only when the provider returned usable token counts for this call.
	 * When false the numeric token fields are placeholders and MUST be rendered
	 * as unknown — never as 0 — and never folded into aggregates.
	 */
	readonly usageReported: boolean;
	/**
	 * Runtime-observed request latency. Absent when no response boundary with
	 * timing was captured; never derived from token counts or wall-clock gaps.
	 */
	readonly timing?: LlmCallTiming;
}

/** All provider-reported LLM calls of one Turn, collected at the model-call completion boundary. */
export interface TurnLlmUsage {
	readonly calls: readonly TurnLlmCallUsage[];
	readonly total: Omit<
		TurnLlmCallUsage,
		"model" | "cacheReadReported" | "callIndex" | "status" | "usageReported" | "timing"
	> & {
		/** True only when every collected call explicitly reported the cache-read fields. */
		readonly cacheReadReported: boolean;
		/** Number of collected calls that explicitly reported the cache-read fields (0..callCount). */
		readonly cacheReadReportedCallCount: number;
	};
	readonly callCount: number;
	/**
	 * Turn-level completeness: true when any real provider call lacks reliable
	 * final usage (regardless of status), not merely when a completed transcript
	 * item had no usage. It says nothing about whether `total` is valid — `total`
	 * always stays the confirmed consumption of the calls that did report.
	 */
	readonly partial: boolean;
}

/** Key shared by the response trace and the `item_finished` transcript item. */
function assistantIdentity(timestamp: number): string {
	return `assistant-${timestamp}`;
}

/** Provider stop reason → per-call terminal status. */
function statusFromMessage(message: { readonly stopReason?: string }): TurnLlmCallStatus {
	switch (message.stopReason) {
		case "stop":
		case "length":
		case "toolUse":
			return "completed";
		case "error":
			return "failed";
		case "aborted":
			return "aborted";
		default:
			return "unknown";
	}
}

interface TraceUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cacheReadReported: boolean;
}

/** A real provider call seen at the streamFunction boundary, keyed by its authoritative callIndex. */
interface TraceCall {
	readonly callIndex: number;
	readonly model: string;
	status: TurnLlmCallStatus;
	usage: TraceUsage | undefined;
	timing: LlmCallTiming | undefined;
}

/**
 * Collect one usage record per real provider call, keyed by the runtime's
 * authoritative `callIndex`. The trace boundary (request/response) is the
 * source of truth for call identity and terminal status: it exists for calls
 * that end in `failed`/`aborted` and would never produce a `complete` assistant
 * transcript item. `item_finished` progress remains the provider-token source
 * for completed calls and is merged by message identity; retries get distinct
 * callIndex values and therefore distinct records, never overwriting each other.
 *
 * Aggregates (`total`, cache coverage) include every call with a reliably
 * reported final usage, independent of its execution status: a failed or
 * aborted call still consumed the tokens the provider measured. Retries are
 * separate callIndex records and are each summed once. Calls without reliable
 * usage are not counted (never as 0) and keep `usageReported:false`. `partial`
 * reports Turn-level completeness independently: any call without reliable
 * usage (completed, failed, aborted or unknown) makes it true. Consumers that
 * need a fully-measured Turn can gate on it, while consumers of confirmed
 * consumption still use `total`.
 */
export function createLlmUsageCollector(): {
	observe(progress: TranscriptProgress): void;
	observeTrace(trace: LlmCallTrace): void;
	result(): TurnLlmUsage | undefined;
} {
	/** Completed-call token facts from progress, keyed by assistant item id (legacy merge path). */
	const completedCalls = new Map<string, TurnLlmCallUsage>();
	/** All real provider calls, keyed by authoritative callIndex. */
	const traceCalls = new Map<number, TraceCall>();
	/** assistant-${timestamp} → callIndex, for merging progress into the trace ledger. */
	const callIndexByIdentity = new Map<string, number>();
	let partial = false;

	const traceUsage = (usage: Usage | undefined): TraceUsage | undefined => {
		if (usage === undefined) return undefined;
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			cacheReadReported: usage.cacheReadReported === true,
		};
	};

	return {
		observe(progress) {
			if (progress.type !== "item_finished") return;
			const item = progress.item;
			if (item.role !== "assistant" || item.status !== "complete") return;
			const completed: AssistantTranscriptItem = item;
			if (completedCalls.has(completed.id)) return;
			const usage = completed.usage;
			if (usage === undefined) {
				partial = true;
				return;
			}
			const callIndex = callIndexByIdentity.get(completed.id);
			completedCalls.set(completed.id, {
				model: completed.responseModel ?? completed.model.id,
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				...(usage.cacheReadReported === true ? { cacheReadReported: true } : {}),
				totalTokens: usage.totalTokens,
				...(callIndex !== undefined ? { callIndex } : {}),
				status: "completed",
				usageReported: true,
			});
		},
		observeTrace(trace) {
			// The proxy emits `request` before the provider call and `response`
			// from `result()` regardless of stop reason (including error/aborted).
			// Both carry the same authoritative callIndex. Storage is keyed by that
			// index, so a retry (new index) is a new record, never an overwrite.
			if (trace.kind === "request") {
				if (!traceCalls.has(trace.callIndex)) {
					traceCalls.set(trace.callIndex, {
						callIndex: trace.callIndex,
						model: `${trace.model.provider}/${trace.model.id}`,
						status: "unknown", // call initiated; outcome not yet observed
						usage: undefined,
						timing: undefined,
					});
				}
				return;
			}
			const message = trace.message;
			callIndexByIdentity.set(assistantIdentity(message.timestamp), trace.callIndex);
			const status = statusFromMessage(message as { readonly stopReason?: string });
			const usage = traceUsage(message.usage);
			const existing = traceCalls.get(trace.callIndex);
			if (existing !== undefined) {
				existing.status = status;
				existing.usage = usage;
				// A response with no timing (e.g. a legacy/injected trace) must not
				// overwrite timing already captured for the same callIndex.
				if (trace.timing !== undefined) existing.timing = trace.timing;
			} else {
				traceCalls.set(trace.callIndex, {
					callIndex: trace.callIndex,
					model: message.responseModel ?? `${trace.model.provider}/${trace.model.id}`,
					status,
					usage,
					timing: trace.timing,
				});
			}
		},
		result() {
			// Merge: the trace ledger owns identity + terminal status. Completed
			// progress calls are merged into it (never duplicated); if a response
			// trace lacked usage but the same AssistantMessage carried provider
			// token facts, adopt those facts so valid usage is never lost.
			const progressByIndex = new Map<number, TurnLlmCallUsage>();
			const values: TurnLlmCallUsage[] = [];
			for (const [id, call] of completedCalls) {
				const callIndex = callIndexByIdentity.get(id);
				if (callIndex !== undefined && traceCalls.has(callIndex)) {
					progressByIndex.set(callIndex, call);
					continue; // represented by the trace-ledger record below
				}
				values.push(call);
			}
			for (const traceCall of [...traceCalls.values()].sort((a, b) => a.callIndex - b.callIndex)) {
				const traceUsageData = traceCall.usage;
				const progress = progressByIndex.get(traceCall.callIndex);
				// Only adopt progress tokens when the trace response did not report
				// usage; a reported zero from the provider is authoritative.
				const usage: TraceUsage | undefined =
					traceUsageData ??
					(progress !== undefined
						? {
								input: progress.input,
								output: progress.output,
								cacheRead: progress.cacheRead,
								cacheWrite: progress.cacheWrite,
								totalTokens: progress.totalTokens,
								cacheReadReported: progress.cacheReadReported === true,
							}
						: undefined);
				values.push({
					model: traceCall.model,
					input: usage?.input ?? 0,
					output: usage?.output ?? 0,
					cacheRead: usage?.cacheRead ?? 0,
					cacheWrite: usage?.cacheWrite ?? 0,
					...(usage?.cacheReadReported === true ? { cacheReadReported: true } : {}),
					totalTokens: usage?.totalTokens ?? 0,
					callIndex: traceCall.callIndex,
					status: traceCall.status,
					usageReported: usage !== undefined,
					...(traceCall.timing !== undefined ? { timing: traceCall.timing } : {}),
				});
			}
			if (values.length === 0 && !partial) return undefined;

			// Confirmed consumption = every call whose provider reported a final usage,
			// regardless of terminal status. Execution status and usage reliability are
			// orthogonal: a failed/aborted call with real usage did consume those tokens.
			// Calls without reliable usage stay out (never coerced to 0); their per-call
			// `usageReported:false` keeps the unknown semantics visible to consumers.
			// Turn completeness is tracked separately in `partial`: ANY unreported call
			// (including a failed/aborted one) makes the Turn incomplete. `total` remains
			// a valid confirmed lower bound either way — do not drop it when `partial` is true.
			const turnPartial = partial || values.some((call) => !call.usageReported);
			const aggregate = values.filter((call) => call.usageReported);
			const cacheReadReportedCallCount = aggregate.filter((call) => call.cacheReadReported === true).length;
			const total = aggregate.reduce(
				(acc, call) => ({
					input: acc.input + call.input,
					output: acc.output + call.output,
					cacheRead: acc.cacheRead + call.cacheRead,
					cacheWrite: acc.cacheWrite + call.cacheWrite,
					totalTokens: acc.totalTokens + call.totalTokens,
				}),
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			);
			return {
				calls: values,
				total: {
					...total,
					cacheReadReported: aggregate.length > 0 && cacheReadReportedCallCount === aggregate.length,
					cacheReadReportedCallCount,
				},
				callCount: values.length,
				partial: turnPartial,
			};
		},
	};
}

/**
 * Bridge the runtime's authoritative call index into the usage collector while
 * preserving the caller's trace callback verbatim (AaaS persists it to the 0030
 * table). The collector observes first so the mapping exists before the
 * matching `item_finished` arrives; a trace-capture failure is already swallowed
 * by the runtime proxy and cannot affect the model result.
 *
 * This always returns a callback — including for Chat, which has no persistence
 * callback. The runtime only allocates a `callIndex` when `onLlmTrace` is set, so
 * supplying a collector-only bridge is what gives Chat calls a stable index too.
 * The bridge observes in memory only; it never persists prompt/response payloads.
 */
function bridgeLlmTrace(
	llmUsage: ReturnType<typeof createLlmUsageCollector>,
	onLlmTrace: ((trace: LlmCallTrace) => Promise<void>) | undefined,
): (trace: LlmCallTrace) => Promise<void> {
	return async (trace) => {
		llmUsage.observeTrace(trace);
		if (onLlmTrace !== undefined) await onLlmTrace(trace);
	};
}

/** 从会话快照提取最后一条 status=complete 的 assistant 文本（拼接 text content）。 */
export function lastAssistantText(snapshot: SessionSnapshot): string {
	return lastAssistantResult(snapshot).outputText;
}

/** Extract final assistant text and provider-reported usage from one snapshot. */
export function lastAssistantResult(snapshot: SessionSnapshot): {
	readonly outputText: string;
	readonly thinkingText?: string;
	readonly usage?: Usage;
} {
	for (let i = snapshot.transcript.length - 1; i >= 0; i -= 1) {
		const item = snapshot.transcript[i];
		if (item === undefined || item.role !== "assistant") continue;
		if (item.status !== "complete") continue;
		return assistantResultFromItem(item);
	}
	return { outputText: "" };
}

/**
 * Extract the LAST assistant item regardless of terminal status (complete,
 * aborted, error, streaming). Used for cancel semantics: an interrupted Turn
 * must keep whatever thinking/text was already streamed to the UI instead of
 * being cleared, while still being a `turn/interrupted` (never a fabricated
 * complete assistant/message).
 */
export function lastAssistantResultAnyStatus(snapshot: SessionSnapshot): {
	readonly outputText: string;
	readonly thinkingText?: string;
	readonly usage?: Usage;
} {
	for (let i = snapshot.transcript.length - 1; i >= 0; i -= 1) {
		const item = snapshot.transcript[i];
		if (item === undefined || item.role !== "assistant") continue;
		return assistantResultFromItem(item);
	}
	return { outputText: "" };
}

function assistantResultFromItem(item: {
	readonly content: readonly AssistantTranscriptItem["content"][number][];
	readonly usage?: Usage;
}): {
	readonly outputText: string;
	readonly thinkingText?: string;
	readonly usage?: Usage;
} {
	const outputText = item.content
		.filter((content) => content.type === "text")
		.map((content) => (content as { type: "text"; text: string }).text)
		.join("\n");
	const thinkingText = item.content
		.filter((content) => content.type === "thinking" && !content.redacted)
		.map((content) => (content as { type: "thinking"; thinking: string }).thinking)
		.join("\n");
	return {
		outputText,
		...(thinkingText ? { thinkingText } : {}),
		...(item.usage ? { usage: item.usage } : {}),
	};
}

/** 一次执行的归属：Chat 会话、AaaS Run（均带 Conversation）或 Router Operation。 */
export type PiExecutionIdentity =
	| { readonly kind: "conversation"; readonly conversationId: ConversationId }
	| { readonly kind: "router_operation"; readonly operationId: string };

/** 一次执行的结构化上下文（冻结的历史与引用检索结果）。 */
export interface PiExecutionContext {
	readonly history?: RestoredContext;
	readonly retrieval?: RetrievalInput;
}

/** 一次执行的输入与回调。 */
export interface PiExecutionRequest {
	readonly identity: PiExecutionIdentity;
	/** 用户输入正文。 */
	readonly input: string;
	readonly context?: PiExecutionContext;
	/** Runtime 的真实结构化增量；调用方必须在 prompt 前完成订阅。 */
	readonly onProgress?: (progress: TranscriptProgress) => void;
	readonly onLlmTrace?: (trace: LlmCallTrace) => Promise<void>;
	/** 取消信号：到达后底层 Pi 被中止，结果为 `cancelled`。 */
	readonly signal?: AbortSignal;
	/** 执行截止（毫秒）。到期按取消处理并中止底层 Pi。 */
	readonly deadlineMs?: number;
}

/** 一次执行的终态结果。 */
export type PiExecutionOutcome =
	| {
			readonly status: "completed";
			readonly outputText: string;
			readonly thinkingText?: string;
			readonly usage?: Usage;
			readonly llmUsage?: TurnLlmUsage;
	  }
	| {
			/** 已取消：既不成功也不失败。 */
			readonly status: "cancelled";
			readonly outputText: string;
			readonly thinkingText?: string;
			readonly usage?: Usage;
			readonly llmUsage?: TurnLlmUsage;
	  }
	| {
			readonly status: "failed";
			readonly error: string;
			/** 失败前已确认的用量；已确认的事实保留，未完成的保持未知。 */
			readonly usage?: Usage;
			readonly llmUsage?: TurnLlmUsage;
	  };

/** 共享执行入口。 */
export interface PiExecutionEntry {
	/**
	 * 在调用方已打开的 Runtime 上执行一次。Runtime 的生命周期（复用、释放、
	 * 关闭）仍归调用方：Chat/AaaS 复用 RuntimeManager，Router Operation 自行
	 * 打开并关闭一个内存会话。
	 */
	execute(runtime: ConversationRuntime, request: PiExecutionRequest): Promise<PiExecutionOutcome>;
	/** 取消一次正在执行的执行；返回是否命中。 */
	cancel(identity: PiExecutionIdentity): Promise<boolean>;
}

interface ActiveExecution {
	readonly runtime: ConversationRuntime;
	readonly controller: AbortController;
	/** 取消先标记再中止，保证「已取消的执行不返回成功」。 */
	cancelled: boolean;
}

/** 归属键：同一归属同一时刻只允许一次执行。 */
function identityKey(identity: PiExecutionIdentity): string {
	return identity.kind === "conversation"
		? `conversation:${identity.conversationId}`
		: `router_operation:${identity.operationId}`;
}

/**
 * 创建共享执行入口。
 *
 * 取消与截止共用一条中止路径：先在活跃表里标记「已取消」，再调用
 * `runtime.abort()`，因此底层 Pi 一定收到中止信号；执行返回时若已被标记，
 * 结果是 `cancelled` 而不是 `completed`。
 */
export function createPiExecutionEntry(): PiExecutionEntry {
	const active = new Map<string, ActiveExecution>();

	const cancelledOutcome = (
		runtime: ConversationRuntime,
		llmUsage: ReturnType<typeof createLlmUsageCollector>,
	): PiExecutionOutcome => {
		// 保留取消前已经流出的文本/thinking 与已确认的用量；不伪造缺失值。
		const partial = lastAssistantResultAnyStatus(runtime.snapshot());
		const collected = llmUsage.result();
		return {
			status: "cancelled",
			outputText: partial.outputText,
			...(partial.thinkingText ? { thinkingText: partial.thinkingText } : {}),
			...(partial.usage ? { usage: partial.usage } : {}),
			...(collected ? { llmUsage: collected } : {}),
		};
	};

	return {
		async execute(runtime, request) {
			if (request.signal?.aborted) return { status: "cancelled", outputText: "" };
			const key = identityKey(request.identity);
			if (active.has(key)) throw new Error(`an execution is already running for ${key}`);
			const controller = new AbortController();
			const execution: ActiveExecution = { runtime, controller, cancelled: false };
			active.set(key, execution);
			const abortRuntime = () => {
				void runtime.abort().catch(() => {});
			};
			const abortExecution = () => controller.abort();
			controller.signal.addEventListener("abort", abortRuntime);
			request.signal?.addEventListener("abort", abortExecution, { once: true });
			let deadline: ReturnType<typeof setTimeout> | undefined;
			if (request.deadlineMs !== undefined && request.deadlineMs > 0) {
				deadline = setTimeout(() => controller.abort(), request.deadlineMs);
				deadline.unref?.();
			}
			const llmUsage = createLlmUsageCollector();
			const unsubscribe = runtime.subscribe((event) => {
				if (event.event.type === "progress") {
					const progress = event.event.progress;
					request.onProgress?.(progress);
					llmUsage.observe(progress);
				}
			});
			try {
				await runtime.prompt(request.input, {
					...(request.context?.history !== undefined ? { history: request.context.history } : {}),
					...(request.context?.retrieval !== undefined ? { retrieval: request.context.retrieval } : {}),
					onLlmTrace: bridgeLlmTrace(llmUsage, request.onLlmTrace),
				});
				if (execution.cancelled || controller.signal.aborted) return cancelledOutcome(runtime, llmUsage);
				const result = lastAssistantResult(runtime.snapshot());
				const collected = llmUsage.result();
				const lastCall = collected?.calls.at(-1);
				if (lastCall?.status === "failed" || lastCall?.status === "aborted") {
					return { status: "failed", error: "模型调用未成功完成", llmUsage: collected };
				}
				return {
					status: "completed",
					outputText: result.outputText,
					...(result.thinkingText ? { thinkingText: result.thinkingText } : {}),
					...(result.usage ? { usage: result.usage } : {}),
					...(collected ? { llmUsage: collected } : {}),
				};
			} catch (error) {
				// 中止也可能以抛错形式出现；它仍然是取消，不是执行失败。
				if (execution.cancelled || controller.signal.aborted) return cancelledOutcome(runtime, llmUsage);
				// Only this execution's collector can confirm usage after a throw:
				// a reused session's last assistant item may belong to an earlier Turn.
				const collected = llmUsage.result();
				return {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
					...(collected ? { llmUsage: collected } : {}),
				};
			} finally {
				unsubscribe();
				if (deadline !== undefined) clearTimeout(deadline);
				controller.signal.removeEventListener("abort", abortRuntime);
				request.signal?.removeEventListener("abort", abortExecution);
				active.delete(key);
			}
		},
		async cancel(identity) {
			const execution = active.get(identityKey(identity));
			if (execution === undefined) return false;
			// 先标记再中止：runtime 可能同步地从中止信号返回。
			execution.cancelled = true;
			execution.controller.abort();
			return true;
		},
	};
}
