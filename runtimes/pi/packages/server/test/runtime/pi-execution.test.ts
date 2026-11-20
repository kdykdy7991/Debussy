/**
 * R010 第一部分：共享 Pi 单次执行与取消入口。
 *
 * 覆盖三件事：一次成功执行（结果/进度/用量提取保持既有行为）、执行中取消
 * （信号必须到达底层 Pi，且已取消的执行不返回成功）、以及同一归属不得并发执行。
 */

import type { ModelRef, SessionSnapshot, ThinkingLevel, TranscriptProgress, Usage } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { ConversationId } from "../../src/publishing/domain/ids.ts";
import type { LlmCallTrace } from "../../src/types.ts";
import { ConversationRuntime } from "../../src/runtime/conversation-runtime.ts";
import { createPiExecutionEntry } from "../../src/runtime/pi-execution.ts";
import type { RuntimeScope } from "../../src/runtime/scope-context.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput, SteerInput } from "../../src/types.ts";

const MODEL: ModelRef = { provider: "skdy", id: "pi-chat" };

const USAGE: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 可控的假会话：prompt 挂起直到 complete()/abort() 被调用。 */
class ControllableSession implements PiSessionRuntime {
	readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	readonly prompts: PromptInput[] = [];
	aborted = 0;
	disposed = 0;
	private settled = false;
	private failure: string | undefined;
	private resolvePrompt: (() => void) | undefined;
	private assistant: { text: string; status: "complete" | "aborted" } = { text: "", status: "complete" };

	snapshot(): SessionSnapshot {
		return {
			id: "session-1",
			cwd: "/tmp",
			createdAt: 1,
			updatedAt: 1,
			phase: "idle",
			model: MODEL,
			thinkingLevel: "off",
			attached: true,
			locked: true,
			lastSequence: 0,
			revision: 0,
			transcript:
				this.assistant.text === "" && this.assistant.status === "complete"
					? []
					: [
							{
								id: "assistant-1",
								role: "assistant",
								content: [{ type: "text", text: this.assistant.text }],
								status: this.assistant.status,
								model: MODEL,
								stopReason: this.assistant.status === "complete" ? "stop" : "aborted",
								timestamp: 2,
							},
						],
			queuedSteer: [],
			queuedSteerCount: 0,
		} as unknown as SessionSnapshot;
	}
	getPhase(): "idle" {
		return "idle";
	}
	async prompt(input: PromptInput): Promise<void> {
		this.prompts.push(input);
		await new Promise<void>((resolve) => {
			this.resolvePrompt = resolve;
		});
		this.settled = true;
		if (this.failure !== undefined) throw new Error(this.failure);
	}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {
		this.aborted += 1;
		this.assistant = { text: "", status: "aborted" };
		this.resolvePrompt?.();
	}
	async setModel(_model: ModelRef): Promise<void> {}
	async setThinking(_thinkingLevel: ThinkingLevel): Promise<void> {}
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async dispose(): Promise<void> {
		this.disposed += 1;
	}
	/** 完成本次 prompt（模拟 provider 正常返回）。 */
	complete(text: string, usage?: Usage): void {
		this.assistant = { text, status: "complete" };
		this.resolvePrompt?.();
	}
	/** Emits a completed assistant item with provider usage. */
	emitCompleted(id: string, usage: Usage): void {
		this.emitProgress({
			type: "item_finished",
			item: {
				id,
				role: "assistant",
				status: "complete",
				content: [{ type: "text", text: "done" }],
				model: { provider: "skdy", id: "pi-chat" },
				usage,
			},
		} as unknown as TranscriptProgress);
	}
	/** Emits the provider-boundary response trace of the same call. */
	async emitResponseTrace(usage: Usage, stopReason: "stop" | "error" = "stop"): Promise<void> {
		const input = this.prompts[0];
		await input?.onLlmTrace?.({
			kind: "response",
			callIndex: 1,
			model: { provider: "skdy", id: "pi-chat" },
			message: {
				timestamp: 7,
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage,
				stopReason,
			},
		} as unknown as LlmCallTrace);
	}
	/** Fails the prompt after the progress was observed. */
	fail(message: string): void {
		this.failure = message;
		this.resolvePrompt?.();
	}
	emitProgress(progress: TranscriptProgress): void {
		for (const listener of this.listeners) listener({ type: "progress", progress });
	}
	isSettled(): boolean {
		return this.settled;
	}
}

function runtimeScope(): RuntimeScope {
	return {
		tenantId: "ten-test" as never,
		publishedAppId: null,
		publishedAppVersionId: "pav-test",
		principalId: "prn-test" as never,
		sessionId: "session-1",
		limits: {
			maxTurns: 10,
			maxContextTokens: 1000,
			toolResultMaxBytes: 1024,
			turnTimeoutMs: 1000,
			maxConcurrentTurnsPerConversation: 1,
		},
	};
}

function createRuntime(session: ControllableSession): ConversationRuntime {
	return new ConversationRuntime({
		scope: runtimeScope(),
		spec: {
			schemaVersion: 1,
			publishedAppVersionId: "pav-test",
			agent: { systemPrompt: "s", model: { provider: "skdy", modelId: "pi-chat", params: {} } },
			capabilities: {
				tools: [],
				knowledgeBases: [],
				skills: [],
				mcpServers: [],
				uploads: { enabled: false, maxFiles: 1, maxFileBytes: 1 },
				speech: { enabled: false },
				realtimeVoice: { enabled: false },
				avatar: { enabled: false },
				conversations: { allowNew: true },
			},
			contextPolicy: { maxTurns: 10, maxContextTokens: 1000, toolResultMaxBytes: 1024, logLevel: "standard" },
			runtimePolicy: {
				profile: "chat-only",
				turnTimeoutMs: 1000,
				idleTtlMs: 1000,
				maxConcurrentTurnsPerConversation: 1,
			},
			theme: {},
			securityPolicyVersion: "sp_001",
		} as never,
		session,
	});
}

