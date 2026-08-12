import type { OpenSpeechStreamOptions, SpeechStream } from "@earendil-works/pi-client";
import { describe, expect, it, vi } from "vitest";
import { SpeechController } from "../src/features/voice/speech-controller.ts";
import type { SpeechControllerHooks } from "../src/features/voice/types.ts";
import {
	ControlledStream,
	encodeSamples,
	FakeAudioContext,
	FakeFrameLoop,
	FakeJobHandle,
	FakeSpeechSource,
	makeSpeechJob,
	streamFromChunks,
	TEST_FORMAT,
} from "./voice-test-support.ts";

type StreamOpenMock = ReturnType<typeof vi.fn<(options: OpenSpeechStreamOptions) => Promise<SpeechStream>>>;

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function streamMockFor(body: ReadableStream<Uint8Array>): StreamOpenMock {
	const mock = vi.fn<(options: OpenSpeechStreamOptions) => Promise<SpeechStream>>();
	mock.mockResolvedValue({ format: TEST_FORMAT, body });
	return mock;
}

function preloadedStream(bytes: Uint8Array): SpeechStream {
	return { format: TEST_FORMAT, body: streamFromChunks([bytes]) };
}

function makeController(
	options: {
		source?: FakeSpeechSource;
		context?: FakeAudioContext;
		openStreamMock?: StreamOpenMock;
		hooks?: SpeechControllerHooks;
		requestFrame?: (callback: () => void) => number;
		cancelFrame?: (id: number) => void;
		maxBufferMs?: number;
		targetBufferMs?: number;
	} = {},
): {
	controller: SpeechController;
	source: FakeSpeechSource;
	context: FakeAudioContext;
	openStreamMock: StreamOpenMock;
	hooks: Required<SpeechControllerHooks>;
} {
	const source = options.source ?? new FakeSpeechSource();
	const context = options.context ?? new FakeAudioContext();
	const openStreamMock =
		options.openStreamMock ?? vi.fn<(options: OpenSpeechStreamOptions) => Promise<SpeechStream>>();
	const hooks: Required<SpeechControllerHooks> = {
		onPlaybackStart: options.hooks?.onPlaybackStart ?? vi.fn(),
		onAudioLevel: options.hooks?.onAudioLevel ?? vi.fn(),
		onPlaybackEnd: options.hooks?.onPlaybackEnd ?? vi.fn(),
	};
	const controller = new SpeechController({
		source,
		baseUrl: "http://127.0.0.1:8765",
		token: "secret",
		hooks,
		createAudioContext: () => context,
		openStream: openStreamMock,
		requestFrame: options.requestFrame,
		cancelFrame: options.cancelFrame,
		maxBufferMs: options.maxBufferMs,
		targetBufferMs: options.targetBufferMs,
	});
	return { controller, source, context, openStreamMock, hooks };
}

describe("SpeechController capability", () => {
	it("hides speech when the server does not advertise a voice capability", () => {
		const { controller } = makeController();
		expect(controller.voiceAvailable).toBe(false);
	});

	it("advertises speech when the server snapshot has a voice capability", () => {
		const source = new FakeSpeechSource();
		source.snapshot = {
			serverId: "server-1",
			protocolVersion: 4,
			revision: 1,
			sessions: [],
			models: [],
			voice: {
				available: true,
				live: false,
				defaultProfile: "default",
				profiles: [{ id: "default", name: "默认" }],
			},
		};
		const { controller } = makeController({ source });
		expect(controller.voiceAvailable).toBe(true);
	});
});

describe("SpeechController playback lifecycle", () => {
	it("plays a stream end-to-end and reports completed", async () => {
		const stream = new ControlledStream();
		const { controller, source, context, hooks } = makeController({
			openStreamMock: streamMockFor(stream.readable),
		});
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);

		const speaking = controller.speak("session-1", "message-1");
		expect(controller.state).toBe("requesting");
		await speaking;
		expect(controller.state).toBe("buffering");
		await flush();
		stream.pushChunk(encodeSamples(Array(12000).fill(0.5)));
		await flush();
		expect(controller.state).toBe("playing");
		expect(hooks.onPlaybackStart).toHaveBeenCalledOnce();
		stream.pushEof();
		await flush();
		expect(controller.state).toBe("draining");
		context.elapse(0.62);
		await flush();
		expect(controller.state).toBe("ended");
		expect(hooks.onPlaybackEnd).toHaveBeenCalledWith("completed");
	});

	it("sends the bearer token and stream path to the stream opener", async () => {
		const stream = new ControlledStream();
		const { controller, source, openStreamMock } = makeController({
			openStreamMock: streamMockFor(stream.readable),
		});
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		void controller.speak("session-1", "message-1");
		await flush();
		expect(openStreamMock).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: "http://127.0.0.1:8765",
				streamPath: "/api/pi/v3/speech/job-1/stream",
				token: "secret",
			}),
		);
	});

	it("pushes audio levels when a frame loop is injected", async () => {
		const frames = new FakeFrameLoop();
		const levels: number[] = [];
		const { controller, source, openStreamMock } = makeController({
			hooks: { onAudioLevel: (level) => levels.push(level) },
			requestFrame: frames.requestFrame,
			cancelFrame: frames.cancelFrame,
		});
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		openStreamMock.mockResolvedValue(preloadedStream(encodeSamples(Array(12000).fill(0.5))));
		void controller.speak("s", "m");
		await flush();
		expect(levels).toHaveLength(0);
		frames.runFrame();
		expect(levels.length).toBeGreaterThan(0);
		expect(levels.every((level) => level >= 0 && level <= 1)).toBe(true);
	});
});

