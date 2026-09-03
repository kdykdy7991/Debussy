/** Browser microphone capture for the frozen VoxEMW PCM contract. */

export interface MicrophonePcmCapture {
	start(onChunk: (pcm: Uint8Array) => void): void;
	stop(): Promise<void>;
}

const WORKLET_SOURCE = `
class VoxemwPcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.position = 0;
    this.input = [];
    this.output = new Int16Array(320);
    this.outputLength = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i += 1) {
      let mono = 0;
      for (let c = 0; c < channels.length; c += 1) mono += channels[c][i] || 0;
      this.input.push(mono / channels.length);
    }
    while (this.position + 1 < this.input.length) {
      const base = Math.floor(this.position);
      const fraction = this.position - base;
      const sample = this.input[base] + (this.input[base + 1] - this.input[base]) * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.output[this.outputLength++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      if (this.outputLength === 320) {
        const buffer = this.output.buffer;
        this.port.postMessage(buffer, [buffer]);
        this.output = new Int16Array(320);
        this.outputLength = 0;
      }
      this.position += this.step;
    }
    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.input.splice(0, consumed);
      this.position -= consumed;
    }
    return true;
  }
}
registerProcessor("voxemw-pcm16", VoxemwPcm16Processor);
`;

export async function openMicrophonePcmCapture(): Promise<MicrophonePcmCapture> {
	if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风采集");
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
	});
	let context: AudioContext | undefined;
	let source: MediaStreamAudioSourceNode | undefined;
	let node: AudioWorkletNode | undefined;
	let moduleUrl: string | undefined;
	try {
		context = new AudioContext({ sampleRate: 16000 });
		moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
		await context.audioWorklet.addModule(moduleUrl);
		source = context.createMediaStreamSource(stream);
		node = new AudioWorkletNode(context, "voxemw-pcm16");
		const captureContext = context;
		const captureSource = source;
		const captureNode = node;
		const captureModuleUrl = moduleUrl;
		let stopped = false;
		return {
			start(onChunk) {
				captureNode.port.onmessage = (event: MessageEvent<unknown>) => {
					if (!stopped && event.data instanceof ArrayBuffer) onChunk(new Uint8Array(event.data));
				};
				captureSource.connect(captureNode);
				captureNode.connect(captureContext.destination);
			},
			async stop() {
				if (stopped) return;
				stopped = true;
				captureNode.port.onmessage = null;
				captureSource.disconnect();
				captureNode.disconnect();
				for (const track of stream.getTracks()) track.stop();
				URL.revokeObjectURL(captureModuleUrl);
				await captureContext.close();
			},
		};
	} catch (error) {
		for (const track of stream.getTracks()) track.stop();
		if (moduleUrl !== undefined) URL.revokeObjectURL(moduleUrl);
		if (context !== undefined) await context.close();
		throw error;
	}
}
