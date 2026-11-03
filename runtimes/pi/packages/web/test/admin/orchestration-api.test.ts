import { afterEach, expect, test, vi } from "vitest";
import { OrchestrationApi } from "../../src/admin/api/orchestration-api.ts";
import { parseRoute } from "../../src/admin/router.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

afterEach(() => vi.unstubAllGlobals());

test("configuration updates carry the expected revision and keep tokens out of the URL", async () => {
	const auth = new AdminAuthController({ initialBaseUrl: "http://localhost" });
	auth.connect("admin-test-token");
	const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { revision: 2 } }), { status: 200 }));
	vi.stubGlobal("fetch", fetch);
	const api = new OrchestrationApi(auth);
	await expect(
		api.request("integrations/test/configuration", "PUT", { expectedRevision: 1, systemPrompt: "test" }),
	).resolves.toEqual({ revision: 2 });
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	expect(url).not.toContain("admin-test-token");
	expect(init.body).toBe(JSON.stringify({ expectedRevision: 1, systemPrompt: "test" }));
	expect(parseRoute("/orchestration").id).toBe("orchestration");
});

test("failed authentication wipes the admin token and blocks subsequent calls", async () => {
	const auth = new AdminAuthController();
	auth.connect("admin-test-token");
	const fetch = vi.fn(
		async () => new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 }),
	);
	vi.stubGlobal("fetch", fetch);
	const api = new OrchestrationApi(auth);
	await expect(api.request("work-items")).rejects.toThrow("unauthorized");
	expect(auth.getToken()).toBeNull();
	await expect(api.request("work-items")).rejects.toThrow("管理员尚未认证");
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("configuration conflicts preserve their status and request cancellation is forwarded", async () => {
	const auth = new AdminAuthController();
	auth.connect("test");
	const fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ error: { code: "CONFIGURATION_CONFLICT", message: "配置已更新" } }), {
				status: 409,
			}),
	);
	vi.stubGlobal("fetch", fetch);
	const signal = new AbortController().signal;
	await expect(
		new OrchestrationApi(auth).request("integrations/test/configuration", "PUT", {}, signal),
	).rejects.toMatchObject({ status: 409, code: "CONFIGURATION_CONFLICT", message: "配置已更新" });
	expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(signal);
	expect(auth.getToken()).toBe("test");
});