describe("SpeechController job events", () => {
	it("fails when the job reports failed", async () => {
		const { controller, source, openStreamMock } = makeController();
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		openStreamMock.mockResolvedValue(preloadedStream(encodeSamples(Array(12000).fill(0.5))));
		void controller.speak("s", "m");
		await flush();
		handle.emit(
			makeSpeechJob({ status: "failed", error: { code: "speech_generation_failed", message: "生成失败" } }),
		);
		expect(controller.state).toBe("error");
		expect(controller.error).toContain("生成失败");
	});

	it("treats an unexpected cancellation as an error", async () => {
		const { controller, source, openStreamMock } = makeController();
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		openStreamMock.mockResolvedValue(preloadedStream(encodeSamples(Array(12000).fill(0.5))));
		void controller.speak("s", "m");
		await flush();
		handle.emit(makeSpeechJob({ status: "cancelled" }));
		expect(controller.state).toBe("error");
	});

	it("ignores job events for a different job", async () => {
		const { controller, source, openStreamMock } = makeController();
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		openStreamMock.mockResolvedValue(preloadedStream(encodeSamples(Array(12000).fill(0.5))));
		void controller.speak("s", "m");
		await flush();
		handle.emit(
			makeSpeechJob({
				id: "other-job",
				status: "failed",
				error: { code: "speech_generation_failed", message: "x" },
			}),
		);
		expect(controller.state).not.toBe("error");
	});
});

describe("SpeechController stop and cleanup", () => {
	it("stops playback, cancels the job and reports stopped", async () => {
		const stream = new ControlledStream();
		const { controller, source, context, hooks } = makeController({
			openStreamMock: streamMockFor(stream.readable),
		});
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		void controller.speak("s", "m");
		await flush();
		stream.pushChunk(encodeSamples(Array(12000).fill(0.5)));
		await flush();
		expect(controller.state).toBe("playing");

		controller.stop();
		expect(controller.state).toBe("stopped");
		expect(handle.cancelMock).toHaveBeenCalledOnce();
		expect(hooks.onPlaybackEnd).toHaveBeenCalledWith("stopped");

		context.elapse(5);
		await flush();
		expect(hooks.onPlaybackEnd).toHaveBeenCalledTimes(1);
		expect(controller.state).toBe("stopped");
	});

	it("is a no-op when idle", () => {
		const { controller } = makeController();
		controller.stop();
		expect(controller.state).toBe("idle");
	});

	it("stops silently when the active session changes", async () => {
		const { controller, source, openStreamMock, hooks } = makeController();
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		openStreamMock.mockResolvedValue(preloadedStream(encodeSamples(Array(12000).fill(0.5))));
		void controller.speak("s", "m");
		await flush();
		controller.handleSessionChanged();
		expect(controller.state).toBe("stopped");
		expect(hooks.onPlaybackEnd).not.toHaveBeenCalled();
	});

	it("stops on disconnect", async () => {
		const { controller, source, openStreamMock } = makeController();
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		openStreamMock.mockResolvedValue(preloadedStream(encodeSamples(Array(12000).fill(0.5))));
		void controller.speak("s", "m");
		await flush();
		controller.handleDisconnected();
		expect(controller.state).toBe("stopped");
	});

	it("cancels the previous job when a new message starts", async () => {
		const stream1 = new ControlledStream();
		const stream2 = new ControlledStream();
		const openStreamMock = vi.fn<(options: OpenSpeechStreamOptions) => Promise<SpeechStream>>();
		openStreamMock.mockResolvedValueOnce({ format: TEST_FORMAT, body: stream1.readable });
		openStreamMock.mockResolvedValueOnce({ format: TEST_FORMAT, body: stream2.readable });
		const { controller, source } = makeController({ openStreamMock });
		const handle1 = new FakeJobHandle(makeSpeechJob({ id: "job-1", messageId: "m1", status: "queued" }));
		const handle2 = new FakeJobHandle(makeSpeechJob({ id: "job-2", messageId: "m2", status: "queued" }));
		source.startSpeechMock.mockResolvedValueOnce(handle1).mockResolvedValueOnce(handle2);

		void controller.speak("s", "m1");
		await flush();
		stream1.pushChunk(encodeSamples(Array(12000).fill(0.5)));
		await flush();
		expect(controller.state).toBe("playing");

		void controller.speak("s", "m2");
		await flush();
		expect(controller.activeMessageId).toBe("m2");
		expect(handle1.cancelMock).toHaveBeenCalledOnce();
	});

	it("keeps only the last request when speak is called rapidly", async () => {
		const stream = new ControlledStream();
		const { controller, source } = makeController({
			openStreamMock: streamMockFor(stream.readable),
		});
		const handle1 = new FakeJobHandle(makeSpeechJob({ id: "job-1", messageId: "m1" }));
		const handle2 = new FakeJobHandle(makeSpeechJob({ id: "job-2", messageId: "m2" }));
		source.startSpeechMock.mockResolvedValueOnce(handle1).mockResolvedValueOnce(handle2);

		const first = controller.speak("s", "m1");
		const second = controller.speak("s", "m2");
		await Promise.all([first, second]);
		await flush();
		expect(controller.activeMessageId).toBe("m2");
		stream.pushChunk(encodeSamples(Array(12000).fill(0.5)));
		await flush();
		expect(controller.state).toBe("playing");
	});
});

