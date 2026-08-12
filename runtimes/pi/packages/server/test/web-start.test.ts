import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildVoiceLayer, resolveOptions } from "../src/web/start.ts";

describe("web server configuration", () => {
	test("preserves the all-cwd marker", () => {
		const options = resolveOptions({ allowedCwds: ["*"] });
		expect(options.allowedCwds).toEqual(["*"]);
		expect(options.backend.allowedCwds).toEqual(["*"]);
	});

	test("resolves concrete cwd allowlist entries", () => {
		const options = resolveOptions({ allowedCwds: ["relative-project"] });
		expect(options.allowedCwds).toEqual([resolve(process.cwd(), "relative-project")]);
	});

	test("defaults browser origins to loopback hosts", () => {
		const options = resolveOptions({});
		expect(options.listener.allowedOrigins).toEqual(["http://127.0.0.1:*", "http://localhost:*"]);
	});

	test("requires the configured WebSocket token subprotocol", () => {
		const options = resolveOptions({ webToken: "local-secret" });
		const authorize = options.listener.authorizeUpgrade;
		expect(authorize).toBeDefined();
		expect(authorize?.({ headers: {} } as IncomingMessage)).toBe(false);
		expect(authorize?.({ headers: { "sec-websocket-protocol": "pi-auth.local-secret" } } as IncomingMessage)).toBe(
			true,
		);
	});

	test("rejects tokens that cannot be used as WebSocket subprotocols", () => {
		expect(() => resolveOptions({ webToken: "invalid token" })).toThrow(/Web token/);
	});
});

describe("voice proxy configuration", () => {
	test("builds no voice layer when voice is not configured", () => {
		const layer = buildVoiceLayer(undefined, {});
		expect(layer.speech).toBeUndefined();
		expect(layer.handlers).toHaveLength(0);
	});

	test("builds a speech manager from the built-in default profile", () => {
		const layer = buildVoiceLayer(
			{ baseUrl: "http://127.0.0.1:18876", token: "service-secret", defaultProfile: "default" },
			{ webToken: "web-secret" },
		);
		expect(layer.speech).toBeDefined();
		expect(layer.handlers).toHaveLength(1);
		expect(layer.speech?.getCapability()).toEqual({
			available: true,
			live: false,
			defaultProfile: "default",
			profiles: [{ id: "default", name: "Default" }],
		});
	});

	test("rejects a default profile that is not among the configured profiles", () => {
		expect(() =>
			buildVoiceLayer(
				{
					baseUrl: "http://127.0.0.1:18876",
					token: "service-secret",
					defaultProfile: "missing",
					profiles: [{ id: "default", provider: "qwen3-tts", language: "Chinese", speaker: "Vivian" }],
				},
				{},
			),
		).toThrow(/default profile/);
	});
});

import type { IncomingMessage } from "node:http";
