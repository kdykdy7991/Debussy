import type {
	LiveSpeechJobHandle,
	LiveSpeechStreamResult,
	OpenLiveSpeechStreamOptions,
} from "@earendil-works/pi-client";
import type { LiveSpeechJob } from "@earendil-works/pi-protocol";
import { describe, expect, it, vi } from "vitest";
import { AudioContextUnlocker } from "../src/features/voice/audio-context-unlocker.ts";
import type { AudioBufferLike, AudioContextLike, AudioSourceNodeLike } from "../src/features/voice/audio-player.ts";
import { LivePlaybackController } from "../src/features/voice/live-playback-controller.ts";
import type { LivePlaybackHooks, LivePlaybackState } from "../src/features/voice/live-types.ts";
import { PlaybackArbiter } from "../src/features/voice/playback-arbiter.ts";
import { encodeSamples, FakeAudioContext, FakeJobHandle, FakeSpeechSource, makeSpeechJob, streamFromChunks, TEST_FORMAT } from "./voice-test-support.ts";

type OpenMock = ReturnType<typeof vi.fn<(options: OpenLiveSpeechStreamOptions) => Promise<LiveSpeechStreamResult>>>;

function makeJob(overrides: Partial<LiveSpeechJob> = {}): LiveSpeechJob {
	return {
		id: "job-1",
		sessionId: "session-1",
		voiceProfileId: "default",
		status: "waiting_for_text",
		streamPath: "/api/pi/v4/live-speech/job-1/stream",
		createdAt: 1000,
		updatedAt: 1000,
		progress: { committedUtterances: 0, completedUtterances: 0, pendingCharacters: 0 },
		...overrides,
	};
}

class FakeSourceNode implements AudioSourceNodeLike {
	buffer: AudioBufferLike | null = null;
	onended: ((ev: Event) => void) | null = null;
	connect(): void {}
	disconnect(): void {}
	start(): void {}
	stop(): void {}
}

class FakeHandle implements LiveSpeechJobHandle {
	#job: LiveSpeechJob;
	readonly #listeners = new Set<(job: LiveSpeechJob) => void>();
	readonly cancelMock = vi.fn(async () => this.#job);
	constructor(job: LiveSpeechJob) {
		this.#job = job;
	}
	get job(): LiveSpeechJob {
		return this.#job;
	}
	subscribe(listener: (job: LiveSpeechJob) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	async cancel(): Promise<LiveSpeechJob> {
		return this.cancelMock();
	}
	emit(job: LiveSpeechJob): void {
		if (job.id !== this.#job.id) return;
		this.#job = job;
		for (const listener of this.#listeners) listener(job);
	}
}

function makeController(
	options: { context?: FakeAudioContext; openStream?: OpenMock; hooks?: LivePlaybackHooks } = {},
): {
	controller: LivePlaybackController;
	unlocker: AudioContextUnlocker;
	context: FakeAudioContext;
	openStream: OpenMock;
	hooks: Required<LivePlaybackHooks>;
} {
	const context = options.context ?? new FakeAudioContext();
	const unlocker = new AudioContextUnlocker({
		create: () => context,
		hasUserGesture: () => true,
	});
	// Pre-unlock so the controller sees a ready context.
	void unlocker.resume();
	const defaultStream = () =>
		Promise.resolve({
			format: TEST_FORMAT,
			body: streamFromChunks([encodeSamples([0.1, 0.2, 0.3, 0.4])]),
		});
	const openStream =
		options.openStream ??
		vi.fn<(o: OpenLiveSpeechStreamOptions) => Promise<LiveSpeechStreamResult>>().mockImplementation(defaultStream);
	const hooks: Required<LivePlaybackHooks> = {
		onStateChange: options.hooks?.onStateChange ?? vi.fn(),
		onError: options.hooks?.onError ?? vi.fn(),
		onPlaybackStart: options.hooks?.onPlaybackStart ?? vi.fn(),
		onPlaybackEnd: options.hooks?.onPlaybackEnd ?? vi.fn(),
	};
	const controller = new LivePlaybackController({
		unlocker,
		baseUrl: "http://127.0.0.1:8765",
		token: "secret",
		hooks,
		openStream,
	});
	return { controller, unlocker, context, openStream, hooks };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LivePlaybackController lifecycle", () => {
	it("opens the stream when the job enters streaming status", async () => {
		const handle = new FakeHandle(makeJob({ status: "waiting_for_text", updatedAt: 1 }));
		// Use a slow-controlled stream so the controller sits in `streaming`
		// long enough for the assertion. The default stream EOFs immediately.
		const stream = streamFromChunks([encodeSamples([0.5, -0.5, 0.25, -0.25])]);
		const openStream = vi
			.fn<(o: OpenLiveSpeechStreamOptions) => Promise<LiveSpeechStreamResult>>()
			.mockResolvedValue({
				format: TEST_FORMAT,
				body: stream,
			});
		const { controller } = makeController({ openStream });
		controller.attach(handle);
		expect(controller.state).toBe<LivePlaybackState>("waiting_for_text");
		handle.emit(makeJob({ status: "generating", updatedAt: 2 }));
		await flush();
		handle.emit(makeJob({ status: "streaming", updatedAt: 3 }));
		await flush();
		expect(openStream).toHaveBeenCalledTimes(1);
		// State may have already drained if the payload was tiny; just verify we
		// advanced past waiting_for_text and reached an audible phase.
		expect(["generating", "streaming", "draining", "ended"]).toContain(controller.state);
	});

	it("treats a 204 stream as a completed job with no audio", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const openStream = vi.fn<() => Promise<LiveSpeechStreamResult>>().mockResolvedValue(null);
		const { controller, hooks } = makeController({ openStream });
		controller.attach(handle);
		await flush();
		// Job will also receive completed; #handleJob must remain idempotent.
		handle.emit(makeJob({ status: "completed", updatedAt: 2 }));
		await flush();
		expect(controller.state).toBe<LivePlaybackState>("ended");
		expect(hooks.onPlaybackEnd).toHaveBeenCalledWith("completed");
		expect(hooks.onError).not.toHaveBeenCalled();
	});

	it("fails when the server returns an HTTP error", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const openStream = vi.fn<() => Promise<LiveSpeechStreamResult>>().mockRejectedValue(new Error("http 401"));
		const { controller, hooks } = makeController({ openStream });
		controller.attach(handle);
		await flush();
		expect(controller.state).toBe<LivePlaybackState>("error");
		expect(hooks.onError).toHaveBeenCalled();
		expect(hooks.onPlaybackEnd).toHaveBeenCalledWith("error");
	});

	it("dispatches cancel_live_speech when stop() is invoked", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const stream = streamFromChunks([encodeSamples([0.1, 0.2, 0.3, 0.4])]);
		const openStream = vi.fn<() => Promise<LiveSpeechStreamResult>>().mockResolvedValue({
			format: TEST_FORMAT,
			body: stream,
		});
		const { controller } = makeController({ openStream });
		controller.attach(handle);
		await flush();
		controller.stop();
		expect(handle.cancelMock).toHaveBeenCalledOnce();
		expect(controller.state).toBe<LivePlaybackState>("stopped");
	});

	it("does NOT dispatch cancel_live_speech on natural completion (server is closing)", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const stream = streamFromChunks([encodeSamples([0.1, 0.2, 0.3, 0.4])]);
		const openStream = vi.fn<() => Promise<LiveSpeechStreamResult>>().mockResolvedValue({
			format: TEST_FORMAT,
			body: stream,
		});
		const { controller, context } = makeController({ openStream });
		controller.attach(handle);
		await flush();
		// Drive the clock past the queued audio so the source's `ended` fires.
		context.elapse(2);
		await flush();
		expect(controller.state).toBe<LivePlaybackState>("ended");
		expect(handle.cancelMock).not.toHaveBeenCalled();
	});

