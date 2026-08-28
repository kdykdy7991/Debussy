import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { errorEnvelope, readJsonBody, readRequestId } from "../../embed/http-shared.ts";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { HttpRequestHandler, PiSessionBackend, PiSessionRuntime } from "../../types.ts";
import { jsonBody } from "../../web/http-shared.ts";
import {
	type AgentDefinitionId,
	fromPublicId,
	newAuditEventId,
	newRequestId,
	parseId,
	type TenantId,
	toPublicId,
} from "../domain/ids.ts";
import type { PublishingRepositories } from "../repositories.ts";
import type { SkillMaterializer } from "../runtime/skill-materializer.ts";
import type { AgentDraftConfig } from "../runtime-spec/compiler.ts";
import type { RuntimeSpec } from "../runtime-spec/schema.ts";

const CREATE_PATH = "/api/control/v1/debug-sessions";
const SESSION_PATTERN = /^\/api\/control\/v1\/debug-sessions\/([^/]+)$/;
const EXPORT_PATTERN = /^\/api\/control\/v1\/debug-sessions\/([^/]+)\/export$/;
const MAX_BODY_BYTES = 16 * 1024;

interface DebugSessionEntry {
	readonly runtime: PiSessionRuntime;
	readonly agentDefinitionId: AgentDefinitionId;
	readonly revision: number;
	readonly expiresAt: number;
}

