import { describe, expect, it, vi } from "vitest";
import type { MicrophonePcmCapture } from "../../src/embed/microphone-pcm-capture.ts";
import { VoiceAsrSession, type VoiceAsrState } from "../../src/embed/voice-asr-session.ts";

function fixture() {
	const sent: string[] = [];
	const states: VoiceAsrState[] = [];
	let onChunk: ((chunk: Uint8Array) => void) | undefined;
	const capture: MicrophonePcmCapture = {
		start: vi.fn((callback) => {
			onChunk = callback;
		}),
		stop: vi.fn(async () => {}),
	};
	const session = new VoiceAsrSession({
		send: (frame) => {
			sent.push(frame);
			return true;
		},
		onState: (state) => states.push(state),
		openCapture: vi.fn(async () => capture),
		createRequestId: () => "asr_test",
	});
	return { session, capture, sent, states, emit: (chunk: Uint8Array) => onChunk?.(chunk) };
}

describe("VoiceAsrSession", () => {
	it("sends start followed by contiguous PCM16LE audio sequences", async () => {
		const f = fixture();
		await f.session.start();
		f.emit(new Uint8Array([0, 128, 255, 127]));
		f.emit(new Uint8Array(640));
		expect(f.sent.map((frame) => JSON.parse(frame))).toEqual([
			{ type: "asr.start", request_id: "asr_test" },
			{ type: "asr.audio", request_id: "asr_test", sequence: 0, audio: "AID/fw==" },
			{ type: "asr.audio", request_id: "asr_test", sequence: 1, audio: expect.any(String) },
		]);
		expect(f.states.at(-1)).toEqual({ phase: "listening" });
	});

	it("stores matching asr.final and releases the microphone without submitting a Turn", async () => {
		const f = fixture();
		await f.session.start();
		f.session.handleMessage('{"type":"asr.final","request_id":"asr_test","text":"帮我查进度"}');
		await vi.waitFor(() => expect(f.capture.stop).toHaveBeenCalledOnce());
		expect(f.states.at(-1)).toEqual({
			phase: "final",
			finalRequestId: "asr_test",
			finalText: "帮我查进度",
		});
		expect(f.sent).toHaveLength(1);
	});

	it("cancels an active request and cleans up on restart or dispose", async () => {
		const f = fixture();
		await f.session.start();
		await f.session.start();
		expect(f.sent.map((frame) => JSON.parse(frame).type)).toEqual(["asr.start", "asr.cancel", "asr.start"]);
		await f.session.dispose();
		expect(f.sent.map((frame) => JSON.parse(frame).type)).toEqual([
			"asr.start",
			"asr.cancel",
			"asr.start",
			"asr.cancel",
		]);
		expect(f.capture.stop).toHaveBeenCalled();
	});

	it("leaves listening on microphone denial, service error, and disconnect", async () => {
		const denied: VoiceAsrState[] = [];
		const deniedSession = new VoiceAsrSession({
			send: () => true,
			onState: (state) => denied.push(state),
			openCapture: vi.fn(async () => {
				throw new DOMException("denied", "NotAllowedError");
			}),
		});
		await deniedSession.start();
		expect(denied.at(-1)).toEqual({ phase: "error", error: "麦克风权限被拒绝" });

		const f = fixture();
		await f.session.start();
		f.session.handleMessage(
			'{"type":"error","scope":"asr","request_id":"asr_test","message":"识别失败","retryable":true}',
		);
		expect(f.states.at(-1)).toEqual({ phase: "error", error: "识别失败" });
		await f.session.handleDisconnect();
		expect(f.states.at(-1)).toEqual({ phase: "error", error: "语音连接已断开" });
	});
});
