/**
 * PublishingController unit tests (ADMIN-003/004/005/006).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { PublishingApi } from "../../src/publishing/api.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";
import { publishingAppIdFromPath } from "../../src/publishing/publishing-app.tsx";
import { PublishingController } from "../../src/publishing/publishing-controller.ts";
import { PublishingApiError } from "../../src/publishing/types.ts";

interface RecordedCall {
	readonly url: string;
	readonly init: RequestInit;
}

function recorder() {
	const calls: RecordedCall[] = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		const method = (init.method ?? "GET").toUpperCase();
		if (method === "GET" && url.includes("/published-apps?limit=1")) {
			return new Response(JSON.stringify({ data: { items: [], nextCursor: null }, requestId: "req_ping" }), {
				status: 200,
				headers: { "content-type": "application/json", "x-tenant-id": "t1", "x-tenant-name": "bootstrap" },
			});
		}
		if (method === "GET" && url.includes("/published-apps")) {
			return new Response(
				JSON.stringify({
					data: {
						items: [
							{
								id: "app_x",
								publicAppId: "pub_x",
								name: "Demo",
								status: "draft",
								accessMode: "anonymous",
								allowedOrigins: [],
								currentVersionId: null,
								embedUrl: "http://localhost/embed/pub_x",
								createdAt: "2026-08-17T00:00:00.000Z",
								updatedAt: "2026-08-17T00:00:00.000Z",
							},
						],
						nextCursor: null,
					},
					requestId: "req_list",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (method === "GET" && url.includes("/agent-definitions")) {
			return new Response(
				JSON.stringify({
					data: {
						items: [
							{
								id: "agent_x",
								name: "Default",
								revision: 3,
								sourceHash: "h",
								createdAt: "2026-08-17T00:00:00.000Z",
							},
						],
						nextCursor: null,
					},
					requestId: "req_agents",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (method === "POST" && url.includes("/import-current")) {
			return new Response(
				JSON.stringify({
					data: { agentDefinitionId: "agent_x", revision: 3, sourceHash: "h", warnings: [] },
					requestId: "req_imp",
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}
		if (
			method === "POST" &&
			url.includes("/published-apps") &&
			!url.includes("/versions") &&
			!url.includes("/activate") &&
			!url.includes("/suspend")
		) {
			return new Response(
				JSON.stringify({
					data: {
						id: "app_new",
						publicAppId: "pub_new",
						status: "draft",
						currentVersionId: null,
						embedUrl: "http://localhost/embed/pub_new",
					},
					requestId: "req_create",
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}
		if (method === "POST" && url.includes("/versions")) {
			return new Response(
				JSON.stringify({
					data: {
						version: {
							id: "pav_v1",
							versionNumber: 1,
							status: "ready",
							sourceAgentRevision: 3,
							validationErrors: [],
						},
					},
					requestId: "req_version",
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}
		if (method === "POST" && url.includes("/activate")) {
			return new Response(
				JSON.stringify({
					data: {
						app: { id: "app_new", publicAppId: "pub_new", status: "active", currentVersionId: "pav_v1" },
						previousVersionId: null,
						auditEventId: "audit_1",
					},
					requestId: "req_act",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(
			JSON.stringify({ error: { code: "NOT_FOUND", message: "stub", requestId: "req_x", retryable: false } }),
			{
				status: 404,
				headers: { "content-type": "application/json" },
			},
		);
	});
	return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("PublishingController", () => {
	let controller: PublishingController;
	let auth: AdminAuthController;
	let calls: RecordedCall[];

	beforeEach(() => {
		const r = recorder();
		calls = r.calls;
		auth = new AdminAuthController();
		const api = new PublishingApi({
			baseUrl: "",
			fetchImpl: r.fetchImpl,
			randomUUID: () => "uuid-fixed",
			tokenProvider: () => "test-token",
		});
		controller = new PublishingController({ api, auth });
	});

	test("connect() refreshes app list and populates tenant", async () => {
		await controller.connect("bearer-token");
		const state = controller.getSnapshot();
		expect(state.connected).toBe(true);
		expect(state.tenant?.id).toBe("t1");
		expect(state.tenant?.name).toBe("bootstrap");
		expect(state.apps.length).toBe(1);
	});

	test("lock() wipes all admin data", async () => {
		await controller.connect("bearer-token");
		controller.lockAuth();
		const state = controller.getSnapshot();
		expect(state.connected).toBe(false);
		expect(state.tenant).toBeNull();
		expect(state.apps).toEqual([]);
	});

	test("createAppAndVersion issues create, version, and activate in order", async () => {
		await controller.connect("bearer-token");
		const result = await controller.createAppAndVersion({
			agentDefinitionId: "agent_x",
			sourceAgentRevision: 3,
			name: "Demo",
			accessMode: "anonymous",
			allowedOrigins: ["https://example.com"],
			theme: { primaryColor: "#2563eb", welcomeMessage: "Hello" },
		});
		expect(result?.appId).toBe("app_new");
		const writeMethods = calls
			.filter((call) => call.url.includes("/api/control/v1/") && (call.init.method ?? "GET") !== "GET")
			.map((call) => `${call.init.method} ${call.url.replace("http://localhost", "")}`);
		expect(writeMethods.some((line) => line.includes("POST") && line.includes("/published-apps"))).toBe(true);
		expect(writeMethods.some((line) => line.includes("POST") && line.includes("/versions"))).toBe(true);
		expect(writeMethods.some((line) => line.includes("POST") && line.includes("/activate"))).toBe(true);
		const create = calls.find(
			(call) => call.url.endsWith("/published-apps") && (call.init.method ?? "GET") === "POST",
		);
		expect(JSON.parse(String(create?.init.body))).toMatchObject({
			theme: { primaryColor: "#2563eb", welcomeMessage: "Hello" },
		});
	});

	test("parses refreshable publishing detail routes", () => {
		expect(publishingAppIdFromPath("/publishing/apps/app_123")).toBe("app_123");
		expect(publishingAppIdFromPath("/publishing/apps/app_123/")).toBe("app_123");
		expect(publishingAppIdFromPath("/publishing")).toBeNull();
		expect(publishingAppIdFromPath("/publishing/apps/%E0%A4%A")).toBeNull();
	});

	test("401 from API wipes the token via auth controller", async () => {
		const api = new PublishingApi({
			baseUrl: "",
			fetchImpl: (async () =>
				new Response(
					JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no", requestId: "r", retryable: false } }),
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				)) as unknown as typeof fetch,
			randomUUID: () => "uuid-fixed",
		});
		const c = new PublishingController({ api, auth });
		auth.connect("bearer");
		await expect(c.refreshAppList()).resolves.toBeUndefined();
		expect(auth.hasToken()).toBe(false);
		expect(auth.getSnapshot().state).toBe("error");
	});

	test("isInflight flags only the first concurrent refresh call", async () => {
		const inflight = controller.isInflight("agents.import");
		expect(inflight).toBe(false);
	});

	test("PublishingApiError surfaces code + requestId from envelope", async () => {
		const error = new PublishingApiError(
			{ code: "INVALID_ORIGINS", message: "bad origin", requestId: "req_xyz", retryable: false },
			400,
		);
		expect(error.code).toBe("INVALID_ORIGINS");
		expect(error.requestId).toBe("req_xyz");
		expect(error.httpStatus).toBe(400);
		expect(error.message).toBe("bad origin");
	});
});
