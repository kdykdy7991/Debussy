/**
 * TASK-015: Embed Access Token 单元测试（spec 7.3 / 24.1）。
 *
 * 覆盖：签发 -> 验签往返、claims 只授权一个 tenant/app/principal、错误密钥 /
 * 过期 / 篡改 / 错误 audience 全部拒绝。不依赖数据库，纯 JWS 行为。
 */
import { generateKeyPair } from "jose";
import { describe, expect, test } from "vitest";
import { AccessTokenService, type EmbedAccessKey } from "../../src/embed/auth/access-token.ts";
import { newPrincipalId, newPublishedAppId, newTenantId } from "../../src/publishing/domain/ids.ts";

/** 每个 service 使用各自生成的 Ed25519 密钥对；override 只允许非密钥字段。 */
async function makeService(
	overrides: Partial<Omit<ConstructorParameters<typeof AccessTokenService>[0], "privateKey" | "publicKey">> = {},
): Promise<AccessTokenService> {
	return new AccessTokenService({
		issuer: "https://agent.example.com",
		keyId: "kid-test-1",
		ttlSeconds: 600,
		...(await generateKeyPair("Ed25519")),
		...overrides,
	});
}

function signInput() {
	return {
		tenantId: newTenantId(),
		publishedAppId: newPublishedAppId(),
		principalId: newPrincipalId(),
		principalType: "anonymous_visitor" as const,
	};
}

describe("embed access token service", () => {
	test("sign -> verify roundtrips the scoped claims", async () => {
		const service = await makeService();
		const input = { ...signInput(), scopes: [], publishedAppVersionId: null };
		const { token, expiresAt } = await service.sign(input);
		expect(token.split(".")).toHaveLength(3);
		const verified = await service.verify(token);
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.claims.tenantId).toBe(input.tenantId);
		expect(verified.claims.publishedAppId).toBe(input.publishedAppId);
		expect(verified.claims.principalId).toBe(input.principalId);
		expect(verified.claims.principalType).toBe("anonymous_visitor");
		expect(verified.claims.publishedAppVersionId).toBeNull();
		expect(verified.claims.tokenId).toMatch(/^[0-9a-f-]{36}$/);
		// JWT 的 exp 是秒级精度，返回的 expiresAt 按秒对齐后一致。
		expect(verified.claims.expiresAt.getTime()).toBe(Math.floor(expiresAt.getTime() / 1000) * 1000);
		// TTL 语义：exp - iat == ttlSeconds（都以 JWT 秒级精度为准）。
		expect(verified.claims.expiresAt.getTime() - verified.claims.issuedAt.getTime()).toBe(600_000);
	});

	test("a version id is carried into the claims when present", async () => {
		const service = await makeService();
		const { token } = await service.sign({ ...signInput(), publishedAppVersionId: "pav-version-1" });
		const verified = await service.verify(token);
		expect(verified.ok).toBe(true);
		if (verified.ok) expect(verified.claims.publishedAppVersionId).toBe("pav-version-1");
	});

	test("verify rejects a token signed by a different key", async () => {
		const signer = await makeService();
		const verifier = await makeService(); // 另一个独立密钥对
		const { token } = await signer.sign(signInput());
		const result = await verifier.verify(token);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("TOKEN_INVALID");
	});

	test("verify rejects an expired token", async () => {
		const service = await makeService({ ttlSeconds: -10 });
		const { token } = await service.sign(signInput());
		const result = await service.verify(token);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("TOKEN_EXPIRED");
	});

	test("verify rejects a tampered token", async () => {
		const service = await makeService();
		const { token } = await service.sign(signInput());
		const [header, payload, signature] = token.split(".");
		const forged = Buffer.from(
			JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), principalId: "forged" }),
		).toString("base64url");
		const result = await service.verify(`${header}.${forged}.${signature}`);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("TOKEN_INVALID");
	});

	test("verify rejects a token issued for another audience", async () => {
		const keys = (await generateKeyPair("Ed25519")) as {
			privateKey: EmbedAccessKey;
			publicKey: EmbedAccessKey;
		};
		const signer = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "k",
			ttlSeconds: 600,
			...keys,
			audience: "skdy-embed-access",
		});
		const verifier = new AccessTokenService({
			issuer: "https://agent.example.com",
			keyId: "k",
			ttlSeconds: 600,
			...keys,
			audience: "another-audience",
		});
		const { token } = await signer.sign(signInput());
		const result = await verifier.verify(token);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("TOKEN_INVALID");
	});
});
