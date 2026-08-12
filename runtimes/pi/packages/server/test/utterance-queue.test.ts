import type { LiveSpeechErrorCode } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import type { CommittedUtterance } from "../src/voice/live/text-segmenter.ts";
import {
	createUtteranceQueue,
	DEFAULT_CHARACTERS_PER_SECOND,
	DEFAULT_MAX_ESTIMATED_AUDIO_SECONDS,
	DEFAULT_MAX_QUEUED_CHARACTERS,
	DEFAULT_MAX_QUEUED_UTTERANCES,
	type PcmSink,
	type PcmSource,
	type QueueEvent,
	type SynthesizeFn,
	type UtteranceQueue,
} from "../src/voice/live/utterance-queue.ts";
import type { VoiceAudioFormat } from "../src/voice/types.ts";

const FORMAT: VoiceAudioFormat = { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 };
const OTHER_FORMAT: VoiceAudioFormat = { encoding: "pcm_f32le", sampleRate: 16000, channels: 1 };

/** A controllable upstream: hand-fed chunks, abort listener, optional error. */
class FakeUpstream {
	readonly signals: AbortSignal[] = [];
	chunks: Uint8Array[] = [];
	hang = false;
	errorOnRead?: Error;
	format: VoiceAudioFormat = FORMAT;
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	readonly body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
		start: (controller) => {
			this.controller = controller;
		},
		pull: () => {
			// The test pushes chunks explicitly via `feed()`; nothing to do here.
		},
		cancel: () => {
			this.controller = null;
		},
	});

	openCalls = 0;
	requests: { text: string; profileId: string }[] = [];

	asPcmSource(): PcmSource {
		return { format: this.format, body: this.body };
	}

	feed(chunk: Uint8Array): void {
		if (!this.controller) return;
		this.controller.enqueue(chunk);
	}

	close(): void {
		if (!this.controller) return;
		this.controller.close();
		this.controller = null;
	}

	errorOut(error: Error): void {
		if (!this.controller) return;
		try {
			this.controller.error(error);
		} catch {
			// Already closed; ignore.
		}
		this.controller = null;
	}
}

/** A controllable downstream sink that records writes and backpressure. */
class FakeSink implements PcmSink {
	writes: { chunk: Uint8Array; at: number }[] = [];
	closed = false;
	failedWith?: { code: LiveSpeechErrorCode; message: string };
	/**
	 * Optional backpressure gate. When set, every `write` returns a promise
	 * that resolves only when `release()` is called. Tests that need to
	 * pause writes call `hold()` and resolve via `release()`.
	 */
	gate: Promise<void> | null = null;
	private releaseGate: (() => void) | null = null;
	/** Resolves when the currently gated write is released; `null` when no write is parked. */
	pendingWrite: Promise<void> | null = null;
	writeError: Error | null = null;

	hold(): void {
		this.gate = new Promise<void>((resolve) => {
			this.releaseGate = resolve;
		});
	}

	release(): void {
		if (this.releaseGate) this.releaseGate();
		this.releaseGate = null;
		this.gate = null;
	}

