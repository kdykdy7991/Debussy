import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { aaasOpenApi } from "../../src/orchestration/api-documentation.ts";
import { createOrchestrationHttp } from "../../src/orchestration/http.ts";
import type { OrchestrationService } from "../../src/orchestration/service.ts";

describe("Agent task API documentation", () => {
	const integrationId = randomUUID();
	const runId = randomUUID();
	const record = {
		run_id: runId,
		integration_id: integrationId,
		external_ref: null,
		metadata: null,
		agent_version: `orv_${randomUUID()}`,
		configuration_revision: 1,
		status: "queued",
		result: null,
		error: null,
		created_at: new Date().toISOString(),
		started_at: null,
		completed_at: null,
	};
	const store = {
		authenticate: vi.fn(async (header: string | undefined) => {
			if (header !== "Bearer test-token") throw new Error("unauthorized");
			return { id: integrationId };
		}),
		accept: vi.fn(async () => ({ workItemId: runId, duplicate: false })),
		run: vi.fn(async () => record),
		cancel: vi.fn(async () => undefined),
	};
	const handler = createOrchestrationHttp({ store } as unknown as OrchestrationService, () => false);
	const server = createServer((req, res) => {
		void Promise.resolve(handler(req, res)).then((handled) => {
			if (!handled) res.writeHead(404).end();
		});
	});
	let base: string;
	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen failed");
		base = `http://127.0.0.1:${address.port}`;
	});
	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	test("serves only the three explicitly documented routes and local UI assets", async () => {
		const doc = await fetch(`${base}/api/aaas-docs/openapi.json`);
		expect(doc.status).toBe(200);
		expect(await doc.json()).toEqual(aaasOpenApi);
		expect(Object.keys(aaasOpenApi.paths)).toEqual([
			"/api/aaas/v1/integrations/{integration_id}/runs",
			"/api/aaas/v1/runs/{run_id}",
			"/api/aaas/v1/runs/{run_id}/cancel",
		]);
		expect((await fetch(`${base}/api/aaas-docs/`)).status).toBe(200);
		expect((await fetch(`${base}/api/aaas-docs/swagger-ui-bundle.js`)).status).toBe(200);
		expect((await fetch(`${base}/api/aaas-docs/package.json`)).status).toBe(404);
	});

	test("documented operations match actual accepted requests and response fields", async () => {
		const headers = {
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
			"Idempotency-Key": "example-key",
		};
		const create = (body: unknown) =>
			fetch(`${base}/api/aaas/v1/integrations/${integrationId}/runs`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
		const response = await create({ prompt: "分析工单", external_ref: { id: "TK001" } });
		expect(response.status).toBe(202);
		expect(((await response.json()) as { data: unknown }).data).toEqual({
			run_id: runId,
			status: "queued",
			duplicate: false,
		});
		expect((await create({ prompt: "test", input: {} })).status).toBe(400);
		expect((await create({ prompt: " " })).status).toBe(400);
		expect((await create({ input: {} })).status).toBe(202);
		const query = await fetch(`${base}/api/aaas/v1/runs/${runId}`, { headers });
		expect(query.status).toBe(200);
		const data = ((await query.json()) as { data: Record<string, unknown> }).data;
		expect(Object.keys(data).sort()).toEqual(
			[
				...aaasOpenApi.paths["/api/aaas/v1/runs/{run_id}"].get.responses["200"].content["application/json"].schema
					.properties.data.required,
			].sort(),
		);
		const cancel = await fetch(`${base}/api/aaas/v1/runs/${runId}/cancel`, { method: "POST", headers, body: "{}" });
		expect(cancel.status).toBe(200);
		expect(store.cancel).toHaveBeenCalledWith(runId, integrationId);
	});
});
