import type { SpeechJobHandle, StartSpeechOptions } from "@earendil-works/pi-client";
import type { ServerSnapshot, SpeechJob } from "@earendil-works/pi-protocol";
import { vi } from "vitest";
import type { AudioBufferLike, AudioContextLike, AudioSourceNodeLike } from "../src/features/voice/audio-player.ts";
import type { SpeechControllerSource } from "../src/features/voice/types.ts";

export const TEST_SAMPLE_RATE = 24000;
export const TEST_FORMAT = { encoding: "pcm_f32le", sampleRate: TEST_SAMPLE_RATE, channels: 1 } as const;
export const TEST_STREAM_PATH = "/api/pi/v3/speech/job-1/stream";

export function makeSpeechJob(overrides: Partial<SpeechJob> = {}): SpeechJob {
	return {
		id: "job-1",
		sessionId: "session-1",
		messageId: "message-1",
		voiceProfileId: "default",
		status: "queued",
		streamPath: TEST_STREAM_PATH,
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

export function seconds(count: number): Float32Array {
	return new Float32Array(Math.round(count * TEST_SAMPLE_RATE)).fill(0);
}

export function encodeSamples(samples: number[]): Uint8Array {
	const bytes = new Uint8Array(samples.length * 4);
	const view = new DataView(bytes.buffer);
	samples.forEach((sample, index) => {
		view.setFloat32(index * 4, sample, true);
	});
	return bytes;
}

export function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	});
}

/**
 * A stream whose chunks the test delivers explicitly, so playback can be
 * stepped through without racing the event loop.
 */
export class ControlledStream {
	readonly readable: ReadableStream<Uint8Array>;
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	#closed = false;

	constructor() {
		this.readable = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.#controller = controller;
			},
		});
	}

	pushChunk(bytes: Uint8Array): void {
		if (!this.#closed) this.#controller?.enqueue(bytes);
	}

	pushEof(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#controller?.close();
	}
}

export class FakeSourceNode implements AudioSourceNodeLike {
	buffer: AudioBufferLike | null = null;
	onended: ((ev: Event) => void) | null = null;
	startedAt = -1;
	stopped = false;
	disconnected = false;
	connect(): void {}
	disconnect(): void {
		this.disconnected = true;
	}
	start(when = 0): void {
		this.startedAt = when;
	}
	stop(): void {
		this.stopped = true;
	}
}

export class FakeAudioContext implements AudioContextLike {
	currentTime = 0;
	readonly destination = {};
	readonly sources = new Set<FakeSourceNode>();
	readonly createdBuffers: AudioBufferLike[] = [];
	readonly resumeMock = vi.fn(async () => {});

	async resume(): Promise<void> {
		await this.resumeMock();
	}

	createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike {
		const buffer: AudioBufferLike = {
			length,
			numberOfChannels,
			sampleRate,
			duration: length / sampleRate,
			getChannelData: () => new Float32Array(length),
		};
		this.createdBuffers.push(buffer);
		return buffer;
	}

	createBufferSource(): FakeSourceNode {
		const source = new FakeSourceNode();
		this.sources.add(source);
		return source;
	}

	/** Advances the clock and ends any source whose scheduled lifetime is complete. */
	elapse(seconds: number): void {
		this.currentTime += seconds;
		for (const source of [...this.sources]) {
			if (
				source.buffer &&
				source.startedAt >= 0 &&
				!source.stopped &&
				this.currentTime >= source.startedAt + source.buffer.duration
			) {
				this.sources.delete(source);
				source.onended?.(new Event("ended"));
			}
		}
	}
}

export class FakeFrameLoop {
	#callbacks = new Map<number, () => void>();
	#nextId = 1;
	readonly requestFrame = (callback: () => void): number => {
		const id = this.#nextId++;
		this.#callbacks.set(id, callback);
		return id;
	};
	readonly cancelFrame = (id: number): void => {
		this.#callbacks.delete(id);
	};
	get pending(): number {
		return this.#callbacks.size;
	}
	runFrame(): void {
		const callbacks = [...this.#callbacks.values()];
		this.#callbacks.clear();
		callbacks.forEach((callback) => {
			callback();
		});
	}
}

export class FakeJobHandle implements SpeechJobHandle {
	#job: SpeechJob;
	readonly #listeners = new Set<(job: SpeechJob) => void>();
	readonly cancelMock = vi.fn(async () => this.#job);
	readonly subscribed = vi.fn(() => {});

	constructor(job: SpeechJob) {
		this.#job = job;
	}

	get job(): SpeechJob {
		return this.#job;
	}

	subscribe(listener: (job: SpeechJob) => void): () => void {
		this.#listeners.add(listener);
		this.subscribed();
		return () => this.#listeners.delete(listener);
	}

	cancel(): Promise<SpeechJob> {
		return this.cancelMock();
	}

	emit(job: SpeechJob): void {
		if (job.id === this.#job.id) this.#job = job;
		for (const listener of this.#listeners) listener(job);
	}
}

export class FakeSpeechSource implements SpeechControllerSource {
	snapshot: ServerSnapshot | undefined;
	readonly startSpeechMock = vi.fn<() => Promise<SpeechJobHandle>>();

	startSpeech(_options: StartSpeechOptions): Promise<SpeechJobHandle> {
		return this.startSpeechMock();
	}
}