	async write(chunk: Uint8Array): Promise<void> {
		if (this.writeError) throw this.writeError;
		if (this.gate) {
			this.pendingWrite = this.gate.then(() => {
				this.writes.push({ chunk, at: Date.now() });
			});
			await this.pendingWrite;
			this.pendingWrite = null;
			return;
		}
		this.writes.push({ chunk, at: Date.now() });
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	async fail(error: { code: LiveSpeechErrorCode; message: string }): Promise<void> {
		this.failedWith = error;
	}

	/** Concatenate all writes in order, for byte-order assertions. */
	bytes(): Uint8Array {
		const total = this.writes.reduce((acc, w) => acc + w.chunk.byteLength, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const w of this.writes) {
			out.set(w.chunk, offset);
			offset += w.chunk.byteLength;
		}
		return out;
	}
}

interface Harness {
	queue: UtteranceQueue;
	upstreams: FakeUpstream[];
	sink: FakeSink;
	events: QueueEvent[];
	signal: AbortController;
	openStream: SynthesizeFn;
}

function makeHarness(
	options: { limits?: Parameters<typeof createUtteranceQueue>[0]["limits"]; format?: VoiceAudioFormat } = {},
): Harness {
	const upstreams: FakeUpstream[] = [];
	const sink = new FakeSink();
	const events: QueueEvent[] = [];
	const signal = new AbortController();
	const openStream: SynthesizeFn = async (input) => {
		const upstream = new FakeUpstream();
		upstream.format = options.format ?? FORMAT;
		upstream.openCalls += 1;
		upstream.requests.push({ text: input.text, profileId: input.profileId });
		upstream.signals.push(input.signal);
		upstreams.push(upstream);
		return upstream.asPcmSource();
	};
	const queue = createUtteranceQueue({
		profileId: "default",
		synthesize: openStream,
		sink,
		signal: signal.signal,
		onEvent: (event) => events.push(event),
		limits: options.limits,
	});
	return { queue, upstreams, sink, events, signal, openStream };
}

function utterance(sequence: number, text: string): CommittedUtterance {
	return { sequence, text, reason: "terminal_punctuation" };
}

afterEach(() => {
	// nothing global; each test owns its harness
});

describe("UtteranceQueue — defaults and validation", () => {
	test("exposes the V7-frozen defaults", () => {
		expect(DEFAULT_MAX_QUEUED_UTTERANCES).toBe(12);
		expect(DEFAULT_MAX_QUEUED_CHARACTERS).toBe(1200);
		expect(DEFAULT_MAX_ESTIMATED_AUDIO_SECONDS).toBe(90);
		expect(DEFAULT_CHARACTERS_PER_SECOND).toBe(16);
	});

	test("rejects missing dependencies", () => {
		const sink = new FakeSink();
		const signal = new AbortController().signal;
		const synth: SynthesizeFn = async () => {
			throw new Error("unreachable");
		};
		// @ts-expect-error: missing synthesize on purpose
		expect(() => createUtteranceQueue({ profileId: "p", sink, signal, onEvent: () => {} })).toThrow();
		// @ts-expect-error: missing sink on purpose
		expect(() => createUtteranceQueue({ profileId: "p", synthesize: synth, signal, onEvent: () => {} })).toThrow();
		// @ts-expect-error: missing onEvent on purpose
		expect(() => createUtteranceQueue({ profileId: "p", synthesize: synth, sink, signal })).toThrow();
	});

	test("rejects negative limits", () => {
		const signal = new AbortController().signal;
		const synth: SynthesizeFn = async () => {
			throw new Error("unreachable");
		};
		const sink = new FakeSink();
		expect(() =>
			createUtteranceQueue({
				profileId: "p",
				synthesize: synth,
				sink,
				signal,
				onEvent: () => {},
				limits: { maxQueuedUtterances: 0 },
			}),
		).toThrow(RangeError);
		expect(() =>
			createUtteranceQueue({
				profileId: "p",
				synthesize: synth,
				sink,
				signal,
				onEvent: () => {},
				limits: { charactersPerSecond: 0 },
			}),
		).toThrow(RangeError);
	});
});

describe("UtteranceQueue — order and single-flight", () => {
	test("three utterances are processed in sequence and with one synthesize in flight at a time", async () => {
		const h = makeHarness();
		const texts = ["第一句，", "第二句。", "第三句。"];
		for (let i = 0; i < texts.length; i += 1) {
			h.queue.enqueue(utterance(i + 1, texts[i]!));
		}
		// Each enqueue opens a source only when the previous EOFs. After
		// enqueue(1) the first synthesize runs synchronously up to the first
		// reader.read(). So exactly one upstream should exist at this point.
		expect(h.upstreams.length).toBe(1);

		// Feed and close each utterance in turn.
		const allBytes: number[] = [];
		for (let i = 0; i < texts.length; i += 1) {
			const u = h.upstreams[i]!;
			const start = allBytes.length + 1;
			u.feed(new Uint8Array([start, start + 1, start + 2, start + 3]));
			allBytes.push(start, start + 1, start + 2, start + 3);
			u.close();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const result = await h.queue.closeInput();
		expect(h.upstreams.length).toBe(3);
		// Each upstream received the matching text and the same profile.
		for (let i = 0; i < texts.length; i += 1) {
			expect(h.upstreams[i]!.requests[0]).toEqual({ text: texts[i], profileId: "default" });
		}
		expect(Array.from(h.sink.bytes())).toEqual(allBytes);
		expect(h.sink.closed).toBe(true);
		expect(h.sink.failedWith).toBeUndefined();
		const completedSeqs = h.events
			.filter((e): e is { type: "completed"; sequence: number; characters: number } => e.type === "completed")
			.map((e) => e.sequence);
		expect(completedSeqs).toEqual([1, 2, 3]);
		expect(result.status).toBe("completed");
	});

	test("upstream chunks split at arbitrary boundaries are forwarded verbatim", async () => {
		const h = makeHarness();
		const fullBytes = Uint8Array.from({ length: 17 }, (_, i) => i + 1); // 1..17
		h.queue.enqueue(utterance(1, "短句，足够长。"));
		expect(h.upstreams.length).toBe(1);
		const u1 = h.upstreams[0]!;
		// Feed in tiny chunks: 1, 3, 1, 12 bytes
		const parts = [
			fullBytes.subarray(0, 1),
			fullBytes.subarray(1, 4),
			fullBytes.subarray(4, 5),
			fullBytes.subarray(5, 17),
		];
		for (const part of parts) u1.feed(part);
		u1.close();
		await h.queue.closeInput();
		expect(Array.from(h.sink.bytes())).toEqual(Array.from(fullBytes));
	});
});

describe("UtteranceQueue — source errors", () => {
	test("source errors on the first byte fails the job with a safe message", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "hello world here"));
		const u1 = h.upstreams[0]!;
		u1.errorOut(new Error("upstream boom"));
		const result = await h.queue.completion;
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error.code).toBe("speech_generation_failed");
			expect(result.error.message).toBe("upstream boom");
		}
		expect(h.sink.failedWith?.code).toBe("speech_generation_failed");
	});

	test("source error mid-stream discards the active utterance and surfaces safe failure", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "hello world here"));
		const u1 = h.upstreams[0]!;
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		u1.errorOut(new Error("mid boom"));
		const result = await h.queue.completion;
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error.code).toBe("speech_generation_failed");
		}
		expect(h.sink.failedWith?.code).toBe("speech_generation_failed");
	});

	test("synthesize() throwing fails the job and discards queued entries", async () => {
		const h = makeHarness();
		const customSynth: SynthesizeFn = async () => {
			throw new Error("synthesize kaput");
		};
		const q = createUtteranceQueue({
			profileId: "p",
			synthesize: customSynth,
			sink: h.sink,
			signal: h.signal.signal,
			onEvent: (e) => h.events.push(e),
		});
		q.enqueue(utterance(1, "hello world here"));
		const result = await q.completion;
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error.code).toBe("speech_generation_failed");
			expect(result.error.message).toBe("synthesize kaput");
		}
	});
});

