import { describe, expect, it, vi } from "vitest";
import { AudioContextUnlocker } from "../src/features/voice/audio-context-unlocker.ts";
import type { AudioContextLike } from "../src/features/voice/audio-player.ts";

class FakeContext implements AudioContextLike {
	currentTime = 0;
	destination = {};
	createBuffer = vi.fn(() => ({}) as never);
	createBufferSource = vi.fn(() => ({}) as never);
	resumeMock = vi.fn(async () => {});
	async resume(): Promise<void> {
		await this.resumeMock();
	}
}

describe("AudioContextUnlocker", () => {
	it("creates and resumes a context on first unlock attempt", async () => {
		const context = new FakeContext();
		const unlocker = new AudioContextUnlocker({
			create: () => context,
			hasUserGesture: () => true,
		});
		const result = await unlocker.resume();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.context).toBe(context);
		expect(context.resumeMock).toHaveBeenCalledOnce();
		expect(unlocker.unlocked).toBe(true);
		expect(unlocker.context()).toBe(context);
	});

	it("returns the cached context without re-resuming on subsequent calls", async () => {
		const context = new FakeContext();
		const unlocker = new AudioContextUnlocker({
			create: () => context,
			hasUserGesture: () => true,
		});
		await unlocker.resume();
		await unlocker.resume();
		expect(context.resumeMock).toHaveBeenCalledTimes(1);
	});

	it("rejects unlock when no user gesture is available", async () => {
		const context = new FakeContext();
		const unlocker = new AudioContextUnlocker({
			create: () => context,
			hasUserGesture: () => false,
		});
		const result = await unlocker.resume();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("no_user_gesture");
		expect(context.resumeMock).not.toHaveBeenCalled();
		expect(unlocker.unlocked).toBe(false);
	});

	it("surfaces a resume rejection without throwing", async () => {
		const context = new FakeContext();
		context.resumeMock.mockRejectedValueOnce(new Error("blocked"));
		const unlocker = new AudioContextUnlocker({
			create: () => context,
			hasUserGesture: () => true,
		});
		const result = await unlocker.resume();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("resume_rejected");
		expect(unlocker.unlocked).toBe(false);
	});

	it("surfaces a creation failure", async () => {
		const unlocker = new AudioContextUnlocker({
			create: () => {
				throw new Error("no audio device");
			},
			hasUserGesture: () => true,
		});
		const result = await unlocker.resume();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("create_failed");
	});

	it("release() drops the cached context reference", async () => {
		const context = new FakeContext();
		const unlocker = new AudioContextUnlocker({
			create: () => context,
			hasUserGesture: () => true,
		});
		await unlocker.resume();
		unlocker.release();
		expect(unlocker.context()).toBeUndefined();
		expect(unlocker.unlocked).toBe(false);
	});
});
