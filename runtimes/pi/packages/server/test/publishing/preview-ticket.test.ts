import { describe, expect, test, vi } from "vitest";
import { PREVIEW_TICKET_DEFAULT_TTL_SEC, PreviewTicketService } from "../../src/publishing/preview-ticket.ts";

const tenantId = "11111111-1111-4111-8111-111111111111" as never;
const appId = "22222222-2222-4222-8222-222222222222" as never;
const versionId = "33333333-3333-4333-8333-333333333333" as never;
const publicAppId = "pub_44444444-4444-4444-8444-444444444444";

function service(): PreviewTicketService {
	return new PreviewTicketService({ adminToken: "admin-secret", embedBaseUrl: "https://embed.example.test" });
}

describe("preview tickets", () => {
	test("uses a ticket-free URL and only consumes once for its exact app and origin", async () => {
		const tickets = service();
		const issued = await tickets.issue({ tenantId, appId, versionId, publicAppId });
		expect(issued.previewUrl).toBe(`https://embed.example.test/preview/${publicAppId}`);
		expect(issued.previewUrl).not.toContain("ticket");
		expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

		const wrongApp = await tickets.consume({
			publicAppId: "pub_55555555-5555-4555-8555-555555555555",
			origin: "https://embed.example.test",
			ticket: issued.ticket,
		});
		expect(wrongApp).toEqual({ ok: false, code: "INVALID" });

		const accepted = await tickets.consume({
			publicAppId,
			origin: "https://embed.example.test",
			ticket: issued.ticket,
		});
		expect(accepted).toMatchObject({ ok: true, appId, versionId, tenantId });
		const replay = await tickets.consume({
			publicAppId,
			origin: "https://embed.example.test",
			ticket: issued.ticket,
		});
		expect(replay).toEqual({ ok: false, code: "ALREADY_CONSUMED" });
	});

	test("enforces expiration", async () => {
		vi.useFakeTimers();
		try {
			const tickets = service();
			const issued = await tickets.issue({ tenantId, appId, versionId, publicAppId, ttlSeconds: 60 });
			vi.advanceTimersByTime((60 + 31) * 1000);
			const expired = await tickets.consume({
				publicAppId,
				origin: "https://embed.example.test",
				ticket: issued.ticket,
			});
			expect(expired).toEqual({ ok: false, code: "EXPIRED" });
		} finally {
			vi.useRealTimers();
		}
	});

	test("clamps the requested TTL", async () => {
		const tickets = service();
		const before = Date.now();
		const issued = await tickets.issue({ tenantId, appId, versionId, publicAppId, ttlSeconds: 1 });
		expect(Date.parse(issued.expiresAt) - before).toBeGreaterThanOrEqual(59_000);
		expect(PREVIEW_TICKET_DEFAULT_TTL_SEC).toBe(300);
	});
});
