import { z } from "zod";
import { canonicalJson } from "../publishing/runtime-spec/hash.ts";
import { eventSchema, OrchestrationError } from "./contracts.ts";
import { credentialHash } from "./credentials.ts";
import type { IntegrationRecord, OrchestrationStore } from "./store.ts";

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
