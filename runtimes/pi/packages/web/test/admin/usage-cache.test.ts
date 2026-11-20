import type { AdminUsageSummary } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageApi } from "../../src/admin/api/usage-api.ts";
import { UsageCache } from "../../src/admin/api/usage-cache.ts";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

const from = new Date("2026-11-01T16:00:00Z");
const summary = (id: string) => ({ generatedAt: id }) as AdminUsageSummary;

async function setup() {
	const auth = new AdminAuthController();
	auth.connect("token");
	await auth.completeConnection({ id: "tenant-a", name: "A" });
	const fetchImpl = vi.fn<typeof fetch>();
	return { auth, fetchImpl, cache: new UsageCache(auth, new UsageApi({ auth, fetchImpl })) };
}

function response(id: string): Response {
	return new Response(JSON.stringify({ data: summary(id) }), { status: 200 });
}

afterEach(() => vi.useRealTimers());

describe("UsageCache", () => {
	it("caches successful rolling queries, ages after 60 seconds, and force refreshes", async () => {
		vi.useFakeTimers();
		const { cache, fetchImpl } = await setup();
		fetchImpl.mockResolvedValueOnce(response("first")).mockResolvedValueOnce(response("refreshed"));
		expect(cache.get(from)).toBeUndefined();
		await cache.request(from);
		const entry = cache.get(from);
		expect(entry?.summary.generatedAt).toBe("first");
		expect(entry && cache.isFresh(entry)).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60_000);
		expect(entry && cache.isFresh(entry)).toBe(false);
		expect(cache.get(from)?.summary.generatedAt).toBe("first");
		await cache.request(from, true);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(cache.get(from)?.summary.generatedAt).toBe("refreshed");
		expect(cache.get(new Date("2026-11-02T16:00:00Z"))).toBeUndefined();
	});

	it("deduplicates concurrent requests and keeps cached data after failure", async () => {
		const { cache, fetchImpl } = await setup();
		fetchImpl.mockResolvedValueOnce(response("first")).mockRejectedValueOnce(new Error("offline"));
		const first = cache.request(from);
		expect(cache.request(from)).toBe(first);
		await first;
		await expect(cache.request(from, true)).rejects.toThrow("offline");
		expect(cache.get(from)?.summary.generatedAt).toBe("first");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("clears on reconnect or tenant change and rejects old in-flight writes", async () => {
		const { auth, cache, fetchImpl } = await setup();
		let resolve!: (value: Response) => void;
		fetchImpl.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const pending = cache.request(from);
		auth.lock();
		auth.connect("another-token");
		await auth.completeConnection({ id: "tenant-b", name: "B" });
		resolve(response("old"));
		await pending;
		expect(cache.get(from)).toBeUndefined();
		fetchImpl.mockResolvedValueOnce(response("new"));
		await cache.request(from);
		expect(cache.get(from)?.summary.generatedAt).toBe("new");
		await auth.completeConnection({ id: "tenant-a", name: "A" });
		expect(cache.get(from)).toBeUndefined();
	});

	it("does not let a slower replaced request overwrite a forced refresh", async () => {
		const { cache, fetchImpl } = await setup();
		let resolve!: (value: Response) => void;
		fetchImpl.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		fetchImpl.mockResolvedValueOnce(response("new"));
		const old = cache.request(from);
		await cache.request(from, true);
		resolve(response("old"));
		await old;
		expect(cache.get(from)?.summary.generatedAt).toBe("new");
	});
});
