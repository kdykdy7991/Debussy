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
});
