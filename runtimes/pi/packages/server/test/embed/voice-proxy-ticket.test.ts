import { describe, expect, test } from "vitest";
import { createVoiceProxyTicketService } from "../../src/embed/auth/voice-proxy-ticket.ts";
import type { TicketStore } from "../../src/embed/auth/ws-ticket.ts";
import { runtimeSpecAllowsRealtimeVoice } from "../../src/embed/voice-engine-ticket-http.ts";
import { newPrincipalId, newPublishedAppId, newTenantId } from "../../src/publishing/domain/ids.ts";
import { compileRuntimeSpec } from "../../src/publishing/runtime-spec/compiler.ts";

function memoryStore(): TicketStore {
	const values = new Map<string, string>();
	return {
		async set(hash, claims) {
			values.set(hash, claims);
		},
		async consume(hash) {
			const value = values.get(hash) ?? null;
			values.delete(hash);
			return value;
		},
	};
}

describe("Voice Proxy Ticket", () => {
	test("authorizes the new realtimeVoice capability, never legacy speech", () => {
		const spec = (realtimeVoice: boolean, speech: boolean) => {
			const result = compileRuntimeSpec({
				agent: {
					prompt: "voice",
					model: { provider: "test", modelId: "model" },
					realtimeVoice: { enabled: realtimeVoice },
					speech: { enabled: speech },
				},
				publishedAppVersionId: "pav_test",
				catalog: { models: [{ provider: "test", modelId: "model" }], tools: [], knowledgeBases: [] },
			});
			if (!result.ok) throw new Error(result.errors.join(", "));
			return result.spec;
		};
		expect(runtimeSpecAllowsRealtimeVoice(spec(false, true))).toBe(false);
		expect(runtimeSpecAllowsRealtimeVoice(spec(true, false))).toBe(true);
	});

	test("issues purpose-scoped claims and consumes exactly once", async () => {
		const tickets = createVoiceProxyTicketService(memoryStore());
		const issued = await tickets.issue({
			tenantId: newTenantId(),
			publishedAppId: newPublishedAppId(),
			principalId: newPrincipalId(),
			principalType: "anonymous_visitor",
			tokenId: "token-1",
			origin: "https://host.example",
		});
		const claims = await tickets.consume(issued.ticket, { origin: "https://host.example" });
		expect(claims).toMatchObject({ purpose: "voice-engine", tokenId: "token-1" });
		expect(await tickets.consume(issued.ticket, { origin: "https://host.example" })).toBeNull();
	});

	test("origin mismatch consumes and rejects the ticket", async () => {
		const tickets = createVoiceProxyTicketService(memoryStore());
		const issued = await tickets.issue({
			tenantId: newTenantId(),
			publishedAppId: newPublishedAppId(),
			principalId: newPrincipalId(),
			principalType: "anonymous_visitor",
			tokenId: "token-2",
			origin: "https://host.example",
		});
		expect(await tickets.consume(issued.ticket, { origin: "https://evil.example" })).toBeNull();
		expect(await tickets.consume(issued.ticket, { origin: "https://host.example" })).toBeNull();
	});
});