describe("SpeechController backpressure", () => {
	it("pauses reading above the max buffer and resumes after drain", async () => {
		const stream = new ControlledStream();
		const { controller, source, context } = makeController({
			openStreamMock: streamMockFor(stream.readable),
			maxBufferMs: 500,
			targetBufferMs: 250,
		});
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		void controller.speak("s", "m");
		await flush();
		stream.pushChunk(encodeSamples(Array(24000).fill(0.5))); // 1 second exceeds the 500ms max buffer.
		await flush();
		expect(controller.state).toBe("playing");
		// The pump is parked waiting for the buffer to drop below target.
		context.elapse(1.12);
		await flush();
		stream.pushEof();
		await flush();
		expect(controller.state).toBe("ended");
	});
});

describe("SpeechController error handling", () => {
	it("surfaces start_speech failures", async () => {
		const { controller, source } = makeController();
		source.startSpeechMock.mockRejectedValue(new Error("会话忙"));
		await controller.speak("s", "m");
		expect(controller.state).toBe("error");
		expect(controller.error).toContain("无法开始朗读");
	});

	it("surfaces stream open failures", async () => {
		const { controller, source, openStreamMock } = makeController();
		source.startSpeechMock.mockResolvedValue(new FakeJobHandle(makeSpeechJob({ status: "queued" })));
		openStreamMock.mockRejectedValue(new Error("connection refused"));
		void controller.speak("s", "m");
		await flush();
		expect(controller.state).toBe("error");
		expect(controller.error).toContain("语音服务不可用");
	});

	it("reports a recoverable error when the AudioContext cannot resume", async () => {
		const context = new FakeAudioContext();
		context.resumeMock.mockRejectedValue(new Error("NotAllowedError"));
		const { controller, source, openStreamMock } = makeController({ context });
		source.startSpeechMock.mockResolvedValue(new FakeJobHandle(makeSpeechJob({ status: "queued" })));
		openStreamMock.mockResolvedValue(preloadedStream(encodeSamples(Array(12000).fill(0.5))));
		void controller.speak("s", "m");
		await flush();
		expect(controller.state).toBe("error");
		expect(controller.error).toContain("自动播放");
	});

	it("fails on truncated PCM at EOF", async () => {
		const { controller, source, openStreamMock } = makeController();
		source.startSpeechMock.mockResolvedValue(new FakeJobHandle(makeSpeechJob({ status: "queued" })));
		openStreamMock.mockResolvedValue({ format: TEST_FORMAT, body: streamFromChunks([new Uint8Array([1, 2, 3])]) });
		void controller.speak("s", "m");
		await flush();
		expect(controller.state).toBe("error");
		expect(controller.error).toContain("truncated");
	});
});

describe("SpeechController disposal", () => {
	it("cleans up playback and stops delivering hooks", async () => {
		const { controller, source, openStreamMock, hooks } = makeController();
		const handle = new FakeJobHandle(makeSpeechJob({ status: "queued" }));
		source.startSpeechMock.mockResolvedValue(handle);
		openStreamMock.mockResolvedValue(preloadedStream(encodeSamples(Array(12000).fill(0.5))));
		void controller.speak("s", "m");
		await flush();
		controller.dispose();
		expect(controller.state).toBe("stopped");
		expect(hooks.onPlaybackEnd).not.toHaveBeenCalled();
	});
});
