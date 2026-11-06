import { describe, expect, it } from "vitest";
import { buildProxyConfig, isPublicEmbedDevPath } from "../vite.config.ts";

describe("Agent task API documentation proxy", () => {
	it("routes same-origin documentation and task API to the backend without an admin token", () => {
		const backend = "http://127.0.0.1:8765";
		expect(buildProxyConfig(backend, backend)?.["/api/aaas"]).toEqual({ target: backend, changeOrigin: false });
	});
	it("keeps the development documentation and API restricted to local visitors", () => {
		expect(isPublicEmbedDevPath("/api/aaas-docs/")).toBe(false);
		expect(isPublicEmbedDevPath("/api/aaas/v1/runs/example")).toBe(false);
	});
});
