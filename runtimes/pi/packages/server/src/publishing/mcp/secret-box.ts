import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { McpServerId, TenantId } from "../domain/ids.ts";

export interface McpSealedSecret {
	readonly ciphertext: Uint8Array;
	readonly nonce: Uint8Array;
	readonly authTag: Uint8Array;
	readonly keyVersion: number;
}

const ALGORITHM = "aes-256-gcm";

function additionalData(tenantId: TenantId, mcpServerId: McpServerId): Buffer {
	return Buffer.from(`debussy:mcp-secret:v1:${tenantId}:${mcpServerId}`, "utf8");
}

/** Small encryption boundary; persistence never receives plaintext credentials. */
export class McpSecretBox {
	private readonly key: Buffer;
	private readonly keyVersion: number;

	constructor(masterKey: Uint8Array, keyVersion = 1) {
		if (masterKey.byteLength !== 32) throw new Error("MCP secret master key must be exactly 32 bytes");
		this.key = Buffer.from(masterKey);
		this.keyVersion = keyVersion;
	}

	seal(tenantId: TenantId, mcpServerId: McpServerId, plaintext: string): McpSealedSecret {
		if (plaintext.length === 0) throw new Error("MCP secret must not be empty");
		const nonce = randomBytes(12);
		const cipher = createCipheriv(ALGORITHM, this.key, nonce);
		cipher.setAAD(additionalData(tenantId, mcpServerId));
		const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
		return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: this.keyVersion };
	}

	open(tenantId: TenantId, mcpServerId: McpServerId, sealed: McpSealedSecret): string {
		if (sealed.keyVersion !== this.keyVersion) throw new Error("Unsupported MCP secret key version");
		const decipher = createDecipheriv(ALGORITHM, this.key, sealed.nonce);
		decipher.setAAD(additionalData(tenantId, mcpServerId));
		decipher.setAuthTag(sealed.authTag);
		return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
	}
}
