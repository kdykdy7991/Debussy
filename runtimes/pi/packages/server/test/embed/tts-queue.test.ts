/**
 * TASK-036：有界 TTS 队列单测（spec 15.1 / TASK-036）。
 *
 * 覆盖 spec 要求：默认并发 1 且 FIFO；有界队列（满 → 可解释 `queue_full`）；
 * 超时；取消（pending 移除 + running 走 AbortSignal 中止）；跨会话取消
 * （cancelForConversation 只清一个会话）；provider 故障 → 单任务失败但队列
 * 继续（语音故障不拖垮后续）；指标事件。全部 DB-free。
 */
import { describe, expect, test } from "vitest";
import type { TtsAudioResult, TtsProvider, TtsSynthesisInput } from "../../src/embed/tts/provider.ts";
import { EmbedTtsQueue, type TtsEnqueueInput, type TtsQueueEvent } from "../../src/embed/tts/queue.ts";

const simpleAudio = (): TtsAudioResult => ({ bytes: new Uint8Array([9, 9]), contentType: "audio/ogg" });

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Narrow the enqueue union: returns the ok branch or throws on a full queue. */
function enqueueOk(queue: EmbedTtsQueue, input: TtsEnqueueInput) {
	const result = queue.enqueue(input);
	if (!result.ok) throw new Error(`enqueue rejected: ${result.error.message}`);
	return result.handle;
}

/** A provider that holds every call; the test releases them one by one. */
function makeHoldingProvider(): {
	provider: TtsProvider;
	held: {
		input: TtsSynthesisInput;
		signal: AbortSignal;
		resolve: (result: TtsAudioResult) => void;
		reject: (error: unknown) => void;
	}[];
	concurrency: { max: number; current: number };
} {
	const held: {
		input: TtsSynthesisInput;
		signal: AbortSignal;
		resolve: (result: TtsAudioResult) => void;
		reject: (error: unknown) => void;
	}[] = [];
	const concurrency = { max: 0, current: 0 };
	const provider: TtsProvider = (input, signal) =>
		new Promise<TtsAudioResult>((resolve, reject) => {
			concurrency.current += 1;
			concurrency.max = Math.max(concurrency.max, concurrency.current);
			held.push({
				input,
				signal,
				resolve: (result) => {
					concurrency.current -= 1;
					resolve(result);
				},
				reject: (error) => {
					concurrency.current -= 1;
					reject(error);
				},
			});
		});
	return { provider, held, concurrency };
}

