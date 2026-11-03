import { z } from "zod";
import { canonicalJson } from "../publishing/runtime-spec/hash.ts";
import { eventSchema, OrchestrationError } from "./contracts.ts";
import { credentialHash } from "./credentials.ts";
import type { IntegrationRecord, OrchestrationStore } from "./store.ts";

function hasSensitiveKey(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasSensitiveKey);
	if (value === null || typeof value !== "object") return false;
	return Object.entries(value).some(
		([key, child]) =>
			/(?:password|secret|credential|token|api[_-]?key|authorization)/i.test(key) || hasSensitiveKey(child),
	);
}

/** A transport adapter only: acceptance, credentials, version pinning and dispatch stay in the existing store. */
const requestSchema = z
	.object({
		prompt: z
			.string()
			.min(1)
			.max(48000)
			.refine((text) => text.trim().length > 0)
			.optional(),
		input: z.record(z.unknown()).optional(),
		external_ref: z
			.object({ type: z.string().min(1).max(100).optional(), id: z.string().min(1).max(200) })
			.strict()
			.optional(),
		metadata: z.record(z.unknown()).optional(),
		credentials: eventSchema.shape.credentials.default({}),
	})
	.strict()
	.refine(
		(request) => (request.input !== undefined) !== (request.prompt !== undefined),
		"Provide input or legacy prompt, never both",
	);

export async function createRun(
	store: OrchestrationStore,
	integration: IntegrationRecord,
	key: unknown,
	body: unknown,
) {
	const eventId = z.string().min(1).max(200).parse(key);
	const request = requestSchema.parse(body);
	const contract = request.prompt === undefined ? "input_v1" : "legacy_prompt";
	const input = request.prompt ?? canonicalJson(request.input);
	const metadata = request.metadata === undefined ? "" : canonicalJson(request.metadata);
	if (Buffer.byteLength(metadata, "utf8") > 8192)
		throw new OrchestrationError(400, "INVALID_METADATA", "metadata 超过 8 KiB");
	if (hasSensitiveKey(request.metadata))
		throw new OrchestrationError(400, "INVALID_METADATA", "metadata 不允许包含敏感凭据字段");
	if (
		Object.values(request.credentials).some(
			(secret) => metadata.includes(secret) || metadata.includes(JSON.stringify(secret).slice(1, -1)),
		)
	)
		throw new OrchestrationError(400, "CREDENTIAL_IN_METADATA", "凭据不得放在 metadata 中");
	if (
		Object.values(request.credentials).some(
			(secret) => input.includes(secret) || input.includes(JSON.stringify(secret).slice(1, -1)),
		)
	)
		throw new OrchestrationError(400, "CREDENTIAL_IN_INPUT", "凭据必须放在独立 credentials 字段中");
	const accepted = await store.accept(
		integration,
		{
			eventId,
			alarmId: request.external_ref?.id ?? eventId,
			input,
			credentials: request.credentials,
			credentialExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
		},
		{
			origin: "aaas",
			externalRef: request.external_ref,
			metadata: request.metadata,
			taskPrompt: request.prompt,
			requestContract: contract,
			requestHash: credentialHash(canonicalJson({ origin: "aaas", contract, request })),
			...(contract === "legacy_prompt"
				? { legacyRequestHash: credentialHash(canonicalJson({ origin: "aaas", request })) }
				: {}),
		},
	);
	if (contract === "legacy_prompt")
		console.info("AaaS deprecated contract", { integrationId: integration.id, contract });
	const run = await store.run(accepted.workItemId, integration.id);
	return { run_id: run.run_id, status: run.status, duplicate: accepted.duplicate };
}