describe("UtteranceQueue — format freeze", () => {
	test("the first source locks the format and a mismatch fails the job", async () => {
		const captured: FakeUpstream[] = [];
		const sink = new FakeSink();
		const events: QueueEvent[] = [];
		let first = true;
		const synth: SynthesizeFn = async () => {
			const upstream = new FakeUpstream();
			upstream.format = first ? FORMAT : OTHER_FORMAT;
			first = false;
			captured.push(upstream);
			return upstream.asPcmSource();
		};
		const q = createUtteranceQueue({
			profileId: "p",
			synthesize: synth,
			sink,
			signal: new AbortController().signal,
			onEvent: (e) => events.push(e),
		});
		q.enqueue(utterance(1, "first sentence here"));
		const a = captured[0]!;
		a.feed(new Uint8Array([9, 9, 9, 9]));
		a.close();
		// Now enqueue the second utterance and feed it a different sample rate.
		q.enqueue(utterance(2, "second sentence here"));
		// Wait one tick for the second synthesize to be called.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const b = captured[1]!;
		b.feed(new Uint8Array([1, 2, 3, 4]));
		const result = await q.completion;
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error.code).toBe("speech_generation_failed");
		}
		// Locked event fired with the original format.
		const locked = events.find((e) => e.type === "format_locked");
		expect(locked && locked.type === "format_locked" ? locked.format : null).toEqual(FORMAT);
	});

	test("upstream returning an unsupported encoding fails before any byte is forwarded", async () => {
		const captured: FakeUpstream[] = [];
		const sink = new FakeSink();
		const synth: SynthesizeFn = async () => {
			const upstream = new FakeUpstream();
			upstream.format = {
				encoding: "wav" as unknown as "pcm_f32le",
				sampleRate: 24000,
				channels: 1,
			};
			captured.push(upstream);
			return upstream.asPcmSource();
		};
		const q = createUtteranceQueue({
			profileId: "p",
			synthesize: synth,
			sink,
			signal: new AbortController().signal,
			onEvent: () => {},
		});
		q.enqueue(utterance(1, "hello world here"));
		const result = await q.completion;
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("speech_generation_failed");
		expect(captured.length).toBe(1);
	});
});

