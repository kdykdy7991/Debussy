import { describe, expect, it, vi } from "vitest";
import type { Pcm16Player } from "../../src/embed/pcm16-playback.ts";
import { currentVisibleAssistant, VoiceTtsSession } from "../../src/embed/voice-tts-session.ts";

function fixture() {
	const sent: string[] = [];
	const played: number[][] = [];
	const phases: string[] = [];
	let nextId = 0;
	const player: Pcm16Player = {
		prepare: vi.fn(),
		enqueue: vi.fn((pcm) => played.push([...pcm])),
		stop: vi.fn(async () => {}),
	};
	const tts = new VoiceTtsSession({
		send: (frame) => {
			sent.push(frame);
			return true;
		},
		player,
		createRequestId: () => `tts-${nextId++}`,
		onPhase: (phase) => phases.push(phase),
	});
	return { tts, player, sent, played, phases, frames: () => sent.map((frame) => JSON.parse(frame)) };
}

describe("VoiceTtsSession", () => {
	it("serializes two sentences and flushes the final tail only after completions", () => {
		const f = fixture();
		f.tts.observeVisibleAssistant("old", "历史回答。", "complete");
		f.tts.enable();
		f.tts.observeVisibleAssistant("answer", "第一句。第二", "streaming");
		f.tts.observeVisibleAssistant("answer", "第一句。第二句！尾句", "streaming");
		f.tts.observeVisibleAssistant("answer", "第一句。第二句！尾句", "complete");
		expect(f.frames()).toEqual([{ type: "tts.synthesize", request_id: "tts-0", text: "第一句。" }]);

		f.tts.handleMessage('{"type":"tts.completed","request_id":"tts-0"}');
		expect(f.frames().at(-1)).toEqual({ type: "tts.synthesize", request_id: "tts-1", text: "第二句！" });
		f.tts.handleMessage('{"type":"tts.completed","request_id":"tts-1"}');
		expect(f.frames().at(-1)).toEqual({ type: "tts.synthesize", request_id: "tts-2", text: "尾句" });
		f.tts.handleMessage('{"type":"tts.completed","request_id":"tts-2"}');
		expect(f.frames()).toHaveLength(3);
	});

	it("reorders PCM chunks by sequence while allowing queued audio to outlive completed", () => {
		const f = fixture();
		f.tts.enable();
		f.tts.observeVisibleAssistant("answer", "一句。", "complete");
		f.tts.handleMessage('{"type":"tts.audio","request_id":"tts-0","sequence":1,"audio":"AwQ="}');
		expect(f.played).toEqual([]);
		f.tts.handleMessage('{"type":"tts.audio","request_id":"tts-0","sequence":0,"audio":"AQI="}');
		expect(f.phases.at(-1)).toBe("playing");
		expect(f.played).toEqual([
			[1, 2],
			[3, 4],
		]);
		f.tts.handleMessage('{"type":"tts.completed","request_id":"tts-0"}');
		expect(f.phases.at(-1)).toBe("idle");
		expect(f.player.stop).not.toHaveBeenCalled();
	});

	it("stops the active request and clears buffer, queue, and playback", async () => {
		const f = fixture();
		f.tts.enable();
		f.tts.observeVisibleAssistant("answer", "第一句。第二句。尾巴", "streaming");
		await f.tts.stop();
		expect(f.frames().at(-1)).toEqual({ type: "tts.stop", request_id: "tts-0" });
		expect(f.player.stop).toHaveBeenCalledOnce();
		f.tts.handleMessage('{"type":"tts.completed","request_id":"tts-0"}');
		expect(f.frames()).toHaveLength(2);
	});

	it("projects only assistant visible text and ignores system/tool/thinking fields", () => {
		const visible = currentVisibleAssistant([
			{ id: "a", role: "assistant", text: "给用户看的文字", streaming: true, thinking: "内部推理" },
			{ id: "tool", role: "tool", text: "工具结果" },
			{ id: "system", role: "system", text: "调试事件" },
		]);
		expect(visible).toEqual({ id: "a", text: "给用户看的文字", status: "streaming" });
	});

	it("stops stale synthesis and playback before a newer assistant reply", async () => {
		const f = fixture();
		f.tts.enable();
		f.tts.observeVisibleAssistant("answer-1", "旧回复第一句。旧回复第二句。", "complete");
		f.tts.handleMessage('{"type":"tts.audio","request_id":"tts-0","sequence":0,"audio":"AQI="}');

		f.tts.observeVisibleAssistant("answer-2", "新回复。", "complete");
		expect(f.frames().at(-1)).toEqual({ type: "tts.stop", request_id: "tts-0" });
		expect(f.player.stop).toHaveBeenCalledOnce();
		await Promise.resolve();
		// The new request remains serialized behind VoxEMW's stop acknowledgement.
		expect(f.frames()).toHaveLength(2);

		f.tts.handleMessage('{"type":"tts.stopped","request_id":"tts-0"}');
		expect(f.frames().at(-1)).toEqual({ type: "tts.synthesize", request_id: "tts-1", text: "新回复。" });
	});

	it("interrupts stale speech immediately when the user submits a new text turn", async () => {
		const f = fixture();
		f.tts.enable();
		f.tts.observeVisibleAssistant("answer-1", "还没有读完。", "complete");
		f.tts.handleMessage('{"type":"tts.audio","request_id":"tts-0","sequence":0,"audio":"AQI="}');

		f.tts.interruptForUserTurn();
		expect(f.frames().at(-1)).toEqual({ type: "tts.stop", request_id: "tts-0" });
		expect(f.player.stop).toHaveBeenCalledOnce();
		await Promise.resolve();

		f.tts.observeVisibleAssistant("answer-2", "新回复。", "complete");
		expect(f.frames()).toHaveLength(2);
		f.tts.handleMessage('{"type":"tts.stopped","request_id":"tts-0"}');
		expect(f.frames().at(-1)).toEqual({ type: "tts.synthesize", request_id: "tts-1", text: "新回复。" });
	});
});
