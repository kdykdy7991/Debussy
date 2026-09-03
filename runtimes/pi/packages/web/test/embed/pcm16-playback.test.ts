import { afterEach, describe, expect, it, vi } from "vitest";
import { WebAudioPcm16Player } from "../../src/embed/pcm16-playback.ts";

class FakeSource {
	buffer: { duration: number } | null = null;
	onended: (() => void) | null = null;
	readonly starts: number[] = [];
	stop = vi.fn();
	connect = vi.fn();
	disconnect = vi.fn();
	start(at: number): void {
		this.starts.push(at);
	}
}

class FakeAudioContext {
	state: AudioContextState = "running";
	currentTime = 10;
	destination = {} as AudioDestinationNode;
	readonly sources: FakeSource[] = [];
	readonly channels: Float32Array[] = [];
	resume = vi.fn(async () => {});
	close = vi.fn(async () => {
		this.state = "closed";
	});
	createBuffer(_channels: number, samples: number, rate: number) {
		const channel = new Float32Array(samples);
		this.channels.push(channel);
		return { duration: samples / rate, getChannelData: () => channel };
	}
	createBufferSource(): FakeSource {
		const source = new FakeSource();
		this.sources.push(source);
		return source;
	}
}

afterEach(() => vi.unstubAllGlobals());

describe("WebAudioPcm16Player", () => {
	it("decodes little-endian PCM and schedules chunks on one continuous timeline", async () => {
		let context: FakeAudioContext | undefined;
		vi.stubGlobal(
			"AudioContext",
			class extends FakeAudioContext {
				constructor() {
					super();
					context = this;
				}
			},
		);
		const player = new WebAudioPcm16Player();
		player.prepare();
		expect(context).toBeDefined();
		const activeContext = context!;
		player.enqueue(new Uint8Array([0, 128, 255, 127]));
		player.enqueue(new Uint8Array([0, 0, 0, 0]));
		expect([...activeContext.channels[0]!]).toEqual([-1, 32767 / 32768]);
		expect(activeContext.sources[0]!.starts).toEqual([10]);
		expect(activeContext.sources[1]!.starts).toEqual([10 + 2 / 16000]);
		await player.stop();
		expect(activeContext.sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
		expect(activeContext.close).toHaveBeenCalledOnce();
	});
});