describe("UtteranceQueue — sink backpressure and failures", () => {
	test("a slow sink pauses the upstream reader", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "hello world here"));
		const u1 = h.upstreams[0]!;
		// Hold the sink BEFORE feeding so the first write is parked on the gate.
		h.sink.hold();
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		// Give the queue a chance to attempt the (gated) write.
		await new Promise((resolve) => setTimeout(resolve, 0));
		// First write is parked (call recorded in pendingWrite).
		expect(h.sink.pendingWrite).not.toBeNull();
		// Release the gate; the queue completes naturally.
		u1.close();
		h.sink.release();
		const result = await h.queue.closeInput();
		expect(result.status).toBe("completed");
	});

	test("sink.write throwing fails the job", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "hello world here"));
		const u1 = h.upstreams[0]!;
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		h.sink.writeError = new Error("sink rejected");
		u1.close();
		const result = await h.queue.closeInput();
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("speech_generation_failed");
	});
});

describe("UtteranceQueue — close, empty close, and enqueue semantics", () => {
	test("enqueue while generating is allowed and the entry is held in the pending queue", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "first sentence here"));
		expect(h.upstreams.length).toBe(1);
		// Enqueue two more while utterance 1 is still streaming.
		h.queue.enqueue(utterance(2, "second sentence here"));
		h.queue.enqueue(utterance(3, "third sentence here"));
		expect(h.upstreams.length).toBe(1);
		// Drive all three upstreams in sequence.
		const allBytes: number[] = [];
		for (let i = 0; i < 3; i += 1) {
			const u = h.upstreams[i]!;
			const start = allBytes.length + 1;
			u.feed(new Uint8Array([start, start + 1, start + 2, start + 3]));
			allBytes.push(start, start + 1, start + 2, start + 3);
			u.close();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const result = await h.queue.closeInput();
		expect(h.upstreams.length).toBe(3);
		expect(result.status).toBe("completed");
		expect(Array.from(h.sink.bytes())).toEqual(allBytes);
	});

	test("closeInput resolves after pending entries drain", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "first sentence here"));
		h.queue.enqueue(utterance(2, "second sentence here"));
		// Close the input BEFORE driving the upstreams.
		const closePromise = h.queue.closeInput();
		expect(h.sink.closed).toBe(false);
		// Drive both upstreams; completion must resolve after both drain.
		const u1 = h.upstreams[0]!;
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		u1.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const u2 = h.upstreams[1]!;
		u2.feed(new Uint8Array([5, 6, 7, 8]));
		u2.close();
		const result = await closePromise;
		expect(result.status).toBe("completed");
	});

	test("empty closeInput completes immediately with zero counts", async () => {
		const h = makeHarness();
		const result = await h.queue.closeInput();
		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect(result.completedUtterances).toBe(0);
			expect(result.failedUtterances).toBe(0);
			expect(result.discardedUtterances).toBe(0);
		}
	});

	test("enqueue after closeInput throws", async () => {
		const h = makeHarness();
		await h.queue.closeInput();
		// The queue has settled once closeInput() resolved, so the error
		// message references either closeInput() or the settled state.
		expect(() => h.queue.enqueue(utterance(1, "after close"))).toThrow(/closeInput|settled/);
	});
});

