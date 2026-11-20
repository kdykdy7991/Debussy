import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { aaasApiKeyOpenApi, aaasOpenApi } from "../../src/orchestration/api-documentation.ts";
import { createOrchestrationHttp } from "../../src/orchestration/http.ts";
import { routerOpenApi } from "../../src/orchestration/router-api-documentation.ts";
import {
	appendInputResponseSchema,
	cancelTaskResponseSchema,
	createTaskResponseSchema,
	operationViewSchema,
	ROUTER_PATHS,
	routerMcpServerDetailSchema,
	routerMcpServerSummarySchema,
	taskEventsResponseSchema,
	taskViewSchema,
} from "../../src/orchestration/router-contracts.ts";
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

	test("serves the Router developer guide and the separate Integration OpenAPI document", async () => {
		const doc = await fetch(`${base}/api/aaas-docs/openapi.json`);
		expect(doc.status).toBe(200);
		expect(await doc.json()).toEqual(aaasOpenApi);
		expect(Object.keys(aaasOpenApi.paths)).toEqual([
			"/api/aaas/v1/integrations/{integration_id}/runs",
			"/api/aaas/v1/runs/{run_id}",
			"/api/aaas/v1/runs/{run_id}/cancel",
		]);
		const ui = await fetch(`${base}/api/aaas-docs/`);
		expect(ui.status).toBe(200);
		const page = await ui.text();
		expect(page).toContain("<title>Router V1 API</title>");
		expect(page).toContain('<article id="quick-start">');
		expect(page).toContain('<section id="api-reference">');
		expect(page).toContain("poll_operation");
		expect(page).toContain("tool_credential");
		expect(page).not.toContain("connection_credential</code>");
		for (const methods of Object.values(routerOpenApi.paths)) {
			for (const operation of Object.values<{ operationId: string }>(methods)) {
				expect(page).toContain(`id="${operation.operationId}"`);
				expect(page).toContain(`href="#${operation.operationId}"`);
			}
		}
		expect((await fetch(`${base}/api/aaas-docs/router.js`)).status).toBe(200);
		expect((await fetch(`${base}/api/aaas-docs/router.css`)).status).toBe(200);
		expect((await fetch(`${base}/api/aaas-docs/package.json`)).status).toBe(404);
	});

	test("public OpenAPI publishes the six Router operations and MCP discovery", async () => {
		const response = await fetch(`${base}/api/aaas-docs/v1/public/openapi.json`);
		expect(response.status).toBe(200);
		const document = (await response.json()) as {
			info: { title: string; description?: string };
			paths: Record<string, unknown>;
			tags: { name: string }[];
			components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
		};
		expect(Object.keys(document.paths)).toEqual([
			...ROUTER_PATHS,
			"/api/aaas/v1/mcp-servers",
			"/api/aaas/v1/mcp-servers/{server_id}",
		]);
		expect(document.info.title).toBe("Router V1 API");
		expect(document).toEqual(routerOpenApi);
		expect(document.tags.map((tag) => tag.name)).toEqual(["Router V1", "MCP 发现"]);
		expect(Object.keys(document.components.securitySchemes)).toEqual(["ApiKey"]);
		for (const path of ROUTER_PATHS) {
			expect(document.paths[path]).toEqual(routerOpenApi.paths[path]);
		}
		expect(document.paths["/api/aaas/v1/mcp-servers"]).toMatchObject({
			get: {
				operationId: "listApiKeyMcpServers",
				parameters: routerOpenApi.paths["/api/aaas/v1/mcp-servers"].get.parameters,
			},
		});
		for (const [, schema] of JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
			expect(document.components.schemas).toHaveProperty(schema);
		}
	});

	test("the eight published success examples match the HTTP response validators", () => {
		const paths = routerOpenApi.paths;
		expect(
			createTaskResponseSchema.parse(
				paths[ROUTER_PATHS[0]].post.responses["201"].content["application/json"].example.data,
			),
		).toBeTruthy();
		expect(
			appendInputResponseSchema.parse(
				paths[ROUTER_PATHS[1]].post.responses["202"].content["application/json"].example.data,
			),
		).toBeTruthy();
		expect(
			taskViewSchema.parse(paths[ROUTER_PATHS[2]].get.responses["200"].content["application/json"].example.data),
		).toBeTruthy();
		expect(
			operationViewSchema.parse(
				paths[ROUTER_PATHS[3]].get.responses["200"].content["application/json"].example.data,
			),
		).toBeTruthy();
		expect(
			taskEventsResponseSchema.parse(
				paths[ROUTER_PATHS[4]].get.responses["200"].content["application/json"].example.data,
			),
		).toBeTruthy();
		expect(
			cancelTaskResponseSchema.parse(
				paths[ROUTER_PATHS[5]].post.responses["200"].content["application/json"].example.data,
			),
		).toBeTruthy();
		expect(
			routerMcpServerSummarySchema
				.array()
				.parse(paths["/api/aaas/v1/mcp-servers"].get.responses["200"].content["application/json"].example.data),
		).toHaveLength(2);
		expect(
			routerMcpServerDetailSchema.parse(
				paths["/api/aaas/v1/mcp-servers/{server_id}"].get.responses["200"].content["application/json"].example.data,
			),
		).toBeTruthy();
	});

	test("publishes the API Key contract separately without changing the legacy document", async () => {
		const doc = await fetch(`${base}/api/aaas-docs/v1/openapi.json`);
		expect(doc.status).toBe(200);
		expect(await doc.json()).toEqual(aaasApiKeyOpenApi);
		// The legacy three-route contract above is untouched by the V1 document.
		expect(Object.keys(aaasOpenApi.paths)).toHaveLength(3);
		expect(Object.keys(aaasApiKeyOpenApi.paths)).toEqual([
			"/api/aaas/v1/mcp-servers",
			"/api/aaas/v1/mcp-servers/{server_id}",
			"/api/admin/v1/aaas/keys",
			"/api/admin/v1/aaas/keys/{key_id}/router",
			"/api/admin/v1/aaas/keys/legacy-configuration-status",
			"/api/admin/v1/aaas/keys/router-executions",
			"/api/admin/v1/aaas/keys/sandbox/environment",
			"/api/admin/v1/aaas/keys/sandbox/statistics",
			"/api/admin/v1/aaas/keys/{key_id}/router/tasks",
			"/api/admin/v1/aaas/keys/{key_id}/router/tasks/{task_id}",
			"/api/admin/v1/aaas/keys/{key_id}/router/tasks/{task_id}/history",
			"/api/admin/v1/aaas/keys/{key_id}/router/operations/{operation_id}",
			"/api/admin/v1/aaas/keys/{key_id}",
			"/api/admin/v1/aaas/keys/{key_id}/secret",
			"/api/admin/v1/aaas/keys/configurations",
			"/api/admin/v1/aaas/keys/{key_id}/configuration",
			"/api/admin/v1/aaas/keys/versions/{version_id}/credential-bindings",
			"/api/admin/v1/aaas/keys/platform-configuration/versions",
			"/api/admin/v1/aaas/keys/platform-configuration",
		]);
		expect(
			aaasApiKeyOpenApi.paths["/api/aaas/v1/mcp-servers"].get.responses["200"].content["application/json"].schema
				.properties.data.items,
		).toEqual({ $ref: "#/components/schemas/ApiKeyMcpServerSummary" });
		expect(
			aaasApiKeyOpenApi.paths["/api/aaas/v1/mcp-servers/{server_id}"].get.responses["200"].content[
				"application/json"
			].schema.properties.data,
		).toEqual({ $ref: "#/components/schemas/ApiKeyMcpServer" });
		expect(aaasApiKeyOpenApi.components.securitySchemes.ApiKey).toBeDefined();
		expect(aaasApiKeyOpenApi.components.schemas).not.toHaveProperty("ApiKeyCreateRun");
		expect(aaasApiKeyOpenApi.paths["/api/admin/v1/aaas/keys/{key_id}/configuration"].put.security).toEqual([
			{ AdminBearer: [] },
		]);
		expect(aaasApiKeyOpenApi.components.securitySchemes.AdminBearer).toBeDefined();
		expect(aaasApiKeyOpenApi.paths["/api/admin/v1/aaas/keys/router-executions"].get.security).toEqual([
			{ AdminBearer: [] },
		]);
		expect(aaasApiKeyOpenApi.paths["/api/admin/v1/aaas/keys/sandbox/environment"].get.security).toEqual([
			{ AdminBearer: [] },
		]);
		expect(aaasApiKeyOpenApi.paths["/api/admin/v1/aaas/keys/sandbox/statistics"].get.security).toEqual([
			{ AdminBearer: [] },
		]);
		expect(
			aaasApiKeyOpenApi.paths["/api/admin/v1/aaas/keys"].post.requestBody.content["application/json"].schema
				.properties.orchestration_version_id.nullable,
		).toBe(true);
		expect(aaasApiKeyOpenApi.paths["/api/admin/v1/aaas/keys/platform-configuration"].get.operationId).toBe(
			"getApiKeyPlatformConfiguration",
		);
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
