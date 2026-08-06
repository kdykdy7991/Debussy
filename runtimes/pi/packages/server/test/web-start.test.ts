import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveOptions } from "../src/web/start.ts";

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

import type { IncomingMessage } from "node:http";