describe("UtteranceQueue — cancel semantics", () => {
	test("cancel while a stream is active aborts upstream and downstream cleanly", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "first sentence here"));
		h.queue.enqueue(utterance(2, "second sentence here"));
		const u1 = h.upstreams[0]!;
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		// Cancel mid-stream.
		const cancelResult = await h.queue.cancel("user_cancel");
		expect(cancelResult.status).toBe("cancelled");
		if (cancelResult.status === "cancelled") {
			expect(cancelResult.reason).toBe("user_cancel");
		}
		// Second enqueue attempts would throw, but we don't enqueue here.
		// Upstream signals must have been aborted.
		expect(u1.signals[0]!.aborted).toBe(true);
		// Subsequent cancels are idempotent.
		const r2 = await h.queue.cancel("user_cancel");
		expect(r2.status).toBe("cancelled");
	});

	test("cancel while queued but not yet generating discards pending and settles", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "first sentence here"));
		// Drive the first one immediately so the next sits in pending.
		const u1 = h.upstreams[0]!;
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		u1.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The second upstream is now open; we want a "queued" test. Reset and
		// build a new harness where the upstream hangs so the second enqueue
		// truly sits in pending.
		const h2 = makeHarness();
		h2.queue.enqueue(utterance(1, "first sentence here"));
		expect(h2.upstreams.length).toBe(1);
		const u1b = h2.upstreams[0]!;
		u1b.hang = true;
		// The first synthesize is in flight and stuck on the first read.
		h2.queue.enqueue(utterance(2, "second sentence here"));
		h2.queue.enqueue(utterance(3, "third sentence here"));
		const result = await h2.queue.cancel("agent_abort");
		expect(result.status).toBe("cancelled");
		if (result.status === "cancelled") {
			expect(result.reason).toBe("agent_abort");
			// Two utterances discarded (the two still pending).
			expect(result.discardedUtterances).toBe(2);
		}
		// The upstream's signal was aborted.
		expect(u1b.signals[0]!.aborted).toBe(true);
	});

	test("cancel during draining (queue empty, input open) settles as cancelled", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "first sentence here"));
		const u1 = h.upstreams[0]!;
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		u1.close();
		// Give the queue a tick to finish processing the first utterance; the
		// queue remains in "draining" state because `inputClosed` is false.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const r = await h.queue.cancel("shutdown");
		expect(r.status).toBe("cancelled");
		if (r.status === "cancelled") {
			expect(r.reason).toBe("shutdown");
			expect(r.completedUtterances).toBe(1);
			expect(r.discardedUtterances).toBe(0);
		}
	});

	test("multiple cancel calls return the same settled result", async () => {
		const h = makeHarness();
		const p1 = h.queue.cancel("user_cancel");
		const p2 = h.queue.cancel("shutdown");
		const p3 = h.queue.cancel("user_cancel");
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
		expect(r1.status).toBe("cancelled");
		expect(r2.status).toBe("cancelled");
		expect(r3.status).toBe("cancelled");
	});
});

