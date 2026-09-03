import { describe, expect, test } from "vitest";
import { loadVoiceEngineConfig } from "../../src/embed/voice-engine/config.ts";

describe("Voice Engine configuration", () => {
	test("stays disabled when every setting is absent", () => {
		expect(loadVoiceEngineConfig({})).toBeUndefined();
	});

	test("loads upstream URL + token when both are present", () => {
		expect(
			loadVoiceEngineConfig({ PI_VOICE_ENGINE_URL: "ws://voxemw:18800", PI_VOICE_ENGINE_TOKEN: "secret" }),
		).toEqual({ upstreamUrl: "ws://voxemw:18800", upstreamToken: "secret" });
	});

	test("rejects a half-configured binding (URL only)", () => {
		expect(() => loadVoiceEngineConfig({ PI_VOICE_ENGINE_URL: "ws://voxemw:18800" })).toThrow(
			/PI_VOICE_ENGINE_TOKEN/,
		);
	});

	test("rejects a half-configured binding (token only)", () => {
		expect(() => loadVoiceEngineConfig({ PI_VOICE_ENGINE_TOKEN: "secret" })).toThrow(/PI_VOICE_ENGINE_URL/);
	});

	test("rejects an empty URL", () => {
		expect(() => loadVoiceEngineConfig({ PI_VOICE_ENGINE_URL: "", PI_VOICE_ENGINE_TOKEN: "secret" })).toThrow(
			/PI_VOICE_ENGINE_URL is required/,
		);
	});

	test("rejects an empty token", () => {
		expect(() =>
			loadVoiceEngineConfig({ PI_VOICE_ENGINE_URL: "ws://voxemw:18800", PI_VOICE_ENGINE_TOKEN: "" }),
		).toThrow(/PI_VOICE_ENGINE_TOKEN/);
	});
});
