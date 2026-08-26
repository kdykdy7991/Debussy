import { describe, expect, it } from "vitest";
import { newMcpServerId, newTenantId } from "../../src/publishing/domain/ids.ts";
import { McpSecretBox } from "../../src/publishing/mcp/secret-box.ts";

describe("McpSecretBox", () => {
	it("encrypts and authenticates bearer credentials", () => {
		const tenantId = newTenantId();
		const serverId = newMcpServerId();
		const box = new McpSecretBox(new Uint8Array(32).fill(7));
		const sealed = box.seal(tenantId, serverId, "top-secret-token");

		expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("top-secret-token");
		expect(box.open(tenantId, serverId, sealed)).toBe("top-secret-token");
	});

	it("rejects ciphertext moved to another tenant or server", () => {
		const tenantId = newTenantId();
		const serverId = newMcpServerId();
		const box = new McpSecretBox(new Uint8Array(32).fill(9));
		const sealed = box.seal(tenantId, serverId, "top-secret-token");

		expect(() => box.open(newTenantId(), serverId, sealed)).toThrow();
		expect(() => box.open(tenantId, newMcpServerId(), sealed)).toThrow();
	});

	it("requires an AES-256 key", () => {
		expect(() => new McpSecretBox(new Uint8Array(31))).toThrow("exactly 32 bytes");
	});
});