export function createAdminDebugSessionsHttpHandler(options: {
	readonly backend: PiSessionBackend;
	readonly repositories: PublishingRepositories;
	readonly skillMaterializer: SkillMaterializer;
	readonly tenantId: TenantId;
	readonly isAuthorized: (request: IncomingMessage) => boolean;
	readonly ttlMs?: number;
}): { readonly handler: HttpRequestHandler; close(): Promise<void> } {
	const ttlMs = options.ttlMs ?? 20 * 60 * 1000;
	const sessions = new Map<string, DebugSessionEntry>();
	const sweep = setInterval(() => void sweepExpired(), Math.min(ttlMs, 60_000));
	sweep.unref();

	const handler: HttpRequestHandler = async (request, response) => {
		const pathname = requestPathname(request.url);
		if (pathname === undefined || (!pathname.startsWith(`${CREATE_PATH}/`) && pathname !== CREATE_PATH)) return false;
		const requestId = readRequestId(request);
		if (!options.isAuthorized(request)) {
			jsonBody(response, 401, errorEnvelope("UNAUTHORIZED", "Unauthorized", requestId, false));
			return true;
		}
		try {
			if (request.method === "POST" && pathname === CREATE_PATH) {
				const body = await readJsonBody(request, MAX_BODY_BYTES);
				if (body.kind !== "ok" || !isRecord(body.value)) return invalid(response, requestId);
				const agentId = typeof body.value.agentId === "string" ? body.value.agentId : "";
				const revision = body.value.revision;
				const agentDefinitionId = fromPublicId("AgentDefinitionId", agentId);
				if (agentDefinitionId === null || !Number.isInteger(revision) || Number(revision) < 1)
					return invalid(response, requestId);
				const record = await options.repositories.agentDefinitions.getRevision(
					{ tenantId: options.tenantId },
					agentDefinitionId,
					Number(revision),
				);
				if (record === undefined) {
					jsonBody(
						response,
						404,
						errorEnvelope("AGENT_REVISION_NOT_FOUND", "Agent revision unavailable", requestId, false),
					);
					return true;
				}
				const draft = record.draftConfig as Partial<AgentDraftConfig>;
				if (!draft.model?.provider || !draft.model.modelId) {
					jsonBody(
						response,
						422,
						errorEnvelope("AGENT_MODEL_INVALID", "Agent revision has no usable model", requestId, false),
					);
					return true;
				}
				const bindings = await options.repositories.skills.listBindings(
					{ tenantId: options.tenantId },
					agentDefinitionId,
					Number(revision),
				);
				const frozenSkills: Array<RuntimeSpec["capabilities"]["skills"][number]> = [];
				for (const binding of bindings) {
					const skill = await options.repositories.skills.getRevision(
						{ tenantId: options.tenantId },
						binding.skillId,
						binding.skillRevision,
					);
					if (skill === undefined) throw new Error("bound Skill revision is unavailable");
					frozenSkills.push({
						skillId: toPublicId("SkillId", skill.skillId),
						revision: skill.revision,
						sourceHash: skill.sourceHash,
						name: skill.parsedName,
						description: skill.description,
						instructionText: skill.instructionText,
						disableModelInvocation: skill.disableModelInvocation,
					});
				}
				const sessionId = randomUUID();
				const skills = await options.skillMaterializer.materializeSkills(
					`debug-${agentDefinitionId}-${revision}`,
					frozenSkills,
					{ tenantId: options.tenantId },
				);
				const runtime = await options.backend.createSession({
					id: sessionId,
					ephemeral: true,
					model: { provider: draft.model.provider, id: draft.model.modelId },
					resourceOverrides: { systemPrompt: draft.prompt ?? "", skills },
				});
				const expiresAt = Date.now() + ttlMs;
				sessions.set(sessionId, { runtime, agentDefinitionId, revision: Number(revision), expiresAt });
				await audit("debug-session.created", sessionId, requestId, {
					agentId,
					revision,
					skillCount: skills.length,
				});
				jsonBody(response, 201, {
					data: { sessionId, attachTicket: sessionId, expiresAt: new Date(expiresAt).toISOString() },
					requestId,
				});
				return true;
			}
			const exportMatch = pathname.match(EXPORT_PATTERN);
			if (request.method === "GET" && exportMatch !== null) {
				const entry = sessions.get(exportMatch[1]!);
				if (entry === undefined) return unavailable(response, requestId);
				const snapshot = entry.runtime.snapshot();
				await audit("debug-session.exported", exportMatch[1]!, requestId, {
					agentRevision: entry.revision,
					itemCount: snapshot.transcript.length,
				});
				jsonBody(response, 200, {
					data: {
						agentId: toPublicId("AgentDefinitionId", entry.agentDefinitionId),
						agentRevision: entry.revision,
						transcript: snapshot.transcript,
					},
					requestId,
				});
				return true;
			}
			const sessionMatch = pathname.match(SESSION_PATTERN);
			if (request.method === "DELETE" && sessionMatch !== null) {
				const entry = sessions.get(sessionMatch[1]!);
				if (entry !== undefined) {
					sessions.delete(sessionMatch[1]!);
					await entry.runtime.dispose();
					await audit("debug-session.destroyed", sessionMatch[1]!, requestId, { reason: "explicit" });
				}
				jsonBody(response, 200, { data: { destroyed: entry !== undefined }, requestId });
				return true;
			}
			jsonBody(response, 405, errorEnvelope("METHOD_NOT_ALLOWED", "Method not allowed", requestId, false));
			return true;
		} catch {
			jsonBody(
				response,
				500,
				errorEnvelope("DEBUG_SESSION_FAILED", "Debug session operation failed", requestId, true),
			);
			return true;
		}
	};

	async function audit(action: string, resourceId: string, requestId: string, metadata: unknown): Promise<void> {
		await options.repositories.audit.insert({
			auditEventId: newAuditEventId(),
			tenantId: options.tenantId,
			actorType: "platform_admin",
			actorId: options.tenantId,
			action,
			resourceType: "debug_session",
			resourceId,
			requestId: parseId("RequestId", requestId) ?? newRequestId(),
			metadata,
			createdAt: new Date(),
		});
	}

	async function sweepExpired(): Promise<void> {
		const now = Date.now();
		for (const [sessionId, entry] of sessions) {
			if (entry.expiresAt > now) continue;
			sessions.delete(sessionId);
			await entry.runtime.dispose().catch(() => {});
			await audit("debug-session.destroyed", sessionId, newRequestId(), { reason: "ttl" }).catch(() => {});
		}
	}

	return {
		handler,
		async close() {
			clearInterval(sweep);
			await Promise.allSettled([...sessions.values()].map((entry) => entry.runtime.dispose()));
			sessions.clear();
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(response: Parameters<HttpRequestHandler>[1], requestId: string): true {
	jsonBody(
		response,
		400,
		errorEnvelope("INVALID_REQUEST", "agentId and positive revision are required", requestId, false),
	);
	return true;
}

function unavailable(response: Parameters<HttpRequestHandler>[1], requestId: string): true {
	jsonBody(response, 404, errorEnvelope("DEBUG_SESSION_NOT_FOUND", "Debug session unavailable", requestId, false));
	return true;
}
