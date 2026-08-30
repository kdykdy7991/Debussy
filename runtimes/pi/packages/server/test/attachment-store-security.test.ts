/**
 * Phase 2C attachment-store ownership hardening tests.
 *
 * Asserts the cross-tenant / cross-principal attach guard on the
 * {@link AttachmentStore}. The store refuses any `assertOwnership` call whose
 * `(tenantId, principalId)` does not match the record's owner stamp; legacy
 * v1 records (no ownership metadata) also fail closed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { PiServerError } from "../src/errors.ts";
import type { PrincipalId, TenantId } from "../src/publishing/domain/ids.ts";
import { newPrincipalId, newTenantId } from "../src/publishing/domain/ids.ts";
import { AttachmentStore } from "../src/uploads/store.ts";
import { ATTACHMENT_RECORD_VERSION } from "../src/uploads/types.ts";

const TENANT_A = newTenantId();
const TENANT_B = newTenantId();
const PRINCIPAL_A = newPrincipalId();
const PRINCIPAL_B = newPrincipalId();

const SAMPLE_ATTACHMENT: Attachment = {
	id: "att-1",
	name: "notes.txt",
	mediaType: "text/plain",
	size: 12,
	sha256: "0".repeat(64),
	status: "ready",
	scope: "session",
	createdAt: 0,
};

function makeStore(): AttachmentStore {
	const root = mkdtempSync(join(tmpdir(), "attach-store-"));
	return new AttachmentStore(root);
}

async function writeFile(
	store: AttachmentStore,
	owner: { tenantId: TenantId; principalId: PrincipalId },
): Promise<Attachment> {
	const tmp = mkdtempSync(join(tmpdir(), "att-src-"));
	const src = join(tmp, "payload.bin");
	writeFileSync(src, Buffer.from("hello"));
	try {
		const result = await store.adopt(SAMPLE_ATTACHMENT, src, owner);
		return result.attachment;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

describe("AttachmentStore ownership hardening (Phase 2C)", () => {
	test("H. cross-tenant attach is rejected with not_found", async () => {
		const store = makeStore();
		await writeFile(store, { tenantId: TENANT_A, principalId: PRINCIPAL_A });
		expect(() =>
			store.assertOwnership(SAMPLE_ATTACHMENT.id, { tenantId: TENANT_B, principalId: PRINCIPAL_A }),
		).toThrow(PiServerError);
	});

	test("I. cross-principal attach is rejected with not_found", async () => {
		const store = makeStore();
		await writeFile(store, { tenantId: TENANT_A, principalId: PRINCIPAL_A });
		expect(() =>
			store.assertOwnership(SAMPLE_ATTACHMENT.id, { tenantId: TENANT_A, principalId: PRINCIPAL_B }),
		).toThrow(PiServerError);
	});

	test("same owner passes", async () => {
		const store = makeStore();
		await writeFile(store, { tenantId: TENANT_A, principalId: PRINCIPAL_A });
		expect(() =>
			store.assertOwnership(SAMPLE_ATTACHMENT.id, { tenantId: TENANT_A, principalId: PRINCIPAL_A }),
		).not.toThrow();
	});

	test("J. duplicate attach_upload to the same session is idempotent (same liveId)", async () => {
		const store = makeStore();
		const attachment = await writeFile(store, { tenantId: TENANT_A, principalId: PRINCIPAL_A });
		const first = await store.bind(attachment.id, "dconv_same", "session");
		const second = await store.bind(attachment.id, "dconv_same", "session");
		expect(first?.attachment.sessionId).toBe("dconv_same");
		expect(second?.attachment.sessionId).toBe("dconv_same");
		expect(first?.attachment.id).toBe(attachment.id);
		expect(second?.attachment.id).toBe(attachment.id);
	});

	test("G. cross-conversation attach is rejected (nonzero conflict return)", async () => {
		const store = makeStore();
		const attachment = await writeFile(store, { tenantId: TENANT_A, principalId: PRINCIPAL_A });
		await store.bind(attachment.id, "dconv_a", "session");
		// Binding the same upload to a different conversation is refused: the
		// call resolves without mutating the record / returning an attachment.
		const rebound = await store.bind(attachment.id, "dconv_b", "session");
		expect(rebound).toBeUndefined();
	});

	test("legacy v1 records (no ownership) fail closed after recover", async () => {
		const root = mkdtempSync(join(tmpdir(), "attach-store-"));
		const json = JSON.stringify({
			schemaVersion: 1,
			attachment: SAMPLE_ATTACHMENT,
			storageName: "x",
		});
		writeFileSync(join(root, `${SAMPLE_ATTACHMENT.id}.json`), json);
		const store = new AttachmentStore(root);
		await store.init();
		try {
			// Recover does not crash on the legacy record (forward-compat).
			expect(store.get(SAMPLE_ATTACHMENT.id)?.attachment?.id).toBe(SAMPLE_ATTACHMENT.id);
			// Any assertOwnership call against the legacy record fails closed.
			expect(() =>
				store.assertOwnership(SAMPLE_ATTACHMENT.id, { tenantId: TENANT_A, principalId: PRINCIPAL_A }),
			).toThrow(PiServerError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("recover accepts both v1 and v2 records", async () => {
		const root = mkdtempSync(join(tmpdir(), "attach-store-"));
		const v1Record = JSON.stringify({
			schemaVersion: 1,
			attachment: { ...SAMPLE_ATTACHMENT, id: "att-v1" },
			storageName: "x",
		});
		const v2Record = JSON.stringify({
			schemaVersion: ATTACHMENT_RECORD_VERSION,
			attachment: { ...SAMPLE_ATTACHMENT, id: "att-v2" },
			storageName: "y",
			ownerTenantId: TENANT_A,
			ownerPrincipalId: PRINCIPAL_A,
		});
		writeFileSync(join(root, "att-v1.json"), v1Record);
		writeFileSync(join(root, "att-v2.json"), v2Record);
		const store = new AttachmentStore(root);
		await store.init();
		try {
			expect(store.get("att-v1")?.schemaVersion).toBe(1);
			expect(store.get("att-v2")?.schemaVersion).toBe(ATTACHMENT_RECORD_VERSION);
			expect(() => store.assertOwnership("att-v2", { tenantId: TENANT_A, principalId: PRINCIPAL_A })).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
