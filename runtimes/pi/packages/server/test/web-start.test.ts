import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parsePublishingConfig } from "../src/publishing/config.ts";
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
		expect(layer.liveSpeech).toBeUndefined();
		expect(layer.handlers).toHaveLength(0);
	});

	test("builds speech + live speech managers from the built-in default profile", () => {
		const layer = buildVoiceLayer(
			{ baseUrl: "http://127.0.0.1:18876", token: "service-secret", defaultProfile: "default" },
			{ webToken: "web-secret" },
		);
		expect(layer.speech).toBeDefined();
		expect(layer.liveSpeech).toBeDefined();
		expect(layer.handlers).toHaveLength(2);
		expect(layer.speech?.getCapability()).toEqual({
			available: true,
			live: true,
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

describe("publishing feature configuration", () => {
	test("defaults to disabled when the env var is unset", () => {
		expect(parsePublishingConfig({})).toEqual({
			enabled: false,
			databaseUrl: undefined,
			redisUrl: undefined,
			bootstrapTenantId: undefined,
			bootstrapTenantName: undefined,
			controlAdminTokenFile: undefined,
			embedBaseUrl: "http://127.0.0.1:8765",
			subjectPepper: undefined,
			accessTokenPrivateKeyFile: undefined,
			accessTokenPublicKeyFile: undefined,
			accessTokenKeyId: undefined,
			accessTokenTtlSeconds: 600,
		});
	});

	test("accepts case-insensitive boolean values", () => {
		const enabled = expect.objectContaining({ enabled: true });
		expect(parsePublishingConfig({ PI_PUBLISHING_ENABLED: "true" })).toEqual(enabled);
		expect(parsePublishingConfig({ PI_PUBLISHING_ENABLED: "TRUE" })).toEqual(enabled);
		expect(parsePublishingConfig({ PI_PUBLISHING_ENABLED: " false " })).toEqual(
			expect.objectContaining({ enabled: false }),
		);
	});

	test("reads the 24.2 publishing environment into the config", () => {
		const config = parsePublishingConfig({
			PI_PUBLISHING_ENABLED: "true",
			PI_DATABASE_URL: "postgresql://u:p@host/db",
			PI_REDIS_URL: "redis://127.0.0.1:6379/0",
			PI_BOOTSTRAP_TENANT_ID: "00000000-0000-7000-8000-000000000001",
			PI_BOOTSTRAP_TENANT_NAME: "SKDY",
			PI_CONTROL_ADMIN_TOKEN_FILE: "/run/secrets/control-admin-token",
			PI_EMBED_ISSUER: "https://agent.example.com",
			PI_EMBED_SUBJECT_PEPPER: "pepper-0123456789abcdef0123456789abcdef",
			PI_EMBED_ACCESS_TOKEN_PRIVATE_KEY_FILE: "/run/secrets/embed-access-private.pem",
			PI_EMBED_ACCESS_TOKEN_PUBLIC_KEY_FILE: "/run/secrets/embed-access-public.pem",
			PI_EMBED_ACCESS_TOKEN_KEY_ID: "kid-2026-01",
			PI_EMBED_ACCESS_TOKEN_TTL_SECONDS: "300",
		});
		expect(config).toEqual({
			enabled: true,
			databaseUrl: "postgresql://u:p@host/db",
			redisUrl: "redis://127.0.0.1:6379/0",
			bootstrapTenantId: "00000000-0000-7000-8000-000000000001",
			bootstrapTenantName: "SKDY",
			controlAdminTokenFile: "/run/secrets/control-admin-token",
			embedBaseUrl: "https://agent.example.com",
			subjectPepper: "pepper-0123456789abcdef0123456789abcdef",
			accessTokenPrivateKeyFile: "/run/secrets/embed-access-private.pem",
			accessTokenPublicKeyFile: "/run/secrets/embed-access-public.pem",
			accessTokenKeyId: "kid-2026-01",
			accessTokenTtlSeconds: 300,
		});
	});

	test("rejects an invalid access-token ttl so a misconfiguration fails startup", () => {
		for (const raw of ["0", "-5", "abc", "1.5", "90000"]) {
			expect(() =>
				parsePublishingConfig({ PI_PUBLISHING_ENABLED: "true", PI_EMBED_ACCESS_TOKEN_TTL_SECONDS: raw }),
			).toThrow(/PI_EMBED_ACCESS_TOKEN_TTL_SECONDS/);
		}
	});

	test("rejects non-boolean values so a misconfiguration fails startup", () => {
		for (const raw of ["1", "yes", "on", "maybe"]) {
			expect(() => parsePublishingConfig({ PI_PUBLISHING_ENABLED: raw })).toThrow(/PI_PUBLISHING_ENABLED/);
		}
	});

	test("disabled publishing keeps the resolved listener configuration unchanged", () => {
		// Existing URL and handler wiring must not depend on publishing infra.
		const options = resolveOptions({});
		expect(options.path).toBe("/api/pi/v1/ws");
		expect(options.listener.allowedOrigins).toEqual(["http://127.0.0.1:*", "http://localhost:*"]);
		expect(options.listener.authorizeUpgrade).toBeUndefined();
	});
});

import type { IncomingMessage } from "node:http";
