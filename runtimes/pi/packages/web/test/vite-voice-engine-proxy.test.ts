import { describe, expect, it } from "vitest";
import { buildProxyConfig } from "../vite.config.ts";

describe("Vite Voice Engine development proxy", () => {
	it("forwards the same-origin Voice Engine path to the Debussy backend with WS enabled", () => {
		const backend = "http://127.0.0.1:8765";
		const proxy = buildProxyConfig(backend, backend);
		expect(proxy?.["/api/voice-engine"]).toEqual({
			target: backend,
			changeOrigin: false,
			ws: true,
		});
	});
});
