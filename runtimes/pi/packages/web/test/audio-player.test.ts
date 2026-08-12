import { describe, expect, it, vi } from "vitest";
import { AudioPlayer, LEVEL_SMOOTHING_ALPHA, LEVEL_WINDOW } from "../src/features/voice/audio-player.ts";
import { FakeAudioContext, FakeFrameLoop, seconds, TEST_FORMAT, TEST_SAMPLE_RATE } from "./voice-test-support.ts";

function samples(count: number, value = 0): Float32Array {
	return new Float32Array(count).fill(value);
}

function makePlayer(
	options: {
		firstBufferMs?: number;
		safetyLeadMs?: number;
		callbacks?: {
			onStarted?: () => void;
			onBufferConsumed?: () => void;
			onFinished?: () => void;
			onLevel?: (level: number) => void;
		};
		frames?: FakeFrameLoop;
	} = {},
): { player: AudioPlayer; context: FakeAudioContext; callbacks: NonNullable<typeof options.callbacks> } {
	const context = new FakeAudioContext();
	const callbacks = options.callbacks ?? {};
	const player = new AudioPlayer({
		context,
		format: TEST_FORMAT,
		firstBufferMs: options.firstBufferMs,
		safetyLeadMs: options.safetyLeadMs,
		callbacks,
		requestFrame: options.frames?.requestFrame,
		cancelFrame: options.frames?.cancelFrame,
	});
	return { player, context, callbacks };
}

describe("AudioPlayer scheduling", () => {
	it("starts the first source after the initial buffer lead", () => {
		const { player, context } = makePlayer();
		player.feed(seconds(0.5));
		const [first] = context.sources;
		expect(first.startedAt).toBeCloseTo(0.12, 5);
		expect(player.started).toBe(true);
		expect(player.bufferedDuration).toBeCloseTo(0.5, 5);
	});

	it("respects a custom first buffer lead", () => {
		const { player, context } = makePlayer({ firstBufferMs: 100 });
		player.feed(seconds(0.5));
		expect([...context.sources][0].startedAt).toBeCloseTo(0.1, 5);
	});

	it("chains subsequent sources seamlessly without gaps", () => {
		const { player, context } = makePlayer();
		player.feed(seconds(0.5));
		player.feed(seconds(0.25));
		const [first, second] = [...context.sources];
		expect(second.startedAt).toBeCloseTo(first.startedAt + 0.5, 5);
		expect(player.bufferedDuration).toBeCloseTo(0.75, 5);
	});

	it("creates buffers with mono, frame length and the source sample rate", () => {
		const { player, context } = makePlayer();
		player.feed(samples(1200));
		const buffer = context.createdBuffers[0];
		expect(buffer.numberOfChannels).toBe(1);
		expect(buffer.length).toBe(1200);
		expect(buffer.sampleRate).toBe(TEST_SAMPLE_RATE);
	});

	it("ignores empty feeds without scheduling a source", () => {
		const { player, context } = makePlayer();
		player.feed(new Float32Array(0));
		expect(context.sources.size).toBe(0);
		expect(player.started).toBe(false);
	});

	it("reports buffered duration dropping as sources finish", () => {
		const { player, context } = makePlayer();
		player.feed(seconds(0.5));
		player.feed(seconds(0.5));
		expect(player.bufferedDuration).toBeCloseTo(1, 5);
		context.elapse(0.12 + 0.5);
		expect(player.bufferedDuration).toBeCloseTo(0.5, 5);
	});
});

describe("AudioPlayer underrun and lead rebuild", () => {
	it("counts an underrun and rebuilds the safety lead after the queue drains", () => {
		const { player, context } = makePlayer({ safetyLeadMs: 60 });
		player.feed(seconds(0.5));
		expect(player.bufferedDuration).toBeCloseTo(0.5, 5);
		context.elapse(0.12 + 0.5 + 0.05);
		expect(player.bufferedDuration).toBeCloseTo(0, 5);
		player.feed(seconds(0.5));
		const [second] = [...context.sources];
		expect(second).toBeDefined();
		expect(second.startedAt).toBeCloseTo(context.currentTime + 0.06, 5);
		expect(player.underrunCount).toBe(1);
	});

	it("does not count an underrun while the queue is still ahead of the clock", () => {
		const { player, context } = makePlayer();
		player.feed(seconds(1));
		context.elapse(0.2);
		player.feed(seconds(1));
		expect(player.underrunCount).toBe(0);
		expect([...context.sources][1].startedAt).toBeCloseTo(0.12 + 1, 5);
	});
});

