import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	shouldRequestLiveSpeech as _shouldRequest,
	isLiveAvailable,
	LIVE_SPEECH_STORAGE_KEY,
	readLiveSpeechEnabled,
	shouldRequestLiveSpeech,
	writeLiveSpeechEnabled,
} from "../src/features/voice/live-settings.ts";

// Vitest's web workspace runs in Node by default; polyfill a minimal
// `window.localStorage` so the persistence helpers can be exercised in
// isolation. The helpers themselves short-circuit when `window` is undefined.
const memory = new Map<string, string>();
const polyfilledWindow = {
	localStorage: {
		getItem: (key: string) => memory.get(key) ?? null,
		setItem: (key: string, value: string) => {
			memory.set(key, value);
		},
		removeItem: (key: string) => {
			memory.delete(key);
		},
		clear: () => memory.clear(),
	},
};
(globalThis as { window?: typeof polyfilledWindow }).window = polyfilledWindow;

describe("live-settings", () => {
	beforeEach(() => {
		memory.clear();
	});
	afterEach(() => {
		memory.clear();
	});

	it("defaults to on when nothing is persisted", () => {
		expect(readLiveSpeechEnabled()).toBe(true);
	});

	it("persists the explicit opt-in", () => {
		writeLiveSpeechEnabled(true);
		expect(memory.get(LIVE_SPEECH_STORAGE_KEY)).toBe("1");
		expect(readLiveSpeechEnabled()).toBe(true);
	});

	it("persists an explicit opt-out", () => {
		writeLiveSpeechEnabled(true);
		writeLiveSpeechEnabled(false);
		expect(memory.get(LIVE_SPEECH_STORAGE_KEY)).toBe("0");
		expect(readLiveSpeechEnabled()).toBe(false);
	});

	it("detects server capability loss", () => {
		expect(isLiveAvailable(undefined)).toBe(false);
		expect(isLiveAvailable({ voice: undefined })).toBe(false);
		expect(isLiveAvailable({ voice: { live: false } })).toBe(false);
		expect(isLiveAvailable({ voice: { live: true } })).toBe(true);
	});

	it("blocks requests when the toggle is off even if the server is ready", () => {
		expect(shouldRequestLiveSpeech(false, { voice: { live: true } })).toBe(false);
	});

	it("blocks requests when the server does not advertise live", () => {
		expect(shouldRequestLiveSpeech(true, { voice: { live: false } })).toBe(false);
		expect(shouldRequestLiveSpeech(true, undefined)).toBe(false);
	});

	it("allows requests only when both user and server are aligned", () => {
		expect(shouldRequestLiveSpeech(true, { voice: { live: true } })).toBe(true);
	});

	it("exports the storage key for parity with the controller", () => {
		expect(_shouldRequest).toBe(shouldRequestLiveSpeech);
	});
});
