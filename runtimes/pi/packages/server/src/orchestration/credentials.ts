import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { OrchestrationError } from "./contracts.ts";

const sealedSchema = z.object({ nonce: z.string(), ciphertext: z.string(), tag: z.string() }).strict();

export function credentialHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** One credential value sealed under its own scope; the scope is the AES-GCM AAD. */
export interface SealedCredentialValue {
	readonly nonce: string;
	readonly ciphertext: string;
	readonly tag: string;
}

/** A sealed value together with the only scope that opens it. */
export interface ScopedSealedCredential {
	readonly scope: string;
	readonly sealed: SealedCredentialValue;
}

/**
 * The dimension a credential belongs to inside one Run: the connection of one
 * MCP Server, or the parameter credential of one Tool of that Server.
 */
export type CredentialDimension =
	| { readonly kind: "connection"; readonly serverId: string }
	| {
			readonly kind: "tool";
			readonly serverId: string;
			readonly toolName: string;
			readonly credentialId: string;
	  };

/** One Run credential: its flat name, its dimension, its scope and its own sealed value. */
export interface WorkCredentialEntry {
	readonly name: string;
	readonly dimension: CredentialDimension;
	readonly scope: string;
	readonly sealed: SealedCredentialValue;
}

/** New-Key Runs persist one independently sealed value per credential. */
export interface WorkCredentialSet {
	readonly version: 2;
	readonly entries: readonly WorkCredentialEntry[];
}

const dimensionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("connection"), serverId: z.string().min(1) }).strict(),
	z
		.object({
			kind: z.literal("tool"),
			serverId: z.string().min(1),
			toolName: z.string().min(1),
			credentialId: z.string().min(1),
		})
		.strict(),
]);

const entrySchema = z
	.object({
		name: z.string().min(1),
		dimension: dimensionSchema,
		scope: z.string().min(1),
		sealed: sealedSchema,
	})
	.strict();

const setSchema = z.object({ version: z.literal(2), entries: z.array(entrySchema) }).strict();

/** Returns the stored set when the row holds new-Key per-dimension credentials, otherwise null. */
export function parseWorkCredentialSet(value: unknown): WorkCredentialSet | null {
	const parsed = setSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** Separate encryption namespace; keys never enter the RuntimeSpec or model history. */
export class WorkCredentialBox {
	private readonly key: Buffer;
	constructor(key: Uint8Array) {
		if (key.length !== 32) throw new Error("Orchestration requires a 32-byte credential master key");
		this.key = Buffer.from(key);
	}

	/** Legacy Runs seal every credential of the Run as one blob under one scope. */
	seal(scope: string, credentials: Readonly<Record<string, string>>): SealedCredentialValue {
		return this.sealBytes(scope, Buffer.from(JSON.stringify(credentials), "utf8"));
	}

	open(scope: string, sealed: unknown): Readonly<Record<string, string>> {
		return z.record(z.string(), z.string()).parse(JSON.parse(this.openBytes(scope, sealed).toString("utf8")));
	}

	/** Seals one value under its own scope. */
	sealValue(scope: string, value: string): SealedCredentialValue {
		return this.sealBytes(scope, Buffer.from(value, "utf8"));
	}

	/** Opens one value; any other scope fails the GCM tag check. */
	openValue(scope: string, sealed: unknown): string {
		return this.openBytes(scope, sealed).toString("utf8");
	}

	/** Seals several values, each bound to its own scope. */
	sealMany(entries: readonly { readonly scope: string; readonly value: string }[]): readonly ScopedSealedCredential[] {
		return entries.map((entry) => ({ scope: entry.scope, sealed: this.sealValue(entry.scope, entry.value) }));
	}

	/** Reads back the value sealed under exactly this scope; other scopes never open. */
	openMany(scope: string, sealed: readonly unknown[]): string {
		const entries = z.array(z.object({ scope: z.string(), sealed: sealedSchema }).strict()).parse(sealed);
		const match = entries.find((entry) => entry.scope === scope);
		if (!match) throw new OrchestrationError(403, "CREDENTIAL_SCOPE_MISMATCH", "凭据作用域不匹配");
		return this.openValue(scope, match.sealed);
	}

	private sealBytes(scope: string, plaintext: Buffer): SealedCredentialValue {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(`debussy:orchestration:v1:${scope}`));
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return {
			nonce: nonce.toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
		};
	}

	private openBytes(scope: string, sealed: unknown): Buffer {
		const value = sealedSchema.parse(sealed);
		const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.nonce, "base64"));
		decipher.setAAD(Buffer.from(`debussy:orchestration:v1:${scope}`));
		decipher.setAuthTag(Buffer.from(value.tag, "base64"));
		return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
	}
}