describe("AudioPlayer end-of-stream lifecycle", () => {
	it("reaches finished only after the queued buffers drain", () => {
		const onFinished = vi.fn();
		const { player, context } = makePlayer({ callbacks: { onFinished } });
		player.feed(seconds(0.5));
		player.endOfStream();
		expect(player.finished).toBe(false);
		context.elapse(0.12 + 0.5);
		expect(player.finished).toBe(true);
		expect(onFinished).toHaveBeenCalledOnce();
	});

	it("fires onFinished immediately when end-of-stream arrives with no sources", () => {
		const onFinished = vi.fn();
		const { player } = makePlayer({ callbacks: { onFinished } });
		player.endOfStream();
		expect(player.finished).toBe(true);
		expect(onFinished).toHaveBeenCalledOnce();
	});

	it("emits onBufferConsumed once per drained source", () => {
		const onBufferConsumed = vi.fn();
		const { player, context } = makePlayer({ callbacks: { onBufferConsumed } });
		player.feed(seconds(0.25));
		player.feed(seconds(0.25));
		context.elapse(0.12 + 0.25);
		expect(onBufferConsumed).toHaveBeenCalledTimes(1);
		context.elapse(0.25);
		expect(onBufferConsumed).toHaveBeenCalledTimes(2);
	});

	it("fires onStarted exactly once for a multi-feed playback", () => {
		const onStarted = vi.fn();
		const { player } = makePlayer({ callbacks: { onStarted } });
		player.feed(seconds(0.25));
		player.feed(seconds(0.25));
		expect(onStarted).toHaveBeenCalledOnce();
	});
});

describe("AudioPlayer stop and dispose", () => {
	it("stops sources, clears the queue and detaches onended handlers", () => {
		const onFinished = vi.fn();
		const onBufferConsumed = vi.fn();
		const { player, context } = makePlayer({ callbacks: { onFinished, onBufferConsumed } });
		player.feed(seconds(0.5));
		player.stop();
		expect(player.bufferedDuration).toBe(0);
		expect(player.active).toBe(false);
		for (const source of context.sources) {
			expect(source.stopped).toBe(true);
			expect(source.onended).toBeNull();
		}
		context.elapse(1);
		expect(onFinished).not.toHaveBeenCalled();
		expect(onBufferConsumed).not.toHaveBeenCalled();
	});

	it("is idempotent", () => {
		const { player } = makePlayer();
		player.stop();
		player.stop();
		expect(player.bufferedDuration).toBe(0);
	});

	it("ignores feeds after stop", () => {
		const { player, context } = makePlayer();
		player.stop();
		player.feed(seconds(0.5));
		expect(context.sources.size).toBe(0);
	});

	it("ignores feeds and end-of-stream after dispose", () => {
		const onFinished = vi.fn();
		const { player } = makePlayer({ callbacks: { onFinished } });
		player.feed(seconds(0.25));
		player.dispose();
		player.feed(seconds(0.25));
		player.endOfStream();
		expect(player.finished).toBe(false);
		expect(onFinished).not.toHaveBeenCalled();
	});
});

describe("AudioPlayer level sampling", () => {
	it("pushes a smoothed level per animation frame and clamps to [0, 1]", () => {
		const frames = new FakeFrameLoop();
		const levels: number[] = [];
		const { player } = makePlayer({ callbacks: { onLevel: (level) => levels.push(level) }, frames });
		player.feed(samples(LEVEL_WINDOW, 1));
		expect(frames.pending).toBe(1);
		frames.runFrame();
		expect(levels).toHaveLength(1);
		expect(levels[0]).toBeCloseTo(LEVEL_SMOOTHING_ALPHA, 5);
		frames.runFrame();
		const expected = LEVEL_SMOOTHING_ALPHA + LEVEL_SMOOTHING_ALPHA * (1 - LEVEL_SMOOTHING_ALPHA);
		expect(levels[1]).toBeCloseTo(expected, 5);
	});

	it("pushes exactly 0 for a silent window", () => {
		const frames = new FakeFrameLoop();
		const levels: number[] = [];
		const { player } = makePlayer({ callbacks: { onLevel: (level) => levels.push(level) }, frames });
		player.feed(samples(LEVEL_WINDOW, 0));
		frames.runFrame();
		expect(levels[0]).toBe(0);
	});

	it("stops the loop once playback finishes", () => {
		const frames = new FakeFrameLoop();
		const { player, context } = makePlayer({ callbacks: { onLevel: () => {} }, frames });
		player.feed(seconds(0.25));
		player.endOfStream();
		context.elapse(0.12 + 0.25);
		expect(frames.pending).toBe(0);
	});

	it("cancels the loop on stop", () => {
		const frames = new FakeFrameLoop();
		const { player } = makePlayer({ callbacks: { onLevel: () => {} }, frames });
		player.feed(seconds(0.25));
		player.stop();
		expect(frames.pending).toBe(0);
	});

	it("does not sample when the loop is not injected", () => {
		const onLevel = vi.fn();
		const { player } = makePlayer({ callbacks: { onLevel } });
		player.feed(seconds(0.25));
		expect(onLevel).not.toHaveBeenCalled();
	});
});
