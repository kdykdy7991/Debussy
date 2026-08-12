import type { AvatarController, AvatarState } from "@skdy/avatar";
import { describe, expect, it, vi } from "vitest";
import { AvatarSpeechBridge } from "../src/features/avatar/speech-bridge.ts";

function fakeAvatar() {
	const calls: string[] = [];
	const controller = {
		setState: (state: AvatarState) => calls.push(`state:${state}`),
		setAudioLevel: (level: number) => calls.push(`level:${level}`),
	} as unknown as AvatarController;
	return { controller, calls };
}

describe("AvatarSpeechBridge", () => {
	it("maps playback lifecycle and clamps levels", () => {
		const avatar = fakeAvatar();
		const bridge = new AvatarSpeechBridge({ controller: avatar.controller });
		const hooks = bridge.hooks;
		hooks.onPlaybackStart?.();
		hooks.onAudioLevel?.(2);
		hooks.onAudioLevel?.(Number.NaN);
		hooks.onPlaybackEnd?.("completed");
		expect(avatar.calls).toEqual(["state:speaking", "level:1", "level:0", "level:0", "state:idle"]);
	});

	it("isolates avatar failures and ignores stale callbacks after detach", () => {
		const avatar = fakeAvatar();
		const onError = vi.fn();
		const bridge = new AvatarSpeechBridge({ controller: avatar.controller, onError });
		const hooks = bridge.hooks;
		bridge.detach();
		hooks.onPlaybackStart?.();
		expect(avatar.calls).toEqual(["level:0"]);
		const broken = fakeAvatar();
		(broken.controller.setState as unknown as ReturnType<typeof vi.fn>) = vi.fn(() => {
			throw new Error("broken");
		});
		bridge.attach(broken.controller);
		bridge.hooks.onPlaybackStart?.();
		expect(onError).toHaveBeenCalledOnce();
		bridge.hooks.onAudioLevel?.(0.5);
		expect(broken.calls).toEqual([]);
	});
});
