import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsApi } from "../../src/admin/api/conversations-api.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

describe("ConversationsApi", () => {
	let controller: AdminAuthController;

	beforeEach(() => {
		controller = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		controller.connect("admin-token");
	});

	it("serializes advanced list filters and cursor", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: { items: [], nextCursor: null, redacted: true }, requestId: "req_1" })),
		);
		const api = new ConversationsApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });

		await api.list({
			limit: 25,
			cursor: "cursor value",
			appId: "app_1",
			agentId: "agent_1",
			publishedAppVersionId: "pav_1",
			createdAfter: "2026-08-01T00:00:00.000Z",
			createdBefore: "2026-08-18T00:00:00.000Z",
		});

		const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const parsed = new URL(url);
		expect(parsed.pathname).toBe("/api/control/v1/conversations");
		expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
			limit: "25",
			cursor: "cursor value",
			appId: "app_1",
			agentId: "agent_1",
			publishedAppVersionId: "pav_1",
			createdAfter: "2026-08-01T00:00:00.000Z",
			createdBefore: "2026-08-18T00:00:00.000Z",
		});
	});

	it("downloads a gzip export with authorization", async () => {
		const body = new Uint8Array([31, 139, 8]);
		const fetchMock = vi.fn(
			async () => new Response(body, { headers: { "content-type": "application/jsonl+gzip" } }),
		);
		const api = new ConversationsApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });

		const blob = await api.downloadExport("conv/a", "transcript");

		expect(blob.size).toBe(body.byteLength);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://localhost/api/control/v1/conversations/conv%2Fa/export?mode=transcript");
		expect(init.headers).toMatchObject({
			Authorization: "Bearer admin-token",
			Accept: "application/jsonl+gzip",
		});
	});

	it("propagates export errors and locks authentication on 401", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "expired", requestId: "req_2" } }), {
					status: 401,
				}),
		);
		const api = new ConversationsApi({ auth: controller, fetchImpl: fetchMock as unknown as typeof fetch });

		await expect(api.downloadExport("conv_1", "full")).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			httpStatus: 401,
			requestId: "req_2",
		});
		expect(controller.getToken()).toBeNull();
	});
});