describe("embed TTS queue", () => {
	test("default concurrency 1, FIFO order, single shared worker", async () => {
		const { provider, held, concurrency } = makeHoldingProvider();
		const queue = new EmbedTtsQueue({ provider });
		queue.enqueue({ id: "1", conversationId: "c", text: "a" });
		queue.enqueue({ id: "2", conversationId: "c", text: "b" });
		queue.enqueue({ id: "3", conversationId: "c", text: "c" });
		expect(held).toHaveLength(1);
		expect(held[0]!.input.text).toBe("a");
		held[0]!.resolve(simpleAudio());
		await flush();
		expect(held).toHaveLength(2);
		expect(held[1]!.input.text).toBe("b");
		held[1]!.resolve(simpleAudio());
		await flush();
		held[2]!.resolve(simpleAudio());
		await flush();
		expect(concurrency.max).toBe(1);
		expect(concurrency.current).toBe(0);
	});

	test("bounded queue returns an interpretable queue_full error", async () => {
		const { provider } = makeHoldingProvider();
		const queue = new EmbedTtsQueue({ provider, concurrency: 1, maxPending: 2 });
		queue.enqueue({ id: "1", conversationId: "c", text: "a" }); // running
		queue.enqueue({ id: "2", conversationId: "c", text: "b" }); // pending
		queue.enqueue({ id: "3", conversationId: "c", text: "c" }); // pending (capacity)
		expect(queue.enqueue({ id: "4", conversationId: "c", text: "d" }).ok).toBe(false);
		const full = queue.enqueue({ id: "5", conversationId: "c", text: "e" });
		expect(full.ok).toBe(false);
		if (!full.ok) expect(full.error.code).toBe("queue_full");
	});

	test("a stuck job times out on its deadline", async () => {
		const { provider } = makeHoldingProvider();
		const queue = new EmbedTtsQueue({ provider, timeoutMs: 20 });
		const handle = enqueueOk(queue, { id: "t", conversationId: "c", text: "x" });
		await expect(handle.done).rejects.toMatchObject({ code: "timeout" });
	});

	test("cancel removes a pending job and lets earlier ones finish", async () => {
		const { provider, held } = makeHoldingProvider();
		const queue = new EmbedTtsQueue({ provider, concurrency: 1 });
		queue.enqueue({ id: "keep", conversationId: "c", text: "a" }); // running
		const cancelledHandle = enqueueOk(queue, { id: "drop", conversationId: "c", text: "b" }); // pending
		expect(cancelledHandle.cancel()).toBe(true);
		await expect(cancelledHandle.done).rejects.toMatchObject({ code: "cancelled" });
		held[0]!.resolve(simpleAudio());
		await flush();
		expect(held).toHaveLength(1);
	});

	test("cancel of a running job aborts the provider signal", async () => {
		const { provider, held } = makeHoldingProvider();
		const queue = new EmbedTtsQueue({ provider, concurrency: 1 });
		const handle = enqueueOk(queue, { id: "run", conversationId: "c", text: "a" });
		expect(held).toHaveLength(1);
		expect(queue.cancel("run")).toBe(false);
		await expect(handle.done).rejects.toMatchObject({ code: "cancelled" });
		expect(held[0]!.signal.aborted).toBe(true);
		expect(queue.stats().running).toBe(0);
	});

	test("cross-session cancel only affects one conversation", async () => {
		const { provider, held } = makeHoldingProvider();
		const queue = new EmbedTtsQueue({ provider, concurrency: 1, maxPending: 10 });
		const a1 = enqueueOk(queue, { id: "a1", conversationId: "cA", text: "a" }); // running
		const a2 = enqueueOk(queue, { id: "a2", conversationId: "cA", text: "b" }); // pending
		const b1 = enqueueOk(queue, { id: "b1", conversationId: "cB", text: "x" }); // pending
		const affected = queue.cancelForConversation("cA");
		expect(affected).toBeGreaterThanOrEqual(1);
		await expect(a2.done).rejects.toMatchObject({ code: "cancelled" });
		await a1.done.catch(() => undefined); // running cA aborted too
		expect(held[0]!.signal.aborted).toBe(true);
		// Free slot promotes b1 (cB) to running; cA jobs are fully gone.
		expect(queue.stats().pendingLocked + queue.stats().running).toBe(1);
		queue.cancel(b1.id);
		await expect(b1.done).rejects.toMatchObject({ code: "cancelled" });
		expect(queue.stats().running).toBe(0);
	});

	test("provider failure fails one job but the queue keeps processing (text-safe)", async () => {
		const { provider, held } = makeHoldingProvider();
		const queue = new EmbedTtsQueue({ provider, concurrency: 1 });
		const failing = enqueueOk(queue, { id: "f", conversationId: "c", text: "boom" });
		held[0]!.reject(new Error("provider exploded"));
		await expect(failing.done).rejects.toMatchObject({ code: "provider" });
		const next = enqueueOk(queue, { id: "ok", conversationId: "c", text: "fine" });
		held[1]!.resolve(simpleAudio());
		const result = await next.done;
		expect(result.contentType).toBe("audio/ogg");
	});

	test("emits lifecycle events for queued/started/completed/cancelled", async () => {
		const { provider, held } = makeHoldingProvider();
		const events: TtsQueueEvent[] = [];
		const queue = new EmbedTtsQueue({ provider, onEvent: (event) => events.push(event) });
		const cancelling = enqueueOk(queue, { id: "cc", conversationId: "c", text: "a" });
		held[0]!.resolve(simpleAudio());
		await cancelling.done;
		await flush();
		const cancelled = enqueueOk(queue, { id: "dd", conversationId: "c", text: "b" });
		cancelled.cancel();
		await cancelled.done.catch(() => undefined);
		await flush();
		const types = events.map((event) => event.type);
		expect(types).toContain("queued");
		expect(types).toContain("started");
		expect(types).toContain("completed");
		expect(types).toContain("cancelled");
	});
});