const CONVERSATION = { kind: "conversation", conversationId: "conv-1" as ConversationId } as const;

describe("共享 Pi 执行入口", () => {
	test("一次成功执行返回结果、进度与用量", async () => {
		const session = new ControllableSession();
		const runtime = createRuntime(session);
		const entry = createPiExecutionEntry();
		const progress: TranscriptProgress[] = [];
		const execution = entry.execute(runtime, {
			identity: CONVERSATION,
			input: "你好",
			onProgress: (event) => progress.push(event),
		});
		await Promise.resolve();
		session.emitProgress({ type: "assistant_delta", messageId: "m1", contentIndex: 0, kind: "text", delta: "hi" });
		session.complete("你好，我在。");

		const outcome = await execution;
		expect(outcome.status).toBe("completed");
		if (outcome.status !== "completed") throw new Error("expected a completed outcome");
		expect(outcome.outputText).toBe("你好，我在。");
		expect(progress.map((event) => event.type)).toEqual(["assistant_delta"]);
		expect(session.prompts[0]?.text).toBe("你好");
	});

	test("运行中取消：信号到达底层 Pi，且不返回成功", async () => {
		const session = new ControllableSession();
		const runtime = createRuntime(session);
		const entry = createPiExecutionEntry();
		const execution = entry.execute(runtime, { identity: CONVERSATION, input: "长任务" });
		await Promise.resolve();

		expect(await entry.cancel(CONVERSATION)).toBe(true);
		const outcome = await execution;

		expect(outcome.status).toBe("cancelled");
		expect(session.aborted).toBe(1);
	});

	test("取消后不再接受同一归属的并发执行", async () => {
		const session = new ControllableSession();
		const runtime = createRuntime(session);
		const entry = createPiExecutionEntry();
		const execution = entry.execute(runtime, { identity: CONVERSATION, input: "第一个" });
		await Promise.resolve();

		await expect(entry.execute(runtime, { identity: CONVERSATION, input: "第二个" })).rejects.toThrow(
			/an execution is already running/,
		);

		await entry.cancel(CONVERSATION);
		await execution;
	});

	test("执行截止到达时中止底层 Pi 并返回取消", async () => {
		const session = new ControllableSession();
		const runtime = createRuntime(session);
		const entry = createPiExecutionEntry();
		const outcome = await entry.execute(runtime, {
			identity: CONVERSATION,
			input: "超时",
			deadlineMs: 10,
		});

		expect(outcome.status).toBe("cancelled");
		expect(session.aborted).toBe(1);
	});

	test("同一调用在进度与调用追踪中都出现时只计一次", async () => {
		const session = new ControllableSession();
		const runtime = createRuntime(session);
		const entry = createPiExecutionEntry();
		const traces: LlmCallTrace[] = [];
		const execution = entry.execute(runtime, {
			identity: CONVERSATION,
			input: "计一次",
			onLlmTrace: async (trace) => {
				traces.push(trace);
			},
		});
		await Promise.resolve();
		session.emitCompleted("assistant-7", USAGE);
		await session.emitResponseTrace(USAGE);
		session.complete("done");

		const outcome = await execution;
		expect(traces).toHaveLength(1);
		expect(outcome.status).toBe("completed");
		if (outcome.status !== "completed") throw new Error("expected a completed outcome");
		expect(outcome.llmUsage?.callCount).toBe(1);
		expect(outcome.llmUsage?.total.input).toBe(USAGE.input);
		expect(outcome.llmUsage?.total.output).toBe(USAGE.output);
	});

	test("失败时保留已经确认的用量", async () => {
		const session = new ControllableSession();
		const runtime = createRuntime(session);
		const entry = createPiExecutionEntry();
		const execution = entry.execute(runtime, { identity: CONVERSATION, input: "会失败" });
		await Promise.resolve();
		session.emitCompleted("assistant-9", USAGE);
		session.fail("provider exploded");

		const outcome = await execution;
		expect(outcome.status).toBe("failed");
		if (outcome.status !== "failed") throw new Error("expected a failed outcome");
		expect(outcome.llmUsage?.callCount).toBe(1);
		expect(outcome.llmUsage?.total.input).toBe(USAGE.input);
	});

	test("provider 以失败终止时即使 prompt 正常返回仍保留已确认用量", async () => {
		const session = new ControllableSession();
		const entry = createPiExecutionEntry();
		const execution = entry.execute(createRuntime(session), { identity: CONVERSATION, input: "会失败" });
		await session.emitResponseTrace(USAGE, "error");
		session.complete("");
		await expect(execution).resolves.toMatchObject({
			status: "failed",
			llmUsage: { callCount: 1, total: { totalTokens: USAGE.totalTokens } },
		});
	});

	test("已取消的执行信号不会启动 prompt", async () => {
		const session = new ControllableSession();
		const entry = createPiExecutionEntry();
		await expect(
			entry.execute(createRuntime(session), {
				identity: CONVERSATION,
				input: "不应启动",
				signal: AbortSignal.abort(),
			}),
		).resolves.toMatchObject({ status: "cancelled" });
		expect(session.prompts).toHaveLength(0);
	});

	test("取消一个不存在的执行返回 false", async () => {
		const entry = createPiExecutionEntry();
		expect(await entry.cancel(CONVERSATION)).toBe(false);
	});
});
