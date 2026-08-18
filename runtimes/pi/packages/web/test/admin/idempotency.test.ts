/**
 * Idempotency-Key helper + AgentApi.importCurrent (MVP-03).
 *
 * - `newIdempotencyKey` returns distinct, prefixed UUIDs and never touches
 *   storage, URL, or console.
 * - `AgentApi.importCurrentAgent` POSTs to /agent-definitions/import-current
 *   with an Idempotency-Key and returns the freshly imported
 *   AgentDefinition id.
 */

import { describe, expect, it, vi } from "vitest";
import { AgentApi, AgentApiError } from "../../src/admin/api/agent-api.ts";
import { newIdempotencyKey } from "../../src/admin/api/idempotency.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

describe("newIdempotencyKey", () => {
	it("returns distinct keys for repeated calls", () => {
		const a = newIdempotencyKey({ operation: "agent.import" });
		const b = newIdempotencyKey({ operation: "agent.import" });
		expect(a).not.toBe(b);
	});

	it("prefixes the slug derived from the operation name", () => {
		const key = newIdempotencyKey({ operation: "App.Create" });
		expect(key.startsWith("op_app-create_")).toBe(true);
	});

	it("falls back gracefully when crypto.randomUUID is unavailable", () => {
		// globalThis.crypto is read-only in modern Node; replace
		// `randomUUID` on the live object via a stub to prove the fallback
		// branch is exercised.
		const originalRandomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
		try {
			if (globalThis.crypto !== undefined) {
				Object.defineProperty(globalThis.crypto, "randomUUID", {
					value: undefined,
					configurable: true,
					writable: true,
				});
			}
			const key = newIdempotencyKey({ operation: "noop" });
			expect(key.startsWith("op_noop_")).toBe(true);
		} finally {
			if (globalThis.crypto !== undefined && originalRandomUUID !== undefined) {
				Object.defineProperty(globalThis.crypto, "randomUUID", {
					value: originalRandomUUID,
					configurable: true,
					writable: true,
				});
			}
		}
	});
});

describe("AgentApi.importCurrent (MVP-03)", () => {
	it("POSTs to /import-current with an Idempotency-Key", async () => {
		const controller = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		controller.connect("tok");
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			captured = { url, init };
			return new Response(
				JSON.stringify({
					data: {
						agentDefinitionId: "agent_new",
						revision: 1,
						sourceHash: "abc123",
						warnings: [],
					},
					requestId: "r1",
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		});
		const api = new AgentApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		const result = await api.importCurrentAgent();
		expect(result.agentDefinitionId).toBe("agent_new");
		expect(result.revision).toBe(1);
		if (captured === undefined) throw new Error("captured missing");
		expect(captured.url).toBe("http://localhost/api/control/v1/agent-definitions/import-current");
		expect(captured.init.method).toBe("POST");
		const headers = captured.init.headers as Record<string, string>;
		expect(headers["Idempotency-Key"]).toBeTruthy();
		expect(headers["Idempotency-Key"].startsWith("op_agent-import_")).toBe(true);
	});

	it("forwards an expectedSourceHash when provided", async () => {
		const controller = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		controller.connect("tok");
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			captured = { url, init };
			return new Response(
				JSON.stringify({
					data: { agentDefinitionId: "agent_a", revision: 2, sourceHash: "h", warnings: [] },
					requestId: "r2",
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		});
		const api = new AgentApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		await api.importCurrentAgent({ expectedSourceHash: "deadbeef" });
		if (captured === undefined) throw new Error("captured missing");
		const body = JSON.parse(captured.init.body as string) as Record<string, unknown>;
		expect(body["expectedSourceHash"]).toBe("deadbeef");
	});

	it("locks the controller on 401", async () => {
		const controller = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		controller.connect("bad-tok");
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no" } }), {
					status: 401,
				}),
		);
		const api = new AgentApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		await expect(api.importCurrentAgent()).rejects.toBeInstanceOf(AgentApiError);
		expect(controller.getSnapshot().state).toBe("error");
		expect(controller.getToken()).toBeNull();
	});
});
