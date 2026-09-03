export interface Pcm16Player {
	prepare(): void;
	enqueue(pcm: Uint8Array): void;
	stop(): Promise<void>;
}

/** Schedules adjacent Web Audio buffers on one timeline to avoid frame gaps. */
export class WebAudioPcm16Player implements Pcm16Player {
	private context: AudioContext | undefined;
	private nextStartTime = 0;
	private readonly sources = new Set<AudioBufferSourceNode>();

	prepare(): void {
		if (this.context === undefined || this.context.state === "closed") {
			this.context = new AudioContext({ sampleRate: 16000 });
			this.nextStartTime = 0;
		}
		void this.context.resume().catch(() => {});
	}

	enqueue(pcm: Uint8Array): void {
		if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) return;
		this.prepare();
		const context = this.context;
		if (context === undefined) return;
		const samples = pcm.byteLength / 2;
		const audioBuffer = context.createBuffer(1, samples, 16000);
		const channel = audioBuffer.getChannelData(0);
		const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		for (let index = 0; index < samples; index += 1) channel[index] = view.getInt16(index * 2, true) / 32768;
		const source = context.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(context.destination);
		const startsAt = Math.max(context.currentTime, this.nextStartTime);
		this.nextStartTime = startsAt + audioBuffer.duration;
		this.sources.add(source);
		source.onended = () => {
			this.sources.delete(source);
			source.disconnect();
		};
		source.start(startsAt);
	}

	async stop(): Promise<void> {
		for (const source of this.sources) {
			try {
				source.stop();
			} catch {
				// Already ended.
			}
			source.disconnect();
		}
		this.sources.clear();
		this.nextStartTime = 0;
		const context = this.context;
		this.context = undefined;
		if (context !== undefined && context.state !== "closed") await context.close().catch(() => {});
	}
}
