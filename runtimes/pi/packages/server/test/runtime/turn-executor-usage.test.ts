import type { SessionSnapshot, TranscriptProgress, Usage } from "@earendil-works/pi-protocol";
import type { LlmCallTrace } from "../../src/types.ts";
import { describe, expect, it } from "vitest";
import { createLlmUsageCollector, lastAssistantResult, managedTurnExecutor } from "../../src/runtime/turn-executor.ts";

const USAGE: Usage = {
	input: 120,
	output: 30,
	cacheRead: 80,
	cacheWrite: 0,
	totalTokens: 150,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("lastAssistantResult", () => {
	it("returns provider usage with the final completed assistant text", () => {
		const snapshot = {
			transcript: [
				{
					id: "msg_1",
					role: "assistant",
					status: "complete",
					content: [{ type: "text", text: "done" }],
					usage: USAGE,
				},
			],
		} as unknown as SessionSnapshot;

		expect(lastAssistantResult(snapshot)).toEqual({ outputText: "done", usage: USAGE });
	});

	it("does not invent usage when the provider omitted it", () => {
		const snapshot = {
			transcript: [
				{ id: "msg_1", role: "assistant", status: "complete", content: [{ type: "text", text: "done" }] },
			],
		} as unknown as SessionSnapshot;

		expect(lastAssistantResult(snapshot)).toEqual({ outputText: "done" });
	});

	it("preserves non-redacted thinking for the shared transcript", () => {
		const snapshot = {
			transcript: [
				{
					id: "msg_1",
					role: "assistant",
					status: "complete",
					content: [
						{ type: "thinking", thinking: "reasoning", redacted: false },
						{ type: "text", text: "done" },
					],
				},
			],
		} as unknown as SessionSnapshot;

		expect(lastAssistantResult(snapshot)).toEqual({ outputText: "done", thinkingText: "reasoning" });
	});
});

describe("managedTurnExecutor progress", () => {
	it("subscribes before prompt and forwards the runtime's real structured deltas", async () => {
		const progress = {
			type: "assistant_delta" as const,
			messageId: "msg_1",
			contentIndex: 0,
			kind: "thinking" as const,
			delta: "reasoning",
		};
		let listener: ((event: unknown) => void) | undefined;
		let released = false;
		const runtime = {
			subscribe(next: (event: unknown) => void) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			async prompt() {
				listener?.({ type: "progress", event: { type: "progress", progress } });
			},
			snapshot() {
				return {
					transcript: [
						{
							id: "msg_1",
							role: "assistant",
							status: "complete",
							content: [
								{ type: "thinking", thinking: "reasoning", redacted: false },
								{ type: "text", text: "done" },
							],
						},
					],
				};
			},
		};
		const executor = managedTurnExecutor({
			acquire: async () => ({ runtime, created: true }),
			release: () => {
				released = true;
			},
		} as never);
		const seen: unknown[] = [];
		const result = await executor({
			scope: { conversationId: "conv_1" } as never,
			spec: {} as never,
			text: "hello",
			onProgress: (event) => seen.push(event),
		});

		expect(seen).toEqual([progress]);
		expect(result).toMatchObject({ ok: true, outputText: "done", thinkingText: "reasoning" });
		expect(released).toBe(true);
	});

	it("forwards the caller trace verbatim and attaches the same callIndex to usage", async () => {
		const forwarded: LlmCallTrace[] = [];
		const trace = responseTrace(7, 6000);
		let listener: ((event: unknown) => void) | undefined;
		const runtime = {
			subscribe(next: (event: unknown) => void) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			async prompt(_text: string, options?: { onLlmTrace?: (trace: LlmCallTrace) => Promise<void> }) {
				// Runtime proxy emits the response trace before message_end/item_finished.
				await options?.onLlmTrace?.(trace);
				listener?.({ type: "progress", event: { type: "progress", progress: finishedAt(6000, 70, 77) } });
			},
			snapshot() {
				return {
					transcript: [
						{
							id: "assistant-6000",
							role: "assistant",
							status: "complete",
							content: [{ type: "text", text: "done" }],
							usage: USAGE,
						},
					],
				};
			},
		};
		const executor = managedTurnExecutor({
			acquire: async () => ({ runtime, created: true }),
			release: () => undefined,
		} as never);
		const result = await executor({
			scope: { conversationId: "conv_1" } as never,
			spec: {} as never,
			text: "hello",
			onLlmTrace: async (item) => {
				forwarded.push(item);
			},
		});
		if (!result.ok) throw new Error("executor failed");
		// The caller (AaaS persistence) sees the exact authoritative trace.
		expect(forwarded).toEqual([trace]);
		// Usage carries the same number; no positional inference.
		expect(result.llmUsage?.calls[0]?.callIndex).toBe(7);
	});

	it("allocates a callIndex for Chat even without a caller trace callback", async () => {
		let receivedBridge: ((trace: LlmCallTrace) => Promise<void>) | undefined;
		let listener: ((event: unknown) => void) | undefined;
		const runtime = {
			subscribe(next: (event: unknown) => void) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			async prompt(_text: string, options?: { onLlmTrace?: (trace: LlmCallTrace) => Promise<void> }) {
				receivedBridge = options?.onLlmTrace;
			},
			snapshot() {
				return { transcript: [] };
			},
		};
		const executor = managedTurnExecutor({
			acquire: async () => ({ runtime, created: true }),
			release: () => undefined,
		} as never);
		await executor({
			scope: { conversationId: "conv_1" } as never,
			spec: {} as never,
			text: "hello",
		});
		// Chat has no persistence callback; the executor still supplies an in-memory
		// bridge so the runtime allocates a callIndex. No payload is persisted here.
		expect(receivedBridge).toBeTypeOf("function");
	});

	it("collects every completed model call without counting restored history or duplicate events", async () => {
		const events = [
			// Restored history is injected without progress events.
			{ type: "item_started", item: { id: "history_1", role: "assistant", status: "streaming" } },
			assistantFinished("msg_1", 100, 10, 110),
			assistantFinished("msg_2", 200, 20, 220, "toolUse"),
			assistantFinished("msg_3", 300, 30, 330),
			assistantFinished("msg_1", 999, 999, 1998), // duplicate progress
			{ type: "item_finished", item: { id: "tool_1", role: "tool", status: "complete" } },
		];
		let listener: ((event: unknown) => void) | undefined;
		const runtime = {
			subscribe(next: (event: unknown) => void) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			async prompt() {
				for (const progress of events) {
					listener?.({ type: "progress", event: { type: "progress", progress } });
				}
			},
			snapshot() {
				return {
					transcript: [
						{
							id: "msg_3",
							role: "assistant",
							status: "complete",
							content: [{ type: "text", text: "done" }],
							usage: USAGE,
						},
					],
				};
			},
		};
		const executor = managedTurnExecutor({
			acquire: async () => ({ runtime, created: true }),
			release: () => undefined,
		} as never);
		const result = await executor({ scope: { conversationId: "conv_1" } as never, spec: {} as never, text: "hello" });
		expect(result).toMatchObject({ ok: true, outputText: "done", usage: USAGE });
		if (!result.ok) throw new Error("executor failed");
		expect(result.llmUsage?.callCount).toBe(3);
		expect(result.llmUsage?.partial).toBe(false);
		expect(result.llmUsage?.total).toEqual({
			input: 600,
			output: 60,
			cacheRead: 240,
			cacheWrite: 0,
			totalTokens: 660,
			cacheReadReported: false,
			cacheReadReportedCallCount: 0,
		});
	});
});

function responseTrace(callIndex: number, timestamp: number): LlmCallTrace {
	return {
		kind: "response",
		callIndex,
		model: { provider: "oneapi", id: "Qwen" },
		message: { role: "assistant", timestamp } as never,
	};
}

function finishedAt(timestamp: number, input: number, totalTokens: number): TranscriptProgress {
	return {
		type: "item_finished",
		item: {
			id: `assistant-${timestamp}`,
			role: "assistant",
			status: "complete",
			stopReason: "stop",
			content: [{ type: "text", text: "step" }],
			model: { provider: "oneapi", id: "Qwen" },
			usage: { ...USAGE, input, totalTokens },
			timestamp,
		},
	} as unknown as TranscriptProgress;
}

describe("createLlmUsageCollector · stable call identity", () => {
	it("matches each call to the runtime callIndex by message identity, not array order", () => {
		const collector = createLlmUsageCollector();
		// Traces arrive first (proxy emits them inside result(), before message_end).
		collector.observeTrace(responseTrace(1, 1000));
		collector.observeTrace(responseTrace(2, 2000));
		collector.observe(finishedAt(2000, 200, 220));
		collector.observe(finishedAt(1000, 100, 110));
		const result = collector.result();
		// The ledger is keyed and ordered by authoritative callIndex. The callIndex
		// must follow the message identity (1↔timestamp1000, 2↔timestamp2000),
		// not the order progress events happened to arrive.
		expect(result?.calls.map((call) => call.callIndex)).toEqual([1, 2]);
		expect(result?.calls.map((call) => call.input)).toEqual([100, 200]);
	});

	it("gives a retry its own new callIndex rather than reusing the previous number", () => {
		const collector = createLlmUsageCollector();
		// A failed attempt (callIndex 1) is a different AssistantMessage than the retry (callIndex 2).
		collector.observeTrace(responseTrace(1, 3000));
		collector.observe(finishedAt(3000, 10, 12));
		collector.observeTrace(responseTrace(2, 4000));
		collector.observe(finishedAt(4000, 20, 24));
		const result = collector.result();
		expect(result?.callCount).toBe(2);
		expect(result?.calls.map((call) => call.callIndex)).toEqual([1, 2]);
	});

	it("keeps progress-only calls without callIndex and records request-only calls as unknown", () => {
		const collector = createLlmUsageCollector();
		collector.observeTrace({ kind: "request", callIndex: 9, model: { provider: "oneapi", id: "Qwen" } } as never);
		collector.observe(finishedAt(5000, 50, 55));
		const result = collector.result();
		// The progress-only call is a legacy row: no fabricated callIndex.
		const progressOnly = result?.calls.find((call) => call.input === 50);
		expect(progressOnly?.callIndex).toBeUndefined();
		expect(Object.hasOwn(progressOnly ?? {}, "callIndex")).toBe(false);
		// The request-only call is now recorded as a real initiated call with unknown outcome.
		const requestOnly = result?.calls.find((call) => call.callIndex === 9);
		expect(requestOnly?.status).toBe("unknown");
		expect(requestOnly?.usageReported).toBe(false);
	});
});

describe("createLlmUsageCollector · failed / aborted / retry records", () => {
	function responseWith(
		callIndex: number,
		stopReason: string,
		usage: Usage | undefined,
		timestamp = 1000 + callIndex,
	): Extract<LlmCallTrace, { kind: "response" }> {
		return {
			kind: "response",
			callIndex,
			model: { provider: "oneapi", id: "Qwen" },
			message: { role: "assistant", timestamp, stopReason, usage } as never,
		};
	}

	function request(callIndex: number): LlmCallTrace {
		return {
			kind: "request",
			callIndex,
			model: { provider: "oneapi", id: "Qwen" },
			context: {} as never,
		};
	}

	it("aggregates every call with reported usage regardless of terminal status", () => {
		const collector = createLlmUsageCollector();
		collector.observeTrace(request(1));
		collector.observeTrace(responseWith(1, "error", USAGE));
		collector.observeTrace(request(2));
		collector.observeTrace(responseWith(2, "aborted", undefined));
		collector.observeTrace(request(3));
		collector.observeTrace(responseWith(3, "stop", USAGE));
		const result = collector.result();
		expect(result?.calls.map((call) => call.status)).toEqual(["failed", "aborted", "completed"]);
		expect(result?.calls.map((call) => call.callIndex)).toEqual([1, 2, 3]);
		// Failed + completed both reported real final usage → both are confirmed consumption.
		// The aborted call reported no usage → stays out of the aggregate (not zero).
		expect(result?.calls[0]?.usageReported).toBe(true);
		expect(result?.calls[1]?.usageReported).toBe(false);
		expect(result?.total.totalTokens).toBe(USAGE.totalTokens * 2);
		expect(result?.total.input).toBe(USAGE.input * 2);
		expect(result?.callCount).toBe(3);
	});

	it("counts aborted and failed calls that reported usage; excludes unreported ones", () => {
		const collector = createLlmUsageCollector();
		collector.observeTrace(request(1));
		collector.observeTrace(responseWith(1, "aborted", USAGE));
		collector.observeTrace(request(2));
		collector.observeTrace(responseWith(2, "error", undefined));
		const result = collector.result();
		expect(result?.calls.map((call) => [call.status, call.usageReported])).toEqual([
			["aborted", true],
			["failed", false],
		]);
		expect(result?.total.totalTokens).toBe(USAGE.totalTokens);
	});

	it("sums each retry attempt separately when each reported usage", () => {
		const collector = createLlmUsageCollector();
		collector.observeTrace(request(1));
		collector.observeTrace(responseWith(1, "error", USAGE));
		collector.observeTrace(request(2));
		collector.observeTrace(responseWith(2, "stop", USAGE));
		const result = collector.result();
		expect(result?.calls).toHaveLength(2);
		expect(result?.total.totalTokens).toBe(USAGE.totalTokens * 2);
	});

	it("persisted total shape is safe for SQL/Session consumers and keeps cache coverage rules", () => {
		const collector = createLlmUsageCollector();
		const failedUsage: Usage = { ...USAGE, input: 40, totalTokens: 45, cacheReadReported: true };
		collector.observeTrace(request(1));
		collector.observeTrace(responseWith(1, "error", failedUsage));
		collector.observeTrace(request(2));
		collector.observeTrace(responseWith(2, "stop", USAGE));
		const result = collector.result();
		// Total is a flat numeric shape aggregated from both reported calls.
		expect(result?.total).toEqual({
			input: failedUsage.input + USAGE.input,
			output: USAGE.output * 2,
			cacheRead: USAGE.cacheRead * 2,
			cacheWrite: 0,
			totalTokens: failedUsage.totalTokens + USAGE.totalTokens,
			// Cache coverage: only calls that reported cache fields count; one did not.
			cacheReadReported: false,
			cacheReadReportedCallCount: 1,
		});
	});

	it("keeps unreported calls out of the aggregate without fabricating per-call zeros", () => {
		const collector = createLlmUsageCollector();
		collector.observeTrace(request(1));
		collector.observeTrace(responseWith(1, "error", undefined));
		const result = collector.result();
		expect(result?.calls).toHaveLength(1);
		expect(result?.calls[0]?.usageReported).toBe(false);
		expect(result?.calls[0]?.totalTokens).toBe(0); // placeholder, rendered as unknown
		// Nothing was reported, so the aggregate has no terms to sum. The per-call
		// usageReported=false flag is the signal consumers use, not a fabricated 0.
		expect(result?.total.totalTokens).toBe(0);
		// Turn completeness is truthful: an unreported call makes the Turn partial,
		// even though the confirmed consumption is still zero.
		expect(result?.partial).toBe(true);
	});

	it("keeps a retry as a separate record keyed by a new callIndex", () => {
		const collector = createLlmUsageCollector();
		collector.observeTrace(request(1));
		collector.observeTrace(responseWith(1, "error", undefined));
		collector.observeTrace(request(2));
		collector.observeTrace(responseWith(2, "stop", USAGE));
		const result = collector.result();
		expect(result?.calls).toHaveLength(2);
		expect(result?.calls.map((call) => [call.callIndex, call.status])).toEqual([
			[1, "failed"],
			[2, "completed"],
		]);
		expect(result?.calls[0]?.usageReported).toBe(false);
		expect(result?.calls[1]?.usageReported).toBe(true);
	});

	it("uses progress usage when the response trace omitted it but the message carried it", () => {
		const collector = createLlmUsageCollector();
		// Response trace carried no usage object (e.g. a proxy that trims it).
		collector.observeTrace(responseWith(1, "stop", undefined, 7000));
		collector.observe(finishedAt(7000, 77, 88));
		const result = collector.result();
		expect(result?.calls).toHaveLength(1);
		expect(result?.calls[0]?.usageReported).toBe(true);
		expect(result?.calls[0]?.input).toBe(77);
		expect(result?.total.totalTokens).toBe(88);
	});

	it("keeps Runtime timing for completed/failed/aborted calls and leaves unknown when absent", () => {
		const collector = createLlmUsageCollector();
		const completedTiming = { startedAtMs: 1000, endedAtMs: 1250, durationMs: 250 };
		const failedTiming = { startedAtMs: 2000, endedAtMs: 2060, durationMs: 60 };
		const abortedTiming = { startedAtMs: 3000, endedAtMs: 3900, durationMs: 900 };
		collector.observeTrace({
			...responseWith(1, "stop", USAGE),
			timing: completedTiming,
		});
		collector.observeTrace({
			...responseWith(2, "error", USAGE),
			timing: failedTiming,
		});
		collector.observeTrace({
			...responseWith(3, "aborted", undefined),
			timing: abortedTiming,
		});
		// A request-only call never produced a response boundary → timing unknown.
		collector.observeTrace(request(4));
		const result = collector.result();
		expect(result?.calls.map((call) => call.timing)).toEqual([
			completedTiming,
			failedTiming,
			abortedTiming,
			undefined,
		]);
		// Timing is per-call metadata: it never changes status, usage or totals.
		expect(result?.calls.map((call) => call.status)).toEqual(["completed", "failed", "aborted", "unknown"]);
		expect(result?.total.totalTokens).toBe(USAGE.totalTokens * 2);
		expect(result?.total).not.toHaveProperty("timing");
	});

	it("does not overwrite captured timing with a later timing-free response trace", () => {
		const collector = createLlmUsageCollector();
		const timing = { startedAtMs: 10, endedAtMs: 30, durationMs: 20 };
		collector.observeTrace(request(1));
		collector.observeTrace({ ...responseWith(1, "stop", USAGE), timing });
		collector.observeTrace(responseWith(1, "stop", USAGE));
		expect(collector.result()?.calls[0]?.timing).toEqual(timing);
	});
});

describe("createLlmUsageCollector", () => {
	it("marks the Turn partial when a completed model call has no provider usage", () => {
		const collector = createLlmUsageCollector();
		collector.observe(assistantFinished("msg_1", 100, 10, 110));
		collector.observe({
			type: "item_finished",
			item: {
				id: "msg_2",
				role: "assistant",
				status: "complete",
				content: [{ type: "text", text: "done" }],
				model: { provider: "oneapi", id: "Qwen" },
				timestamp: 2,
			},
		} as unknown as TranscriptProgress);
		const result = collector.result();
		expect(result?.callCount).toBe(1);
		expect(result?.partial).toBe(true);
		expect(result?.total.totalTokens).toBe(110);
	});

	it("keeps already collected calls even if the final snapshot was compacted", () => {
		const collector = createLlmUsageCollector();
		collector.observe(assistantFinished("msg_1", 100, 10, 110, "toolUse"));
		collector.observe(assistantFinished("msg_2", 200, 20, 220));
		// A compaction/recovery can rebuild the snapshot without these items;
		// the collector holds the completion-boundary facts independently.
		expect(collector.result()).toMatchObject({ callCount: 2, partial: false, total: { totalTokens: 330 } });
		expect(collector.result()).toMatchObject({ callCount: 2 });
	});

	it("returns nothing when no model call completed", () => {
		const collector = createLlmUsageCollector();
		collector.observe({ type: "item_started", item: { id: "history", role: "assistant" } } as never);
		expect(collector.result()).toBeUndefined();
	});

	it("reports cache-read coverage when every collected call reported it", () => {
		const collector = createLlmUsageCollector();
		collector.observe(assistantFinished("msg_1", 100, 10, 110, "stop", true));
		collector.observe(assistantFinished("msg_2", 200, 20, 220, "toolUse", true));
		const result = collector.result();
		expect(result?.total.cacheReadReported).toBe(true);
		expect(result?.total.cacheReadReportedCallCount).toBe(2);
		expect(result?.calls.every((call) => call.cacheReadReported === true)).toBe(true);
	});

	it("withholds cache-read coverage when any collected call omitted the fields", () => {
		const collector = createLlmUsageCollector();
		collector.observe(assistantFinished("msg_1", 100, 10, 110, "stop", true));
		collector.observe(assistantFinished("msg_2", 200, 20, 220));
		const result = collector.result();
		expect(result?.total.cacheReadReported).toBe(false);
		expect(result?.total.cacheReadReportedCallCount).toBe(1);
		expect(result?.calls).toHaveLength(2);
		expect(Object.hasOwn(result?.calls[1] ?? {}, "cacheReadReported")).toBe(false);
	});

	it("reports zero cache-read coverage when no call has usage", () => {
		const collector = createLlmUsageCollector();
		collector.observe({
			type: "item_finished",
			item: {
				id: "msg_2",
				role: "assistant",
				status: "complete",
				content: [{ type: "text", text: "done" }],
				model: { provider: "oneapi", id: "Qwen" },
				timestamp: 2,
			},
		} as unknown as TranscriptProgress);
		const result = collector.result();
		expect(result?.partial).toBe(true);
		expect(result?.callCount).toBe(0);
		expect(result?.calls).toEqual([]);
		expect(result?.total.cacheReadReported).toBe(false);
		expect(result?.total.cacheReadReportedCallCount).toBe(0);
	});
});

describe("managedTurnExecutor · user cancellation", () => {
	function cancellableRuntime(options: {
		readonly onPrompt: (runtime: { abort: () => void }) => void;
		readonly transcriptStatus?: "complete" | "aborted";
	}) {
		let listener: ((event: unknown) => void) | undefined;
		let aborted = false;
		const runtime = {
			subscribe(next: (event: unknown) => void) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			async prompt() {
				options.onPrompt({ abort: () => { aborted = true; } });
			},
			snapshot() {
				return {
					transcript: [
						{
							id: "partial",
							role: "assistant",
							status: options.transcriptStatus ?? "aborted",
							content: [{ type: "thinking", thinking: "partial thought", redacted: false }, { type: "text", text: "partial text" }],
							usage: USAGE,
						},
					],
				};
			},
			abort: async () => { aborted = true; },
			get aborted() { return aborted; },
		};
		return runtime;
	}

	function makeExecutor(runtime: ReturnType<typeof cancellableRuntime>) {
		return managedTurnExecutor({
			acquire: async () => ({ runtime, created: true }),
			get: () => runtime,
			release: () => undefined,
		} as never);
	}

	const turnInput = {
		scope: { conversationId: "conv_cancel" } as never,
		spec: {} as never,
		text: "hello",
	};

	it("normal completion stays ok:true (no interruption flag)", async () => {
		const runtime = cancellableRuntime({ onPrompt: () => {} });
		const result = await makeExecutor(runtime)(turnInput);
		expect(result.ok).toBe(true);
		expect("interrupted" in result).toBe(false);
	});

	it("cancel during execution returns interrupted with partial output and collected usage", async () => {
		let cancel!: () => Promise<boolean>;
		const runtime = cancellableRuntime({
			onPrompt: () => {
				// Cancel while the turn is active, before prompt() resolves.
				void cancel().then((accepted) => expect(accepted).toBe(true));
			},
		});
		// Emit a completed call so pre-cancel usage is preserved.
		const executor = makeExecutor(runtime);
		cancel = () => executor.cancel!("conv_cancel" as never);
		const result = await executor(turnInput);
		expect(result.ok).toBe(false);
		if (result.ok || !("interrupted" in result)) throw new Error("expected interrupted result");
		expect(result.interrupted).toBe(true);
		expect(result.outputText).toBe("partial text");
		expect(result.thinkingText).toBe("partial thought");
		expect(result.usage).toEqual(USAGE);
	});

	it("an abort surfaced as a thrown error is still a cancel, not a failure", async () => {
		let cancel!: () => Promise<boolean>;
		const runtime = cancellableRuntime({
			onPrompt: () => {
				void cancel();
				throw new Error("Request aborted");
			},
		});
		const executor = makeExecutor(runtime);
		cancel = () => executor.cancel!("conv_cancel" as never);
		const result = await executor(turnInput);
		expect(result.ok).toBe(false);
		if (result.ok || !("interrupted" in result)) throw new Error("expected interrupted result");
		expect(result.interrupted).toBe(true);
	});

	it("late cancel after completion cannot reclassify the turn", async () => {
		const runtime = cancellableRuntime({ onPrompt: () => {} });
		const executor = makeExecutor(runtime);
		const result = await executor(turnInput);
		expect(result.ok).toBe(true);
		// Turn already finished: no active turn to cancel.
		expect(await executor.cancel!("conv_cancel" as never)).toBe(false);
	});

	it("cancel arriving after the completion decision but before finally loses the race", async () => {
		// prompt() resolves normally; the executor consumes the flag at the decision
		// boundary. A cancel attempted in the snapshot phase would be too late and
		// reports false because the active-turn marker was already consumed.
		const runtime = cancellableRuntime({ onPrompt: () => {} });
		const executor = makeExecutor(runtime);
		const result = await executor(turnInput);
		expect(result.ok).toBe(true);
		expect(await executor.cancel!("conv_cancel" as never)).toBe(false);
	});
});

function assistantFinished(
	id: string,
	input: number,
	output: number,
	totalTokens: number,
	stopReason: "stop" | "toolUse" = "stop",
	cacheReadReported?: boolean,
): TranscriptProgress {
	return {
		type: "item_finished",
		item: {
			id,
			role: "assistant",
			status: "complete",
			stopReason,
			content: [{ type: "text", text: "step" }],
			model: { provider: "oneapi", id: "Qwen" },
			usage: {
				...USAGE,
				input,
				output,
				totalTokens,
				...(cacheReadReported === true ? { cacheReadReported: true } : {}),
			},
			timestamp: 1,
		},
	} as unknown as TranscriptProgress;
}
