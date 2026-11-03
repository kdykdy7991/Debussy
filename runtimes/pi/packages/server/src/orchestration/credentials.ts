import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const sealedSchema = z.object({ nonce: z.string(), ciphertext: z.string(), tag: z.string() }).strict();

export function credentialHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Separate encryption namespace; keys never enter the RuntimeSpec or model history. */
export class WorkCredentialBox {
	private readonly key: Buffer;
	constructor(key: Uint8Array) {
		if (key.length !== 32) throw new Error("Orchestration requires a 32-byte credential master key");
		this.key = Buffer.from(key);
	}

	seal(scope: string, credentials: Readonly<Record<string, string>>) {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(`debussy:orchestration:v1:${scope}`));
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
		return {
			nonce: nonce.toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
		};
	}

	open(scope: string, sealed: unknown): Readonly<Record<string, string>> {
		const value = sealedSchema.parse(sealed);
		const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.nonce, "base64"));
		decipher.setAAD(Buffer.from(`debussy:orchestration:v1:${scope}`));
		decipher.setAuthTag(Buffer.from(value.tag, "base64"));
		return z
			.record(z.string(), z.string())
			.parse(
				JSON.parse(
					Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString(
						"utf8",
					),
				),
			);
	}
}
