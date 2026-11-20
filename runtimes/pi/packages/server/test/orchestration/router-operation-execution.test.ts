/**
 * R010 第一部分：Router Operation 归属的一次执行。
 *
 * 验证点：Operation 归属不需要 Conversation、Work Item 或 Assignment；
 * 会话 id 就是 operation id（内存会话，用完即关）；运行中取消时信号到达底层 Pi，
 * 且已取消的执行不返回成功。
 */

import type { ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { PrincipalId, TenantId } from "../../src/publishing/domain/ids.ts";
import type { RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import { createRouterOperationExecutor } from "../../src/orchestration/router-operation-execution.ts";
import { createPiRuntimeAdapter, type RuntimeSessionOptions } from "../../src/runtime/pi-runtime-adapter.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput, SteerInput } from "../../src/types.ts";

const MODEL: ModelRef = { provider: "skdy", id: "pi-chat" };

/** 可控的假会话：prompt 挂起直到 complete()/abort() 被调用。 */
class ControllableSession implements PiSessionRuntime {
	readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	readonly prompts: PromptInput[] = [];
	aborted = 0;
	disposed = 0;
	private resolvePrompt: (() => void) | undefined;
	private assistant: { text: string; status: "complete" | "aborted" } = { text: "", status: "complete" };

	private readonly id: string;

	constructor(id: string) {
		this.id = id;
	}

	snapshot(): SessionSnapshot {
		return {
			id: this.id,
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
				this.assistant.status === "complete" && this.assistant.text === ""
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
	complete(text: string): void {
		this.assistant = { text, status: "complete" };
		this.resolvePrompt?.();
	}
}

const SPEC = {
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
} as unknown as RuntimeSpec;

const LIMITS = {
	maxTurns: 10,
	maxContextTokens: 1000,
	toolResultMaxBytes: 1024,
	turnTimeoutMs: 1000,
	maxConcurrentTurnsPerConversation: 1,
};

function createExecutor(): {
	executor: ReturnType<typeof createRouterOperationExecutor>;
	sessions: ControllableSession[];
	sessionOptions: RuntimeSessionOptions[];
} {
	const sessions: ControllableSession[] = [];
	const sessionOptions: RuntimeSessionOptions[] = [];
	const adapter = createPiRuntimeAdapter({
		createSession: async (options) => {
			sessionOptions.push(options);
			const session = new ControllableSession(options.id);
			sessions.push(session);
			return session;
		},
	});
	return { executor: createRouterOperationExecutor({ adapter }), sessions, sessionOptions };
}

/** 等待异步打开的会话真正开始执行（会话工厂与 open 都是异步的）。 */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met before timeout");
}

const REQUEST = {
	operationId: "op-0001",
	tenantId: "ten-test" as TenantId,
	principalId: "prn-test" as PrincipalId,
	publishedAppVersionId: "pav-test",
	spec: SPEC,
	input: "执行这个 Operation",
	limits: LIMITS,
};

describe("Router Operation 归属执行", () => {
	test("不需要 Conversation/Work Item/Assignment 即可完成一次执行", async () => {
		const { executor, sessions, sessionOptions } = createExecutor();
		const execution = executor.execute(REQUEST);
		await waitFor(() => (sessions[0]?.prompts.length ?? 0) > 0);
		sessions[0]?.complete("完成");

		const outcome = await execution;
		expect(outcome.status).toBe("completed");
		if (outcome.status !== "completed") throw new Error("expected a completed outcome");
		expect(outcome.outputText).toBe("完成");
		// 内存会话 id 就是 operation id，且执行结束后会话被关闭。
		expect(sessionOptions[0]?.id).toBe(REQUEST.operationId);
		expect(sessions[0]?.disposed).toBe(1);
	});

	test("运行中取消：信号到达底层 Pi，且不返回成功", async () => {
		const { executor, sessions } = createExecutor();
		const execution = executor.execute(REQUEST);
		await waitFor(() => (sessions[0]?.prompts.length ?? 0) > 0);

		expect(await executor.cancel(REQUEST.operationId)).toBe(true);
		const outcome = await execution;

		expect(outcome.status).toBe("cancelled");
		expect(sessions[0]?.aborted).toBe(1);
	});

	test("取消一个未在执行的 Operation 返回 false", async () => {
		const { executor } = createExecutor();
		expect(await executor.cancel("op-missing")).toBe(false);
	});

	test("Sandbox 授权在环境未配置时以明确错误失败", async () => {
		const { executor, sessionOptions } = createExecutor();
		const outcome = await executor.execute({
			...REQUEST,
			sandboxPolicy: { tenantId: REQUEST.tenantId, workspaceId: "task", deadlineAt: Date.now() + 1_000 },
		});
		expect(outcome).toEqual({ status: "failed", error: "SANDBOX_UNAVAILABLE" });
		expect(sessionOptions).toEqual([]);
	});

	test("白名单拒绝时返回失败而不是成功", async () => {
		const { executor } = createExecutor();
		const outcome = await executor.execute({
			...REQUEST,
			spec: { ...SPEC, runtimePolicy: { ...SPEC.runtimePolicy, profile: "full" } } as unknown as RuntimeSpec,
		});
		expect(outcome.status).toBe("failed");
	});
});