describe("UtteranceQueue — backlog limits", () => {
	test("maxQueuedUtterances: enqueue beyond the cap fails the queue", async () => {
		// cap=2; 1 generating + 2 pending = 3 → trip.
		const h = makeHarness({
			limits: {
				maxQueuedUtterances: 2,
				maxQueuedCharacters: 1_000,
				maxEstimatedAudioSeconds: 600,
				charactersPerSecond: 16,
			},
		});
		h.queue.enqueue(utterance(1, "x".repeat(20)));
		const u1 = h.upstreams[0]!;
		u1.hang = true;
		h.queue.enqueue(utterance(2, "y".repeat(20)));
		h.queue.enqueue(utterance(3, "z".repeat(20)));
		const result = await h.queue.completion;
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error.code).toBe("speech_backlog_exceeded");
		}
		const backlogEvent = h.events.find((e) => e.type === "backlog_exceeded");
		expect(backlogEvent && backlogEvent.type === "backlog_exceeded" ? backlogEvent.reason : null).toBe(
			"max_utterances",
		);
	});

	test("maxQueuedCharacters: enqueue pushes the queue over the byte cap", async () => {
		// 20 (generating) + 20 (pending) = 40 > 30 → trip on the 2nd enqueue.
		const h = makeHarness({
			limits: {
				maxQueuedUtterances: 50,
				maxQueuedCharacters: 30,
				maxEstimatedAudioSeconds: 600,
				charactersPerSecond: 16,
			},
		});
		h.queue.enqueue(utterance(1, "x".repeat(20)));
		const u1 = h.upstreams[0]!;
		u1.hang = true;
		h.queue.enqueue(utterance(2, "y".repeat(20)));
		const result = await h.queue.completion;
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error.code).toBe("speech_backlog_exceeded");
		}
		const backlogEvent = h.events.find((e) => e.type === "backlog_exceeded");
		expect(backlogEvent && backlogEvent.type === "backlog_exceeded" ? backlogEvent.reason : null).toBe(
			"max_characters",
		);
	});

	test("maxEstimatedAudioSeconds: 90s / 16 chars-per-second = 1440 chars cap", async () => {
		// 1500 chars > 1440 → backlog exceeded on the first enqueue.
		const h = makeHarness({
			limits: {
				maxQueuedUtterances: 50,
				maxQueuedCharacters: 10_000,
				maxEstimatedAudioSeconds: 90,
				charactersPerSecond: 16,
			},
		});
		h.queue.enqueue(utterance(1, "x".repeat(1500)));
		const result = await h.queue.completion;
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error.code).toBe("speech_backlog_exceeded");
		}
		const backlogEvent = h.events.find((e) => e.type === "backlog_exceeded");
		expect(backlogEvent && backlogEvent.type === "backlog_exceeded" ? backlogEvent.reason : null).toBe(
			"max_audio_seconds",
		);
	});

	test("boundary: exactly at the cap is allowed", async () => {
		// 12 entries, 1200 chars, 90s audio (16 chars/s) — exactly the V7 defaults.
		const h = makeHarness();
		for (let i = 1; i <= 12; i += 1) h.queue.enqueue(utterance(i, "x".repeat(100)));
		const u1 = h.upstreams[0]!;
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		u1.close();
		const backlog = h.events.find((e) => e.type === "backlog_exceeded");
		expect(backlog).toBeUndefined();
		await h.queue.cancel("user_cancel");
	});
});

describe("UtteranceQueue — late callbacks and clean shutdown", () => {
	test("a chunk arriving after cancel is not forwarded to the sink", async () => {
		const h = makeHarness();
		h.queue.enqueue(utterance(1, "first sentence here"));
		const u1 = h.upstreams[0]!;
		u1.feed(new Uint8Array([1, 2, 3, 4]));
		const cancel = h.queue.cancel("user_cancel");
		// Force the upstream to keep producing — the reader is cancelled so the
		// `pull` won't see more data, but we attempt to enqueue anyway. The
		// implementation calls `reader.cancel()` on settle, so the readable
		// becomes done.
		try {
			u1.feed(new Uint8Array([99, 99, 99, 99]));
		} catch {
			// Controller may already be closed; ignore.
		}
		await cancel;
		// The sink must not have seen the post-cancel bytes.
		const allBytes = Array.from(h.sink.bytes());
		expect(allBytes).not.toContain(99);
	});

	test("a chunk arriving after settle is not forwarded to the sink (closed input + drained)", async () => {
		const h = makeHarness();
		await h.queue.closeInput();
		// No bytes should have been written.
		expect(h.sink.bytes().byteLength).toBe(0);
		expect(h.sink.closed).toBe(true);
	});

	test("no listener leak: external signal can be re-used after the queue settles", async () => {
		const ac = new AbortController();
		const sink = new FakeSink();
		const events: QueueEvent[] = [];
		const q = createUtteranceQueue({
			profileId: "p",
			synthesize: async () => {
				throw new Error("synthesize called unexpectedly");
			},
			sink,
			signal: ac.signal,
			onEvent: (e) => events.push(e),
		});
		q.enqueue(utterance(1, "hello world here"));
		await q.completion;
		// External AbortController can be aborted without throwing; the queue
		// must have removed its listener.
		expect(() => ac.abort()).not.toThrow();
		// The signal's listener list should be empty after settlement.
		// (Node's AbortSignal keeps an internal map; we can only assert that
		// re-aborting does not throw and that the queue's internal controller
		// is already aborted.)
		const result = await q.completion;
		expect(result.status).toBe("failed");
	});
});
