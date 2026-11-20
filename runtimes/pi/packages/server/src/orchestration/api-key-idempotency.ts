import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../publishing/runtime-spec/hash.ts";
import { OrchestrationError } from "./contracts.ts";

export const CANONICALIZATION_VERSION = 1;
const DOMAIN = "debussy:aaas:idempotency:v1";

/** A stored replay record: versions are facts, never re-derived from current config. */
export interface IdempotencyRecord {
	readonly requestHash: string;
	readonly canonicalizationVersion: number;
	readonly digestKeyVersion: number;
	readonly workItemId: string;
}

/** What `digest` produces: the same shape as a stored record before the Run is known. */
export type IdempotencyDigest = Omit<IdempotencyRecord, "workItemId">;

function deriveKey(masterKey: Uint8Array, version: number): Buffer {
	return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), `${DOMAIN}:key:${version}`, 32));
}

/**
 * Server-side, versioned HMAC-SHA256 digests. The key material comes from the
 * controlled platform master key, never from an API Key. Historical versions are
 * retained so every still-present replay record can be recomputed after rotation;
 * a missing version is a service error, never a 409 or a new Run.
 */
export class IdempotencyKeyring {
	private readonly keys = new Map<number, Buffer>();
	private readonly currentVersion: number;

	constructor(options: {
		readonly masterKey: Uint8Array;
		readonly currentVersion?: number;
		readonly historicalMasterKeys?: Readonly<Record<number, Uint8Array>>;
	}) {
		this.currentVersion = options.currentVersion ?? 1;
		for (const [version, master] of Object.entries(options.historicalMasterKeys ?? {}))
			this.keys.set(Number(version), deriveKey(master, Number(version)));
		this.keys.set(this.currentVersion, deriveKey(options.masterKey, this.currentVersion));
	}

	get version(): number {
		return this.currentVersion;
	}

	private payload(request: unknown, canonicalizationVersion: number): string {
		return canonicalJson({ domain: DOMAIN, canonicalizationVersion, request });
	}

	digest(request: unknown): IdempotencyDigest {
		const key = this.keys.get(this.currentVersion);
		if (!key) throw new OrchestrationError(500, "IDEMPOTENCY_KEY_UNAVAILABLE", "幂等摘要密钥版本不可用");
		return {
			requestHash: createHmac("sha256", key).update(this.payload(request, CANONICALIZATION_VERSION)).digest("hex"),
			canonicalizationVersion: CANONICALIZATION_VERSION,
			digestKeyVersion: this.currentVersion,
		};
	}

	/** Replay comparison uses the versions saved on the winning record. */
	matches(request: unknown, stored: IdempotencyDigest): boolean {
		if (stored.canonicalizationVersion !== CANONICALIZATION_VERSION)
			throw new OrchestrationError(500, "IDEMPOTENCY_VERSION_UNAVAILABLE", "幂等规范化版本不可用");
		const key = this.keys.get(stored.digestKeyVersion);
		if (!key) throw new OrchestrationError(500, "IDEMPOTENCY_KEY_UNAVAILABLE", "幂等摘要密钥版本不可用");
		const expected = createHmac("sha256", key).update(this.payload(request, stored.canonicalizationVersion)).digest();
		const actual = Buffer.from(stored.requestHash, "hex");
		return expected.length === actual.length && timingSafeEqual(expected, actual);
	}
}
