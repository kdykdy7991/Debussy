/**
 * Tests for AppApi control client (WB-004).
 * Focus: request envelope handling + 401 → AdminAuthController lock propagation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppApi, AppApiError } from "../../src/admin/api/app-api.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

describe("AppApi", () => {
	let controller: AdminAuthController;
	let api: AppApi;

	beforeEach(() => {
		controller = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		api = new AppApi({ auth: controller });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends Authorization header with admin token", async () => {
		controller.connect("secret-token");
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: { appCount: 1 }, requestId: "r1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		const result = await client.getDashboardSummary();
		expect(result.appCount).toBe(1);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
	});

	it("throws when no token is set", async () => {
		await expect(api.getDashboardSummary()).rejects.toBeInstanceOf(AppApiError);
	});

	it("calls auth.failConnection on 401", async () => {
		controller.connect("bad-token");
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "bad", requestId: "r1" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		await expect(client.getDashboardSummary()).rejects.toBeInstanceOf(AppApiError);
		expect(controller.getSnapshot().state).toBe("error");
		expect(controller.getToken()).toBeNull();
	});

	it("includes idempotency key on POST createVersion", async () => {
		controller.connect("tok");
		let capturedHeaders: Record<string, string> | undefined;
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			capturedHeaders = init.headers as Record<string, string>;
			return new Response(
				JSON.stringify({
					data: {
						version: {
							id: "v_1",
							versionNumber: 1,
							status: "ready",
							sourceAgentRevision: 1,
							validationErrors: [],
						},
					},
					requestId: "r1",
				}),
				{ status: 201 },
			);
		});
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		await client.createVersion({ appId: "app_x", sourceAgentRevision: 1 });
		expect(capturedHeaders).toBeDefined();
		expect(capturedHeaders!["Idempotency-Key"] ?? capturedHeaders!["idempotency-key"]).toBeTruthy();
	});

	it("propagates server error message + requestId", async () => {
		controller.connect("tok");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ error: { code: "VERSION_INVALID", message: "rejected", requestId: "req_xyz" } }),
					{ status: 422, headers: { "content-type": "application/json" } },
				),
		);
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		try {
			await client.createVersion({ appId: "app_x", sourceAgentRevision: 99 });
			expect.fail("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(AppApiError);
			const appErr = err as AppApiError;
			expect(appErr.code).toBe("VERSION_INVALID");
			expect(appErr.message).toBe("rejected");
			expect(appErr.requestId).toBe("req_xyz");
			expect(appErr.httpStatus).toBe(422);
		}
	});

	it("createPublishedApp POSTs to /published-apps with an Idempotency-Key (MVP-03)", async () => {
		controller.connect("tok");
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			captured = { url, init };
			return new Response(
				JSON.stringify({
					data: {
						id: "app_new",
						publicAppId: "pub_xyz",
						status: "draft",
						currentVersionId: null,
						embedUrl: "http://127.0.0.1:8765/embed/pub_xyz",
					},
					requestId: "r1",
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		});
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		const result = await client.createPublishedApp({
			agentDefinitionId: "agent_aaa",
			name: "Demo App",
			accessMode: "anonymous",
			allowedOrigins: ["https://app.example.com"],
		});
		expect(result.id).toBe("app_new");
		expect(result.publicAppId).toBe("pub_xyz");
		expect(captured).toBeDefined();
		if (captured === undefined) throw new Error("captured missing");
		expect(captured.url).toBe("http://localhost/api/control/v1/published-apps");
		expect(captured.init.method).toBe("POST");
		const headers = captured.init.headers as Record<string, string>;
		expect(headers["Idempotency-Key"]).toBeTruthy();
		expect(headers["Idempotency-Key"].startsWith("op_app-create_")).toBe(true);
		const body = JSON.parse(captured.init.body as string) as Record<string, unknown>;
		expect(body["name"]).toBe("Demo App");
		expect(body["accessMode"]).toBe("anonymous");
		expect(body["allowedOrigins"]).toEqual(["https://app.example.com"]);
	});

	it("createPublishedApp rejects INVALID_ORIGINS without sending an Idempotency-Key replay", async () => {
		controller.connect("tok");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: { code: "INVALID_ORIGINS", message: "bad origin", requestId: "r2" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		);
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		await expect(
			client.createPublishedApp({
				agentDefinitionId: "agent_aaa",
				name: "Demo App",
				accessMode: "mixed",
				allowedOrigins: ["not-a-url"],
			}),
		).rejects.toMatchObject({ code: "INVALID_ORIGINS", httpStatus: 400 });
		// Token must remain set: only 401 transitions to lock state.
		expect(controller.getToken()).toBe("tok");
	});

	it("updatePublishedApp PATCHes /published-apps/:id with an Idempotency-Key", async () => {
		controller.connect("tok");
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			captured = { url, init };
			return new Response(
				JSON.stringify({
					data: {
						app: {
							id: "app_x",
							publicAppId: "pub_x",
							status: "draft",
							currentVersionId: null,
						},
						auditEventId: "audit_x",
					},
					requestId: "r1",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		const result = await client.updatePublishedApp("app_x", {
			name: "Renamed",
			allowedOrigins: ["http://127.0.0.1:5176"],
		});
		expect(result.app.id).toBe("app_x");
		expect(result.auditEventId).toBe("audit_x");
		expect(captured).toBeDefined();
		if (captured === undefined) throw new Error("captured missing");
		expect(captured.url).toBe("http://localhost/api/control/v1/published-apps/app_x");
		expect(captured.init.method).toBe("PATCH");
		const headers = captured.init.headers as Record<string, string>;
		expect(headers["Idempotency-Key"]).toBeTruthy();
		const body = JSON.parse(captured.init.body as string) as Record<string, unknown>;
		expect(body["name"]).toBe("Renamed");
		expect(body["allowedOrigins"]).toEqual(["http://127.0.0.1:5176"]);
	});

	it("updatePublishedApp encodes appId in the path", async () => {
		controller.connect("tok");
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: { app: { id: "a" }, auditEventId: null }, requestId: "r" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		await client.updatePublishedApp("app with space", { name: "x" });
		const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://localhost/api/control/v1/published-apps/app%20with%20space");
	});

	it("updatePublishedApp propagates server error", async () => {
		controller.connect("tok");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: { code: "APP_NOT_FOUND", message: "no app", requestId: "r_nf" },
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				),
		);
		const client = new AppApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });
		await expect(client.updatePublishedApp("app_x", { name: "x" })).rejects.toMatchObject({
			code: "APP_NOT_FOUND",
			httpStatus: 404,
		});
	});
});