	it("does NOT dispatch cancel_live_speech on 204 (no speakable text)", async () => {
		const handle = new FakeHandle(makeJob({ status: "waiting_for_text", updatedAt: 1 }));
		const openStream = vi.fn<() => Promise<LiveSpeechStreamResult>>().mockResolvedValue(null);
		const { controller } = makeController({ openStream });
		controller.attach(handle);
		await flush();
		expect(controller.state).toBe<LivePlaybackState>("ended");
		expect(handle.cancelMock).not.toHaveBeenCalled();
	});

	it("does NOT dispatch cancel_live_speech on session change (server cleanup handles it)", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const stream = streamFromChunks([encodeSamples([0.1, 0.2, 0.3, 0.4])]);
		const openStream = vi.fn<() => Promise<LiveSpeechStreamResult>>().mockResolvedValue({
			format: TEST_FORMAT,
			body: stream,
		});
		const { controller } = makeController({ openStream });
		controller.attach(handle);
		await flush();
		controller.handleSessionChanged();
		expect(controller.state).toBe<LivePlaybackState>("stopped");
		expect(handle.cancelMock).not.toHaveBeenCalled();
	});

	it("does NOT dispatch cancel_live_speech on disconnect (server cleanup handles it)", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const stream = streamFromChunks([encodeSamples([0.1, 0.2, 0.3, 0.4])]);
		const openStream = vi.fn<() => Promise<LiveSpeechStreamResult>>().mockResolvedValue({
			format: TEST_FORMAT,
			body: stream,
		});
		const { controller } = makeController({ openStream });
		controller.attach(handle);
		await flush();
		controller.handleDisconnected();
		expect(handle.cancelMock).not.toHaveBeenCalled();
	});

	it("tears down playback when the session changes", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const { controller } = makeController();
		controller.attach(handle);
		await flush();
		controller.handleSessionChanged();
		expect(controller.state).toBe<LivePlaybackState>("stopped");
	});

	it("ignores late job events after a fresh attach", async () => {
		const oldHandle = new FakeHandle(makeJob({ id: "old", status: "waiting_for_text", updatedAt: 1 }));
		const newHandle = new FakeHandle(makeJob({ id: "new", status: "waiting_for_text", updatedAt: 2 }));
		const { controller } = makeController();
		controller.attach(oldHandle);
		await flush();
		// Re-attach to the new handle before any stream is opened: the
		// old subscription was unsubscribed in teardown so a late event
		// for the old handle id can no longer reach the controller.
		controller.attach(newHandle);
		await flush();
		oldHandle.emit(makeJob({ id: "old", status: "completed", updatedAt: 3 }));
		await flush();
		// The controller is bound to the new job id; old events must be ignored.
		expect(controller.jobId).toBe("new");
		expect(controller.state).not.toBe<LivePlaybackState>("idle");
	});

	it("stops playback on disconnect without dispatching cancel", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const { controller } = makeController();
		controller.attach(handle);
		await flush();
		controller.handleDisconnected();
		expect(controller.state).toBe<LivePlaybackState>("stopped");
		expect(handle.cancelMock).not.toHaveBeenCalled();
	});

	it("treats a server-reported `failed` job as an error state", async () => {
		const handle = new FakeHandle(makeJob({ status: "streaming", updatedAt: 1 }));
		const stream = streamFromChunks([encodeSamples([0.1, 0.2, 0.3, 0.4])]);
		const openStream = vi.fn<() => Promise<LiveSpeechStreamResult>>().mockResolvedValue({
			format: TEST_FORMAT,
			body: stream,
		});
		const { controller, hooks } = makeController({ openStream });
		controller.attach(handle);
		await flush();
		handle.emit(
			makeJob({ status: "failed", updatedAt: 2, error: { code: "speech_generation_failed", message: "down" } }),
		);
		await flush();
		expect(controller.state).toBe<LivePlaybackState>("error");
		expect(hooks.onError).toHaveBeenCalled();
	});

	it("ignores stale job IDs from late dispatches", async () => {
		const handle = new FakeHandle(makeJob({ id: "owner", status: "streaming", updatedAt: 1 }));
		let captured: ((job: LiveSpeechJob) => void) | undefined;
		const wrappedHandle: LiveSpeechJobHandle = {
			get job() {
				return handle.job;
			},
			subscribe(listener) {
				captured = listener;
				return handle.subscribe(listener);
			},
			cancel: () => handle.cancel(),
		};
		const { controller } = makeController();
		controller.attach(wrappedHandle);
		await flush();
		// Hand-crafted event with a different job id must not advance state.
		captured?.(makeJob({ id: "intruder", status: "completed", updatedAt: 5 }));
		await flush();
		expect(controller.state).not.toBe<LivePlaybackState>("ended");
	});

	it("disposes without throwing when no playback has started", () => {
		const { controller } = makeController();
		expect(() => controller.dispose()).not.toThrow();
		expect(controller.state).toBe<LivePlaybackState>("stopped");
	});

	it("does not let an old stream opener clear the new operation state", async () => {
		let resolveOld: ((stream: LiveSpeechStreamResult) => void) | undefined;
		const oldOpen = new Promise<LiveSpeechStreamResult>((resolve) => {
			resolveOld = resolve;
		});
		const holdNewOpen = new Promise<LiveSpeechStreamResult>(() => {});
		const openStream = vi
			.fn<(o: OpenLiveSpeechStreamOptions) => Promise<LiveSpeechStreamResult>>()
			.mockReturnValueOnce(oldOpen)
			.mockReturnValueOnce(holdNewOpen);
		const oldHandle = new FakeHandle(makeJob({ id: "old", status: "waiting_for_text" }));
		const newHandle = new FakeHandle(makeJob({ id: "new", status: "waiting_for_text" }));
		const { controller } = makeController({ openStream });
		controller.attach(oldHandle);
		controller.attach(newHandle);
		resolveOld?.(null);
		await flush();
		newHandle.emit(makeJob({ id: "new", status: "generating" }));
		expect(openStream).toHaveBeenCalledTimes(2);
	});

	it("arbiter stops live before manual playback and shares one AudioContext", async () => {
		const source = new FakeSpeechSource();
		source.startSpeechMock.mockResolvedValue(new FakeJobHandle(makeSpeechJob({ status: "queued" })));
		const context = new FakeAudioContext();
		let contextCreates = 0;
		const arbiter = new PlaybackArbiter({
			source,
			baseUrl: "http://127.0.0.1:8765",
			createAudioContext: () => {
				contextCreates += 1;
				return context;
			},
			openLiveStream: () => new Promise<LiveSpeechStreamResult>(() => {}),
			openManualStream: async () => ({ format: TEST_FORMAT, body: streamFromChunks([]) }),
		});
		await arbiter.resumeAudioContext();
		const liveHandle = new FakeHandle(makeJob({ status: "waiting_for_text" }));
		arbiter.startLive(liveHandle);
		await arbiter.startManual("session-1", "message-1");
		expect(liveHandle.cancelMock).toHaveBeenCalledOnce();
		expect(contextCreates).toBe(1);
	});
});
