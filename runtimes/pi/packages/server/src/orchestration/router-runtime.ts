/**
 * Router V1 phase four: Task/Operation store, acceptance, serial dispatcher,
 * cancellation, cleanup and the six public HTTP routes.
 *
 * The Router never creates Conversation/Work Item/Assignment. Execution uses
 * the phase-two shared Pi/MCP entry through `createRouterOperationExecutor`.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TransactionSql } from "postgres";
import type { TranscriptProgress } from "@earendil-works/pi-protocol";
import { errorEnvelope, jsonBody, readJsonBody, readRequestId } from "../embed/http-shared.ts";
import type { TenantId } from "../publishing/domain/ids.ts";
import { newRequestId, toPublicId } from "../publishing/domain/ids.ts";
import type { RestoredContext, RestoredTranscriptMessage } from "../runtime/context-restore.ts";
import { createLlmUsageCollector, type PiExecutionOutcome } from "../runtime/pi-execution.ts";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { HttpRequestHandler, LlmCallTrace } from "../types.ts";
import type { ApiKeyStore } from "./api-key.ts";
import type { IdempotencyKeyring, IdempotencyRecord } from "./api-key-idempotency.ts";
import type { ApiKeyPrincipal } from "./api-key-contracts.ts";
import type { PostgresClient } from "../persistence/postgres/client.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import {
	buildRouterCapabilitySnapshot,
	internalServerId,
	internalSkillId,
	resolveEffectiveCapabilities,
	verifyRouterCapabilitySnapshot,
} from "./router-capability.ts";
import type { RouterCapabilitySnapshot } from "./router-capability-contracts.ts";
import {
	ROUTER_CAPABILITY_HEADER,
	ROUTER_PATHS,
	ROUTER_PREDECESSOR_CANCEL_REASON,
	appendInputRequestSchema,
	cancelTaskRequestSchema,
	createTaskRequestSchema,
	eventsQuerySchema,
	taskQuerySchema,
	createTaskResponseSchema,
	appendInputResponseSchema,
	cancelTaskResponseSchema,
	operationViewSchema,
	routerProgressSchema,
	taskEventsResponseSchema,
	taskViewSchema,
} from "./router-contracts.ts";
import { OrchestrationError } from "./contracts.ts";
import { WorkCredentialBox } from "./credentials.ts";
import { createRouterOperationExecutor } from "./router-operation-execution.ts";
import { SANDBOX_PROVIDER, type SandboxConfig } from "../runtime/sandbox.ts";
import { routerCredentialScope, type RouterOperationSealedCredentials } from "./router-operation-credentials.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { PiRuntimeAdapter } from "../runtime/pi-runtime-adapter.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { z, ZodError } from "zod";
import { routerWorkerHasExited, routerWorkerIdentity } from "./router-worker-identity.ts";
import { containsKnownSecret } from "./api-key-runs.ts";

const TASKS = `${ROUTER_PATHS[0]}`;
const INPUTS_SUFFIX = "/inputs";
const EVENTS_SUFFIX = "/events";
const CANCEL_SUFFIX = "/cancel";
const OPERATIONS = "/api/aaas/v1/operations";
const EXECUTION_BUDGET_MS = 120_000;
const LEASE_MS = 30_000;
const CREDENTIAL_MARGIN_MS = 60_000;

type InputRequest =
	| ReturnType<typeof createTaskRequestSchema.parse>
	| ReturnType<typeof appendInputRequestSchema.parse>;
type Usage = Partial<Record<"input_tokens" | "output_tokens" | "total_tokens", number>>;
type HistoryWrite = {
	readonly type: "assistant.message" | "tool.call" | "tool.result";
	readonly payload: Record<string, unknown>;
};
type EventWrite = {
	readonly operationId?: string;
	readonly type: string;
	readonly payload: Record<string, unknown>;
	readonly internal?: boolean;
};

export interface RouterRuntimeOptions {
	readonly client: PostgresClient;
	readonly tenantId: string;
	readonly keys: ApiKeyStore;
	readonly idempotency: IdempotencyKeyring;
	readonly adapter: PiRuntimeAdapter;
	readonly sandboxConfig?: SandboxConfig;
	readonly repos: PublishingRepositories;
	readonly masterKey: Uint8Array;
	/** Test seam: worker identity defaults to one per process/session. */
	readonly workerInstanceId?: string;
	readonly now?: () => number;
	readonly onError?: (error: unknown) => void;
}

interface Accepted {
	readonly taskId: string;
	readonly operationId: string;
	readonly ordinal: number;
	readonly duplicate: boolean;
}

interface PendingOperation {
	readonly id: string;
	readonly taskId: string;
	readonly keyId: string;
	readonly sequence: number;
	readonly inputEventSequence: string;
	readonly inputText: string;
	readonly snapshot: RouterCapabilitySnapshot;
	readonly credentialDeadline: Date | null;
	readonly executionDeadline: Date;
	readonly fenceToken: string;
}

function failure(status: number, code: string, message: string): OrchestrationError {
	return new OrchestrationError(status, code, message);
}

function pageCursor(cursor: string | undefined): string {
	if (cursor === undefined) return "0";
	if (!/^\d{1,19}$/.test(cursor) || BigInt(cursor) > 9_223_372_036_854_775_807n)
		throw failure(400, "INVALID_REQUEST", "分页游标无效");
	return cursor;
}

function operationUsage(outcome: Pick<PiExecutionOutcome, "llmUsage" | "usage">): { usage: Usage; complete: boolean } {
	const reported = outcome.llmUsage?.calls.some((call) => call.usageReported);
	const totals = outcome.llmUsage ? (reported ? outcome.llmUsage.total : undefined) : outcome.usage;
	return {
		usage: totals
			? { total_tokens: totals.totalTokens, input_tokens: totals.input, output_tokens: totals.output }
			: {},
		complete: outcome.llmUsage ? reported === true && !outcome.llmUsage.partial : outcome.usage !== undefined,
	};
}

function toHexBase64(value: Buffer): string {
	return value.toString("base64");
}

function sealedFromRow(row: Record<string, unknown>): { ciphertext: string; nonce: string; tag: string } {
	return {
		ciphertext: toHexBase64(row.ciphertext as Buffer),
		nonce: toHexBase64(row.nonce as Buffer),
		tag: toHexBase64(row.auth_tag as Buffer),
	};
}

/** Conservative window: all queued Operations plus this one must fit before expiry. */
export function credentialWindowOk(options: {
	readonly expiresAt: number;
	readonly now: number;
	readonly waitMs: number;
}): boolean {
	const required = options.waitMs + EXECUTION_BUDGET_MS + CREDENTIAL_MARGIN_MS;
	return Number.isFinite(options.expiresAt) && options.expiresAt - options.now >= required;
}

/** Resolve immutable Revision content referenced by the frozen snapshot. */
async function specFromSnapshot(
	snapshot: RouterCapabilitySnapshot,
	repos: PublishingRepositories,
	tenantId: TenantId,
): Promise<RuntimeSpec> {
	const scope = { tenantId };
	const mcpServers = await Promise.all(
		snapshot.servers.map(async (server) => {
			const revision = await repos.mcpServers.getRevision(
				scope,
				internalServerId(server.serverId) as never,
				server.revision,
			);
			if (!revision || revision.authentication !== server.authentication)
				throw failure(409, "INVALID_CAPABILITY_SNAPSHOT", "冻结 MCP Revision 不可用");
			return {
				mcpServerId: server.serverId,
				revision: server.revision,
				transport: revision.transport,
				endpoint: revision.endpoint,
				authentication: server.authentication,
				tools: server.tools.map(({ name, description, inputSchema, inputSchemaHash }) => ({
					name,
					description,
					inputSchema,
					inputSchemaHash,
				})),
			};
		}),
	);
	const skills = await Promise.all(
		snapshot.skills.map(async (skill) => {
			const revision = await repos.skills.getRevision(scope, internalSkillId(skill.skill_id), skill.revision);
			if (!revision || revision.sourceHash !== skill.artifact_hash)
				throw failure(409, "INVALID_CAPABILITY_SNAPSHOT", "冻结 Skill Revision 不可用");
			return {
				skillId: toPublicId("SkillId", revision.skillId),
				revision: skill.revision,
				sourceHash: revision.sourceHash,
				name: revision.parsedName,
				description: revision.description,
				instructionText: revision.instructionText,
				disableModelInvocation: revision.disableModelInvocation,
			};
		}),
	);
	const parsed = parseRuntimeSpec({
		schemaVersion: 1,
		publishedAppVersionId: `orv_${snapshot.orchestrationVersionId ?? snapshot.keyId}`,
		agent: {
			systemPrompt: "",
			model: {
				provider: snapshot.model.provider,
				modelId: snapshot.model.modelId,
				params: snapshot.model.parameters,
			},
		},
		contextPolicy: {
			maxTurns: 100,
			maxContextTokens: 256_000,
			toolResultMaxBytes: 65_536,
			logLevel: "standard",
		},
		runtimePolicy: {
			profile: "chat-only",
			turnTimeoutMs: EXECUTION_BUDGET_MS,
			idleTtlMs: 1_200_000,
			maxConcurrentTurnsPerConversation: 1,
		},
		capabilities: {
			tools: [],
			knowledgeBases: [],
			skills,
			mcpServers,
		},
	});
	if (!parsed.ok) throw failure(409, "INVALID_CAPABILITY_SNAPSHOT", "冻结能力无法编译为执行配置");
	return parsed.spec;
}

export class RouterRuntime {
	private readonly client: PostgresClient;
	private readonly tenantId: string;
	private readonly keys: ApiKeyStore;
	private readonly idempotency: IdempotencyKeyring;
	private readonly executor: ReturnType<typeof createRouterOperationExecutor>;
	private readonly box: WorkCredentialBox;
	private readonly repos: PublishingRepositories;
	private readonly workerInstanceId: string;
	private readonly now: () => number;
	private readonly active = new Map<
		string,
		{ op: PendingOperation; controller: AbortController; settled: Promise<void> }
	>();
	private stopped = false;
	private timer: NodeJS.Timeout | undefined;
	private polling: Promise<void> | undefined;
	private readonly onError: (error: unknown) => void;

	constructor(options: RouterRuntimeOptions) {
		this.client = options.client;
		this.tenantId = options.tenantId;
		this.keys = options.keys;
		this.idempotency = options.idempotency;
		this.repos = options.repos;
		this.box = new WorkCredentialBox(options.masterKey);
		this.workerInstanceId = options.workerInstanceId ?? routerWorkerIdentity();
		this.now = options.now ?? Date.now;
		this.onError = options.onError ?? (() => undefined);
		this.executor = createRouterOperationExecutor({
			adapter: options.adapter,
			sandboxConfig: options.sandboxConfig,
			credentialBox: this.box,
			recordAudit: async (record) => {
				const current = this.active.get(record.routerOperationId ?? "");
				if (!current) return;
				await this.withActive(current.op, async (tx, _task, row) => {
					if (row.state !== "running") return;
					await txRows(
						tx,
						`insert into mcp_call_audits(id,tenant_id,router_operation_id,mcp_server_id,mcp_revision,
						tool_name,outcome,latency_ms,result_bytes,result_truncated,error_code,request_id,created_at)
						values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
						randomUUID(),
						this.tenantId,
						current.op.id,
						record.mcpServerId,
						record.mcpRevision,
						record.toolName,
						record.outcome,
						record.latencyMs,
						record.resultBytes,
						record.resultTruncated,
						record.errorCode,
						record.requestId,
						record.createdAt,
					);
				});
			},
		});
	}

	async start(): Promise<void> {
		if (this.timer || this.stopped) return;
		this.timer = setInterval(() => {
			void this.tick().catch(this.onError);
		}, 250);
		this.timer.unref?.();
	}

	async close(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		for (const current of this.active.values()) current.controller.abort();
		await this.polling;
		await Promise.allSettled([...this.active.values()].map((current) => current.settled));
	}

	/** One dispatcher turn: claim at most one Operation per available Task. */
	async tick(): Promise<void> {
		if (this.stopped) return;
		if (!this.polling)
			this.polling = this.poll().finally(() => {
				this.polling = undefined;
			});
		return this.polling;
	}

	private async resolveScope(
		tx: TransactionSql,
		principal: ApiKeyPrincipal,
		header: string | undefined,
	): Promise<void> {
		const [key] = await txRows(
			tx,
			"select router_capability_scope from aaas_api_keys where tenant_id=$1 and id=$2",
			this.tenantId,
			principal.keyId,
		);
		if (key?.router_capability_scope !== "dual" && key?.router_capability_scope !== "router")
			throw failure(403, "CAPABILITY_UNAVAILABLE", "Router 直接能力未登记");
		if (
			(key.router_capability_scope === "dual" && header !== "router") ||
			(header !== undefined && header !== "router")
		)
			throw failure(403, "CAPABILITY_SCOPE_REQUIRED", "双入口 Key 必须显式选择 Router 能力范围");
	}

	private normalized(input: InputRequest): Record<string, unknown> {
		return {
			...("prompt" in input ? { prompt: input.prompt } : { input: input.input }),
			mcp_servers: input.mcp_servers ?? null,
			// Preserve digests for existing requests that omitted the retired fields.
			capability_selection: null,
			credentials: input.credentials,
			credentials_expires_at: null,
		};
	}

	/** R030: idempotent acceptance with capability freeze, History and sealed credentials. */
	async accept(
		principal: ApiKeyPrincipal,
		idempotencyKey: string,
		header: string | undefined,
		body: unknown,
		isCreate: boolean,
		taskIdHint?: string,
	): Promise<Accepted> {
		const parsed = isCreate ? createTaskRequestSchema.safeParse(body) : appendInputRequestSchema.safeParse(body);
		if (!parsed.success) throw failure(400, "INVALID_REQUEST", "请求不符合 Router 契约");
		const input = parsed.data;
		const text = "prompt" in input ? input.prompt : input.input;
		const normalized = this.normalized(input);
		const digest = this.idempotency.digest(normalized);
		const idemKey = idempotencyKey?.trim();
		if (!idemKey || idemKey.length > 200) throw failure(400, "INVALID_REQUEST", "Idempotency-Key 无效");
		const secrets = Object.values(input.credentials.servers).flatMap((entry) => Object.values(entry));
		if (containsKnownSecret(text, secrets) || containsKnownSecret(idemKey, secrets))
			throw failure(400, "INVALID_CREDENTIAL", "输入或幂等键包含请求凭据");
		const requestScope = isCreate ? "task.create" : "operation.input";
		const scopeId = isCreate ? principal.keyId : taskIdHint;
		if (!scopeId) throw failure(404, "TASK_NOT_ACCESSIBLE", "Task 不存在或不可访问");

		return this.client.transaction(async (tx) => {
			await this.keys.lockAndVerify(tx, principal, principal.secretHash);
			await this.resolveScope(tx, principal, header);
			const previous = await this.findIdempotency(tx, principal, requestScope, scopeId, idemKey);
			if (previous) {
				if (!this.idempotency.matches(normalized, previous))
					throw failure(409, "IDEMPOTENCY_CONFLICT", "幂等键已用于其他请求");
				const [row] = await txRows(
					tx,
					"select task_id,operation_id from router_idempotency where tenant_id=$1 and key_id=$2 and request_scope=$3 and scope_id=$4 and idempotency_key=$5",
					this.tenantId,
					principal.keyId,
					requestScope,
					scopeId,
					idemKey,
				);
				return {
					taskId: String(row.task_id),
					operationId: String(row.operation_id),
					ordinal: Number((await this.operationOrdinal(tx, String(row.operation_id))).operation_sequence),
					duplicate: true,
				};
			}
			const { snapshot, digest: snapshotHash } = await this.resolveCapabilities(
				principal,
				input.mcp_servers,
				tx,
			);
			verifyRouterCapabilitySnapshot(snapshot, snapshotHash);
			const now = this.now();
			const policy = snapshot.executionPolicy;
			let taskId: string;
			let waitMs = 0;
			if (isCreate) {
				taskId = randomUUID();
				await txRows(
					tx,
					`insert into router_tasks(id,tenant_id,key_id,max_pending_operations) values ($1,$2,$3,$4)`,
					taskId,
					this.tenantId,
					principal.keyId,
					policy.max_pending_operations,
				);
			} else {
				const task = await this.lockedTask(tx, principal, scopeId);
				taskId = String(task.id);
				if (task.canceled_at !== null) throw failure(409, "TASK_CANCELED", "Task 已永久取消");
				const ahead = await txRows(
					tx,
					"select state,execution_deadline from router_operations where tenant_id=$1 and task_id=$2 and (state='queued' or holds_task_occupancy)",
					this.tenantId,
					taskId,
				);
				const waiting = ahead.filter((op) => op.state === "queued").length;
				if (waiting >= policy.max_pending_operations) throw failure(429, "QUEUE_FULL", "等待队列已满");
				waitMs =
					waiting * EXECUTION_BUDGET_MS +
					ahead
						.filter((op) => op.state !== "queued")
						.reduce((ms, op) => {
							const deadline =
								op.execution_deadline instanceof Date
									? op.execution_deadline.getTime()
									: now + EXECUTION_BUDGET_MS;
							return ms + (deadline > now ? deadline - now : EXECUTION_BUDGET_MS);
						}, 0);
			}
			const hasCredentials =
				secrets.length > 0 ||
				snapshot.servers.some((server) => server.sensitiveBindings.length > 0);
			const cap = now + policy.credential_max_ms;
			const expiresAt = cap;
			if (hasCredentials && !credentialWindowOk({ expiresAt, now, waitMs }))
				throw failure(422, "CREDENTIAL_WINDOW_EXPIRED", "凭据有效期不足以覆盖排队预算");
			const expireDate = hasCredentials ? new Date(expiresAt) : null;
			const operationId = randomUUID();
			const task = await this.lockedTask(tx, principal, taskId);
			const ordinal = Number(task.next_operation_sequence);
			let sequence = BigInt(String(task.event_sequence));
			if (isCreate) {
				await this.insertEvent(tx, taskId, ++sequence, undefined, "task.created", true, {});
			}
			await this.insertEvent(tx, taskId, ++sequence, undefined, "user.message", false, { text }, operationId);
			const inputSequence = sequence;
			await txRows(
				tx,
				`insert into router_operations(id,tenant_id,task_id,operation_sequence,input_event_sequence,state,
						capability_snapshot,capability_snapshot_hash,credential_deadline,queue_deadline)
					 values ($1,$2,$3,$4,$5,'queued',$6::jsonb,$7,$8,$9)`,
				operationId,
				this.tenantId,
				taskId,
				ordinal,
				String(inputSequence),
				snapshot as unknown as Record<string, unknown>,
				snapshotHash,
				expireDate,
				new Date(now + policy.queue_timeout_ms),
			);
			await txRows(
				tx,
				"update router_task_events set operation_id=$3 where tenant_id=$1 and task_id=$2 and sequence=$4",
				this.tenantId,
				taskId,
				operationId,
				String(inputSequence),
			);
			await this.sealCredentials(tx, taskId, operationId, snapshot, input.credentials.servers, expireDate);
			await this.insertEvent(tx, taskId, ++sequence, operationId, "operation.accepted", true, {});
			await this.insertEvent(tx, taskId, ++sequence, operationId, "operation.queued", true, {});
			await txRows(
				tx,
				"update router_tasks set next_operation_sequence=$3,event_sequence=$4,latest_operation_id=$5,updated_at=now() where tenant_id=$1 and id=$2",
				this.tenantId,
				taskId,
				ordinal + 1,
				String(sequence),
				operationId,
			);
			await txRows(
				tx,
				`insert into router_idempotency(tenant_id,key_id,idempotency_key,request_scope,scope_id,request_hash,canonicalization_version,digest_key_version,task_id,operation_id)
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				this.tenantId,
				principal.keyId,
				idemKey,
				requestScope,
				scopeId,
				digest.requestHash,
				digest.canonicalizationVersion,
				digest.digestKeyVersion,
				taskId,
				operationId,
			);
			await txRows(
				tx,
				`insert into audit_events(id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id,metadata)
					 values ($1,$2,'api_key',$3,'router.operation.accepted','router_operation',$4,$5,$6::jsonb)`,
				randomUUID(),
				this.tenantId,
				principal.keyId,
				operationId,
				newRequestId(),
				{ task_id: taskId, operation_sequence: ordinal, capability_revision: snapshot.capabilityRevision },
			);
			return { taskId, operationId, ordinal, duplicate: false };
		});
	}

	private async findIdempotency(
		client: PostgresClient | TransactionSql,
		principal: ApiKeyPrincipal,
		requestScope: string,
		scopeId: string,
		idemKey: string,
	): Promise<IdempotencyRecord | undefined> {
		const query = `select request_hash,canonicalization_version,digest_key_version from router_idempotency where tenant_id=$1 and key_id=$2 and request_scope=$3 and scope_id=$4 and idempotency_key=$5`;
		const rows =
			typeof client === "function"
				? await txRows(
						client as TransactionSql,
						query,
						this.tenantId,
						principal.keyId,
						requestScope,
						scopeId,
						idemKey,
					)
				: await (client as PostgresClient).run(
						query,
						this.tenantId,
						principal.keyId,
						requestScope,
						scopeId,
						idemKey,
					);
		const row = rows[0];
		if (!row) return undefined;
		return {
			requestHash: String(row.request_hash),
			canonicalizationVersion: Number(row.canonicalization_version),
			digestKeyVersion: Number(row.digest_key_version),
			workItemId: "",
		};
	}

	private async operationOrdinal(
		client: PostgresClient | TransactionSql,
		operationId: string,
	): Promise<Record<string, unknown>> {
		const query = "select operation_sequence from router_operations where tenant_id=$1 and id=$2";
		const rows =
			typeof client === "function"
				? await txRows(client as TransactionSql, query, this.tenantId, operationId)
				: await (client as PostgresClient).run(query, this.tenantId, operationId);
		return rows[0];
	}

	private async lockedTask(
		tx: TransactionSql,
		principal: ApiKeyPrincipal,
		taskId: string,
	): Promise<Record<string, unknown>> {
		const [row] = await txRows(
			tx,
			"select * from router_tasks where tenant_id=$1 and key_id=$2 and id=$3 for update",
			this.tenantId,
			principal.keyId,
			taskId,
		);
		if (!row) throw failure(404, "TASK_NOT_ACCESSIBLE", "Task 不存在或不可访问");
		return row;
	}

	private async resolveCapabilities(
		principal: ApiKeyPrincipal,
		selected: readonly string[] | undefined,
		tx: TransactionSql,
	) {
		const effective = await resolveEffectiveCapabilities({
			client: this.client,
			repos: this.repos,
			tenantId: this.tenantId,
			principal,
			scope: "router",
			selected,
			tx,
		});
		return buildRouterCapabilitySnapshot({ keyId: principal.keyId, effective });
	}

	private async insertEvent(
		tx: TransactionSql,
		taskId: string,
		sequence: string | bigint,
		operationId: string | undefined,
		eventType: string,
		publicVisible: boolean,
		payload: Record<string, unknown>,
		inputFor?: string,
	): Promise<void> {
		await txRows(
			tx,
			`insert into router_task_events(id,tenant_id,task_id,sequence,operation_id,user_input_for_operation_id,event_type,public_visible,payload)
			 values ($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::uuid,$7::text,$8::boolean,$9::jsonb)`,
			randomUUID(),
			this.tenantId,
			taskId,
			String(sequence),
			operationId ?? null,
			inputFor ?? null,
			eventType,
			publicVisible,
			payload,
		);
	}

	private async sealCredentials(
		tx: TransactionSql,
		taskId: string,
		operationId: string,
		snapshot: RouterCapabilitySnapshot,
		supplied: InputRequest["credentials"]["servers"],
		expiresAt: Date | null,
	): Promise<void> {
		for (const server of snapshot.servers) {
			const entry = supplied[server.serverId] ?? {};
			const wantsTool = server.tools.some((tool) => tool.sensitiveBindings.length > 0);
			if (wantsTool && !entry.tool_credential) throw failure(400, "MISSING_CREDENTIAL", "缺少工具凭据");
			if (!wantsTool && entry.tool_credential) throw failure(400, "INVALID_CREDENTIAL", "该 Server 不接受工具凭据");
			const seal = async (
				dimension: "connection" | "tool",
				toolName: string | null,
				credentialId: string,
				value: string,
			) => {
				const kind =
					dimension === "connection"
						? { kind: "connection" as const, serverId: server.serverId }
						: { kind: "tool" as const, serverId: server.serverId, toolName: toolName!, credentialId };
				const sealed = this.box.sealValue(
					routerCredentialScope(this.tenantId as TenantId, operationId, kind),
					value,
				);
				await txRows(
					tx,
					`insert into router_operation_credentials(id,tenant_id,task_id,operation_id,dimension,server_id,tool_name,credential_id,ciphertext,nonce,auth_tag,key_version,expires_at)
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12)`,
					randomUUID(),
					this.tenantId,
					taskId,
					operationId,
					dimension,
					server.serverId,
					toolName,
					credentialId,
					Buffer.from(sealed.ciphertext, "base64"),
					Buffer.from(sealed.nonce, "base64"),
					Buffer.from(sealed.tag, "base64"),
					expiresAt,
				);
			};
			if (entry.tool_credential && wantsTool) {
				for (const tool of server.tools)
					for (const credentialId of new Set(tool.sensitiveBindings.map((binding) => binding.credentialId)))
						await seal("tool", tool.name, credentialId, entry.tool_credential);
			}
		}
		for (const id of Object.keys(supplied)) {
			if (!snapshot.servers.some((server) => server.serverId === id))
				throw failure(400, "INVALID_CREDENTIAL", "凭据包含未授权 Server");
		}
	}

	private async readCredentials(op: PendingOperation): Promise<RouterOperationSealedCredentials> {
		const rows = await this.client.run(
			"select * from router_operation_credentials where tenant_id=$1 and operation_id=$2",
			this.tenantId,
			op.id,
		);
		const connection: NonNullable<RouterOperationSealedCredentials["connection"]>[number][] = [];
		const tool: NonNullable<RouterOperationSealedCredentials["tool"]>[number][] = [];
		for (const row of rows) {
			const sealed = sealedFromRow(row);
			if (row.dimension === "connection") connection.push({ serverId: String(row.server_id), sealed });
			else
				tool.push({
					serverId: String(row.server_id),
					toolName: String(row.tool_name),
					credentialId: String(row.credential_id),
					sealed,
				});
		}
		const bindings = op.snapshot.servers.flatMap((server) =>
			server.tools.flatMap((entry) =>
				entry.sensitiveBindings.map(({ mcpServerId, toolName, parameter, credentialId }) => ({
					mcpServerId,
					toolName,
					parameter,
					credential: credentialId,
				})),
			),
		);
		return { connection, tool, bindings, ...(op.credentialDeadline && { expiresAt: op.credentialDeadline }) };
	}

	private async poll(): Promise<void> {
		for (const { op, controller } of this.active.values()) {
			const checked = await this.withActive(op, async (tx, task) => {
				if (task.canceled_at !== null) return false;
				await txRows(
					tx,
					"update router_operations set lease_expires_at=$3 where tenant_id=$1 and id=$2",
					this.tenantId,
					op.id,
					new Date(this.now() + LEASE_MS),
				);
				return true;
			});
			if (checked !== true || this.now() >= op.executionDeadline.getTime()) controller.abort();
		}
		const expired = await this.client.run(
			"select id from router_operations where tenant_id=$1 and holds_task_occupancy and lease_expires_at <= $2 order by lease_expires_at",
			this.tenantId,
			new Date(this.now()),
		);
		for (const row of expired) await this.cleanup(String(row.id));
		await this.client.run(
			"delete from router_operation_credentials where tenant_id=$1 and expires_at <= $2",
			this.tenantId,
			new Date(this.now()),
		);
		if (this.stopped) return;
		const op = await this.claim();
		if (!op) return;
		const controller = new AbortController();
		if (this.stopped) controller.abort();
		const settled = this.execute(op, controller)
			.catch(this.onError)
			.finally(() => this.active.delete(op.id));
		this.active.set(op.id, { op, controller, settled });
	}

	private async claim(): Promise<PendingOperation | undefined> {
		return this.client.transaction(async (tx) => {
			const [task] = await txRows(
				tx,
				`select t.* from router_tasks t
				 where t.tenant_id=$1 and t.canceled_at is null
				   and not exists (select 1 from router_operations o where o.tenant_id=t.tenant_id and o.task_id=t.id and o.holds_task_occupancy)
				   and exists (select 1 from router_operations o where o.tenant_id=t.tenant_id and o.task_id=t.id and o.state='queued')
				 order by t.created_at,t.id limit 1 for update skip locked`,
				this.tenantId,
			);
			if (!task) return;
			const taskId = String(task.id);
			const [row] = await txRows(
				tx,
				`select o.*,e.payload->>'text' as input_text from router_operations o
				 join router_task_events e on e.tenant_id=o.tenant_id and e.task_id=o.task_id and e.sequence=o.input_event_sequence
				 where o.tenant_id=$1 and o.task_id=$2 and o.state='queued'
				 order by o.operation_sequence limit 1`,
				this.tenantId,
				taskId,
			);
			if (!row) return;
			const id = String(row.id);
			const now = this.now();
			const credentialDeadline = row.credential_deadline as Date | null;
			if (
				(row.queue_deadline as Date).getTime() <= now ||
				(credentialDeadline && credentialDeadline.getTime() <= now)
			) {
				await this.endOperation(
					tx,
					task,
					id,
					"failed",
					credentialDeadline && credentialDeadline.getTime() <= now ? "CREDENTIAL_EXPIRED" : "QUEUE_TIMEOUT",
				);
				return;
			}
			let snapshot: RouterCapabilitySnapshot;
			try {
				snapshot = verifyRouterCapabilitySnapshot(row.capability_snapshot, String(row.capability_snapshot_hash));
				if (snapshot.keyId !== task.key_id || snapshot.source !== "router")
					throw new Error("invalid capability owner");
			} catch {
				await this.endOperation(tx, task, id, "failed", "INVALID_CAPABILITY_SNAPSHOT");
				return;
			}
			const fenceToken = String(BigInt(String(task.fence_token)) + 1n);
			const executionDeadline = new Date(
				Math.min(now + EXECUTION_BUDGET_MS, credentialDeadline?.getTime() ?? Infinity),
			);
			const lease = new Date(now + LEASE_MS);
			await txRows(
				tx,
				`update router_operations set holds_task_occupancy=true,claimed_at=now(),
					worker_instance_id=$3,lease_token=$4,lease_expires_at=$5,execution_deadline=$6,updated_at=now()
				 where tenant_id=$1 and id=$2`,
				this.tenantId,
				id,
				this.workerInstanceId,
				fenceToken,
				lease,
				executionDeadline,
			);
			await txRows(
				tx,
				"update router_tasks set fence_token=$3,updated_at=now() where tenant_id=$1 and id=$2",
				this.tenantId,
				taskId,
				fenceToken,
			);
			return {
				id,
				taskId,
				keyId: String(task.key_id),
				sequence: Number(row.operation_sequence),
				inputEventSequence: String(row.input_event_sequence),
				inputText: String(row.input_text),
				snapshot,
				credentialDeadline,
				executionDeadline,
				fenceToken,
			};
		});
	}

	/** Every Operation writer acquires the same Task row first, including callbacks. */
	private async withActive<T>(
		op: PendingOperation,
		work: (tx: TransactionSql, task: Record<string, unknown>, row: Record<string, unknown>) => Promise<T>,
	): Promise<T | undefined> {
		return this.client.transaction(async (tx) => {
			const [task] = await txRows(
				tx,
				"select * from router_tasks where tenant_id=$1 and id=$2 for update",
				this.tenantId,
				op.taskId,
			);
			if (!task || String(task.fence_token) !== op.fenceToken) return;
			const [row] = await txRows(
				tx,
				"select * from router_operations where tenant_id=$1 and task_id=$2 and id=$3",
				this.tenantId,
				op.taskId,
				op.id,
			);
			if (
				!row ||
				row.holds_task_occupancy !== true ||
				row.worker_instance_id !== this.workerInstanceId ||
				String(row.lease_token) !== op.fenceToken
			)
				return;
			return work(tx, task, row);
		});
	}

	private async addEvents(
		tx: TransactionSql,
		task: Record<string, unknown>,
		entries: readonly EventWrite[],
	): Promise<string> {
		let sequence = BigInt(String(task.event_sequence));
		for (const event of entries) {
			sequence += 1n;
			await this.insertEvent(
				tx,
				String(task.id),
				String(sequence),
				event.operationId,
				event.type,
				!event.internal,
				event.payload,
			);
		}
		task.event_sequence = String(sequence);
		await txRows(
			tx,
			"update router_tasks set event_sequence=$3,updated_at=now() where tenant_id=$1 and id=$2",
			this.tenantId,
			String(task.id),
			String(sequence),
		);
		return String(sequence);
	}

	private async contextFor(op: PendingOperation): Promise<RestoredContext> {
		const rows = await this.client.run(
			`select e.event_type,e.payload,o.state
			 from router_task_events e join router_operations o on o.tenant_id=e.tenant_id and o.task_id=e.task_id and o.id=e.operation_id
			 where e.tenant_id=$1 and e.task_id=$2 and o.operation_sequence < $3
			   and (e.event_type in ('user.message','operation.failed','operation.canceled')
			     or (e.event_type in ('assistant.message','tool.call','tool.result')
			       and o.state='completed' and e.sequence <= o.context_committed_sequence))
			 order by o.operation_sequence,e.sequence`,
			this.tenantId,
			op.taskId,
			op.sequence,
		);
		const transcript: RestoredTranscriptMessage[] = [];
		let toolCalls: RestoredTranscriptMessage["content"][number][] = [];
		let toolResults: RestoredTranscriptMessage[] = [];
		const flushTools = () => {
			if (!toolCalls.length) return;
			transcript.push({ role: "assistant", content: toolCalls }, ...toolResults);
			toolCalls = [];
			toolResults = [];
		};
		for (const row of rows) {
			const payload = row.payload as Record<string, unknown>;
			if (row.event_type !== "tool.call" && row.event_type !== "tool.result") flushTools();
			switch (row.event_type) {
				case "user.message":
					transcript.push({ role: "user", content: [{ type: "text", text: String(payload.text) }] });
					break;
				case "assistant.message":
					transcript.push({ role: "assistant", content: [{ type: "text", text: String(payload.text) }] });
					break;
				case "tool.call":
					toolCalls.push({
						type: "toolCall",
						toolCallId: String(payload.toolCallId),
						toolName: String(payload.tool_name),
						input: payload.input,
					});
					break;
				case "tool.result":
					toolResults.push({
						role: "toolResult",
						toolCallId: String(payload.toolCallId),
						toolName: String(payload.tool_name),
						isError: payload.isError === true,
						content: payload.content as RestoredTranscriptMessage["content"],
					});
					if (toolResults.length === toolCalls.length) flushTools();
					break;
				case "operation.failed":
				case "operation.canceled":
					transcript.push({
						role: "assistant",
						content: [
							{
								type: "text",
								text:
									row.event_type === "operation.failed"
										? "前序执行失败，其部分输出未提交到 Context。"
										: "前序输入已取消。",
							},
						],
					});
					break;
			}
		}
		flushTools();
		return {
			messages: [],
			transcript,
			turns: [],
			interruptedTurnIds: [],
			skippedEvents: 0,
			droppedChunks: 0,
			errorEventCount: 0,
			observedLogLevel: "standard",
		};
	}

	private async execute(op: PendingOperation, controller: AbortController): Promise<void> {
		let callbacks = Promise.resolve();
		let sandboxResults = Promise.resolve();
		let outcome: PiExecutionOutcome = { status: "failed", error: "EXECUTION_FAILED" };
		let settled = true;
		const toolCalls = new Set<string>();
		const finishedTools = new Set<string>();
		let lastAssistant: string | undefined;
		try {
			const started = await this.withActive(op, async (tx, task, row) => {
				if (row.state !== "queued" || task.canceled_at !== null) return false;
				if ((row.queue_deadline as Date).getTime() <= this.now()) {
					await this.endOperation(tx, task, op.id, "failed", "QUEUE_TIMEOUT");
					return false;
				}
				if (op.credentialDeadline && op.credentialDeadline.getTime() <= this.now()) {
					await this.endOperation(tx, task, op.id, "failed", "CREDENTIAL_EXPIRED");
					return false;
				}
				await txRows(
					tx,
					"update router_operations set state='running',started_at=now(),context_baseline_sequence=$3,updated_at=now() where tenant_id=$1 and id=$2",
					this.tenantId,
					op.id,
					String(BigInt(op.inputEventSequence) - 1n),
				);
				await this.addEvents(tx, task, [{ operationId: op.id, type: "operation.started", payload: {} }]);
				return true;
			});
			if (started !== true) {
				await this.finish(op, { status: "cancelled", outputText: "" });
				return;
			}
			const [history, credentials, spec] = await Promise.all([
				this.contextFor(op),
				this.readCredentials(op),
				specFromSnapshot(op.snapshot, this.repos, this.tenantId as TenantId),
			]);
			if (this.now() >= op.executionDeadline.getTime()) throw failure(409, "EXECUTION_TIMEOUT", "Operation 已超时");
			outcome = await this.executor.execute({
				operationId: op.id,
				tenantId: this.tenantId as TenantId,
				principalId: op.keyId as never,
				publishedAppVersionId: spec.publishedAppVersionId,
				spec,
				...(op.snapshot.localTools?.includes("bash")
					? { sandboxPolicy: { tenantId: this.tenantId, workspaceId: op.taskId, deadlineAt: op.executionDeadline.getTime() } }
					: {}),
				limits: {
					maxTurns: spec.contextPolicy.maxTurns,
					maxContextTokens: spec.contextPolicy.maxContextTokens,
					toolResultMaxBytes: spec.contextPolicy.toolResultMaxBytes,
					turnTimeoutMs: spec.runtimePolicy.turnTimeoutMs,
					maxConcurrentTurnsPerConversation: spec.runtimePolicy.maxConcurrentTurnsPerConversation,
				},
				input: op.inputText,
				context: { history },
				signal: controller.signal,
				deadlineMs: Math.max(1, op.executionDeadline.getTime() - this.now()),
				credentials,
				authorizeMcpCall: async () => {
					const authorized = await this.withActive(
						op,
						async (_tx, task, row) =>
							row.state === "running" &&
							task.canceled_at === null &&
							(row.lease_expires_at as Date).getTime() > this.now() &&
							this.now() < op.executionDeadline.getTime() &&
							(!op.credentialDeadline || this.now() < op.credentialDeadline.getTime()),
					);
					if (!authorized) throw failure(403, "EXECUTION_NOT_AUTHORIZED", "执行已无权调用 MCP");
				},
				onProgress: (progress) => {
					const event = this.historyFromProgress(op, progress, toolCalls, finishedTools);
					if (!event) return;
					if (event.type === "assistant.message") lastAssistant = String(event.payload.text);
					const completed = finishedTools.size;
					callbacks = callbacks.then(() => this.writeProgress(op, event, completed));
					void callbacks.catch(this.onError);
				},
				onLlmTrace: async (trace) => this.recordTrace(op, trace),
				onSandboxResult: (result) => {
					sandboxResults = sandboxResults.then(async () => {
						await this.withActive(op, async (tx, task) => {
							await this.addEvents(tx, task, [
								{ operationId: op.id, type: "sandbox.execution", internal: true, payload: { ...result } },
							]);
						});
					}).catch(this.onError);
				},
				onCleanupUnconfirmed: (error) => {
					settled = false;
					this.onError(error);
				},
			});
			await callbacks;
		} catch (error) {
			if (outcome.status === "completed")
				outcome = { status: "failed", error: "EXECUTION_FAILED", usage: outcome.usage, llmUsage: outcome.llmUsage };
			else if (error instanceof OrchestrationError)
				outcome = { status: "failed", error: error.code, usage: outcome.usage, llmUsage: outcome.llmUsage };
			else this.onError(error);
			await callbacks.catch(() => undefined);
		}
		await sandboxResults;
		await this.finish(op, outcome, lastAssistant, settled);
	}

	private historyFromProgress(
		op: PendingOperation,
		progress: TranscriptProgress,
		toolCalls: Set<string>,
		finishedTools: Set<string>,
	): HistoryWrite | undefined {
		if (progress.type !== "item_started" && progress.type !== "item_finished") return;
		const item = progress.item;
		if (item.role === "assistant" && progress.type === "item_finished") {
			const text = item.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			if (text) return { type: "assistant.message", payload: { text } };
		}
		if (item.role !== "tool") return;
		const server = op.snapshot.servers.find((server) => server.tools.some((tool) => tool.name === item.toolName));
		const local = item.toolName === "bash" && op.snapshot.localTools?.includes("bash");
		if (!server && !local) return;
		const common = {
			...(server ? { server_id: server.serverId } : { provider: SANDBOX_PROVIDER }),
			tool_name: item.toolName,
			toolCallId: item.toolCallId,
		};
		if (progress.type === "item_started" && !toolCalls.has(item.toolCallId)) {
			toolCalls.add(item.toolCallId);
			return { type: "tool.call", payload: { ...common, input: item.input ?? {} } };
		}
		if (progress.type === "item_finished" && toolCalls.has(item.toolCallId) && !finishedTools.has(item.toolCallId)) {
			finishedTools.add(item.toolCallId);
			return {
				type: "tool.result",
				payload: {
					...common,
					content: item.content.filter((part) => part.type === "text" || part.type === "image"),
					isError: item.isError === true,
				},
			};
		}
	}

	private async writeProgress(op: PendingOperation, event: HistoryWrite, toolsCompleted: number): Promise<void> {
		await this.withActive(op, async (tx, task, row) => {
			if (row.state !== "running") return;
			const entries: EventWrite[] = [
				{ operationId: op.id, type: event.type, payload: event.payload, internal: true },
			];
			if (event.type !== "assistant.message" && task.canceled_at === null) {
				const payload = routerProgressSchema.parse({
					stage: "tools",
					tools_completed: toolsCompleted,
					updated_at: new Date(this.now()).toISOString(),
				});
				await txRows(
					tx,
					"update router_operations set progress=$3::jsonb,updated_at=now() where tenant_id=$1 and id=$2",
					this.tenantId,
					op.id,
					payload,
				);
				entries.push({ operationId: op.id, type: "operation.progress", payload });
			}
			await this.addEvents(tx, task, entries);
		});
	}

	private async recordTrace(op: PendingOperation, trace: LlmCallTrace): Promise<void> {
		await this.withActive(op, async (tx, _task, row) => {
			if (row.state !== "running") return;
			const payload = JSON.stringify(trace.kind === "request" ? trace.context : trace.message);
			if (trace.kind === "request") {
				await txRows(
					tx,
					`insert into orchestration_llm_calls(id,tenant_id,router_operation_id,call_index,model_provider,model_id,request_payload)
					values ($1,$2,$3,$4,$5,$6,$7::text::jsonb)
					on conflict (router_operation_id,call_index) do nothing`,
					randomUUID(),
					this.tenantId,
					op.id,
					trace.callIndex,
					trace.model.provider,
					trace.model.id,
					payload,
				);
			} else {
				await txRows(
					tx,
					`update orchestration_llm_calls set response_payload=$4::text::jsonb,completed_at=now()
					where tenant_id=$1 and router_operation_id=$2 and call_index=$3 and completed_at is null`,
					this.tenantId,
					op.id,
					trace.callIndex,
					payload,
				);
			}
		});
	}

	private async finish(
		op: PendingOperation,
		outcome: PiExecutionOutcome,
		lastAssistant?: string,
		settled = true,
	): Promise<void> {
		await this.withActive(op, async (tx, task, row) => {
			if (row.state !== "running" && row.state !== "queued") {
				if (settled) await this.releaseOccupancy(tx, task, op.id);
				return;
			}
			const { usage, complete } = operationUsage(outcome);
			const timedOut = this.now() >= op.executionDeadline.getTime();
			const status =
				task.canceled_at !== null
					? "canceled"
					: timedOut || !settled || outcome.status !== "completed"
						? "failed"
						: "completed";
			const knownErrors = [
				"INVALID_CAPABILITY_SNAPSHOT",
				"CREDENTIAL_EXPIRED",
				"EXECUTION_TIMEOUT",
				"MCP_AUTH_FAILED",
				"MCP_RESULT_BLOCKED",
				"EXECUTION_NOT_AUTHORIZED",
				"SANDBOX_UNAVAILABLE",
				"SANDBOX_START_FAILED",
			];
			let code = "EXECUTION_FAILED";
			if (task.canceled_at !== null) code = "USER_CANCELED";
			else if (!settled) code = "EXECUTION_CLEANUP_UNCONFIRMED";
			else if (timedOut)
				code =
					op.credentialDeadline && this.now() >= op.credentialDeadline.getTime()
						? "CREDENTIAL_EXPIRED"
						: "EXECUTION_TIMEOUT";
			else if (outcome.status === "failed" && knownErrors.includes(outcome.error)) code = outcome.error;
			else if (outcome.status === "cancelled") code = "EXECUTION_INTERRUPTED";
			const output = "outputText" in outcome ? outcome.outputText : undefined;
			if (output && output !== lastAssistant)
				await this.addEvents(tx, task, [
					{ operationId: op.id, type: "assistant.message", payload: { text: output }, internal: true },
				]);
			await this.endOperation(
				tx,
				task,
				op.id,
				status,
				code,
				status === "completed" ? (output ?? "") : null,
				usage,
				complete,
				settled,
			);
		});
	}

	private async recordedUsage(tx: TransactionSql, id: string): Promise<{ usage: Usage; complete: false }> {
		const rows = await txRows(
			tx,
			"select call_index,model_provider,model_id,response_payload from orchestration_llm_calls where tenant_id=$1 and router_operation_id=$2 and response_payload is not null",
			this.tenantId,
			id,
		);
		const collector = createLlmUsageCollector();
		for (const row of rows) {
			collector.observeTrace({
				kind: "response",
				callIndex: Number(row.call_index),
				model: { provider: String(row.model_provider), id: String(row.model_id) },
				message: row.response_payload as Extract<LlmCallTrace, { kind: "response" }>["message"],
			});
		}
		return { usage: operationUsage({ llmUsage: collector.result() }).usage, complete: false };
	}

	private async endOperation(
		tx: TransactionSql,
		task: Record<string, unknown>,
		id: string,
		status: "completed" | "failed" | "canceled",
		code: string,
		result: string | null = null,
		usage: Usage = {},
		complete = false,
		settled = true,
	): Promise<void> {
		const sequence = await this.addEvents(tx, task, [
			{
				operationId: id,
				type: `operation.${status}`,
				payload: status === "completed" ? { result } : status === "failed" ? { error: { code } } : { reason: code },
			},
		]);
		await txRows(
			tx,
			`update router_operations set state=$3,result=$4,error_code=$5,cancel_reason=$6,usage=$7::jsonb,
				usage_complete=$8,context_committed_sequence=$9,ended_at=now(),updated_at=now()
			 where tenant_id=$1 and id=$2 and state in ('queued','running')`,
			this.tenantId,
			id,
			status,
			result,
			status === "failed" ? code : null,
			status === "canceled" ? code : null,
			usage,
			complete,
			status === "completed" ? sequence : null,
		);
		if (status === "completed") {
			await txRows(
				tx,
				"update router_tasks set latest_completed_operation_id=$3 where tenant_id=$1 and id=$2",
				this.tenantId,
				String(task.id),
				id,
			);
			await this.addEvents(tx, task, [{ operationId: id, type: "context.committed", payload: { sequence } }]);
		}
		if (status === "failed") await this.cancelWaiting(tx, task, ROUTER_PREDECESSOR_CANCEL_REASON);
		if (settled) await this.releaseOccupancy(tx, task, id);
	}

	private async cancelWaiting(tx: TransactionSql, task: Record<string, unknown>, reason: string): Promise<void> {
		const rows = await txRows(
			tx,
			`update router_operations set state='canceled',cancel_reason=$3,ended_at=now(),updated_at=now()
			where tenant_id=$1 and task_id=$2 and state='queued' returning id,operation_sequence`,
			this.tenantId,
			String(task.id),
			reason,
		);
		if (!rows.length) return;
		await this.addEvents(
			tx,
			task,
			[...rows]
				.sort((a, b) => Number(a.operation_sequence) - Number(b.operation_sequence))
				.map((row) => ({
					operationId: String(row.id),
					type: "operation.canceled",
					payload: { reason },
				})),
		);
		await txRows(
			tx,
			`delete from router_operation_credentials c using router_operations o
			where c.tenant_id=o.tenant_id and c.operation_id=o.id and o.tenant_id=$1 and o.task_id=$2
			  and o.state='canceled' and not o.holds_task_occupancy`,
			this.tenantId,
			String(task.id),
		);
	}

	/** Operator and recovery path: validate process exit against the recorded owner. */
	async cleanup(operationId: string): Promise<{ released: boolean; reason?: string }> {
		return this.client.transaction(async (tx) => {
			const [task] = await txRows(
				tx,
				`select t.* from router_tasks t join router_operations o on t.tenant_id=o.tenant_id and t.id=o.task_id
				where o.tenant_id=$1 and o.id=$2 for update of t`,
				this.tenantId,
				operationId,
			);
			if (!task) return { released: false, reason: "OPERATION_NOT_ACCESSIBLE" };
			const [row] = await txRows(
				tx,
				"select * from router_operations where tenant_id=$1 and id=$2",
				this.tenantId,
				operationId,
			);
			if (row.holds_task_occupancy !== true) return { released: true };
			if (String(task.fence_token) !== String(row.lease_token)) return { released: false, reason: "FENCE_CONFLICT" };
			if (!routerWorkerHasExited(String(row.worker_instance_id)))
				return { released: false, reason: "INSUFFICIENT_EXIT_EVIDENCE" };
			if (row.state === "running") {
				const { usage } = await this.recordedUsage(tx, operationId);
				await this.endOperation(
					tx,
					task,
					operationId,
					task.canceled_at === null ? "failed" : "canceled",
					task.canceled_at === null ? "EXECUTION_INTERRUPTED" : "USER_CANCELED",
					null,
					usage,
				);
			} else await this.releaseOccupancy(tx, task, operationId, row.state !== "queued");
			return { released: true };
		});
	}

	private async releaseOccupancy(
		tx: TransactionSql,
		task: Record<string, unknown>,
		id: string,
		purgeCredentials = true,
	): Promise<void> {
		const updated = await txRows(
			tx,
			`update router_operations set holds_task_occupancy=false,lease_expires_at=null,updated_at=now()
			where tenant_id=$1 and id=$2 and holds_task_occupancy returning id`,
			this.tenantId,
			id,
		);
		if (purgeCredentials)
			await txRows(
				tx,
				"delete from router_operation_credentials where tenant_id=$1 and operation_id=$2",
				this.tenantId,
				id,
			);
		if (updated.length && task.canceled_at !== null)
			await this.addEvents(tx, task, [{ type: "task.cleanup_completed", payload: {} }]);
	}

	async usageFor(keyId: string, taskId: string | null = null) {
		const [totals] = await this.client.run(
			`select sum((o.usage->>'total_tokens')::bigint) as total_tokens,
			 sum((o.usage->>'input_tokens')::bigint) as input_tokens,sum((o.usage->>'output_tokens')::bigint) as output_tokens,
			 count(*) filter (where not o.usage_complete)::int as unknown_operations
			 from router_operations o join router_tasks t on o.tenant_id=t.tenant_id and o.task_id=t.id
			 where t.tenant_id=$1 and t.key_id=$2 and ($3::uuid is null or t.id=$3)`,
			this.tenantId,
			keyId,
			taskId,
		);
		const known_totals = Object.fromEntries(
			["total_tokens", "input_tokens", "output_tokens"].flatMap((key) =>
				totals[key] == null ? [] : [[key, Number(totals[key])]],
			),
		);
		const unknown_operations = Number(totals.unknown_operations);
		return { complete: unknown_operations === 0, known_totals, unknown_operations };
	}

	async taskView(
		principal: Pick<ApiKeyPrincipal, "keyId">,
		taskId: string,
		query: ReturnType<typeof taskQuerySchema.parse>,
	) {
		const [task] = await this.client.run(
			"select * from router_tasks where tenant_id=$1 and key_id=$2 and id=$3",
			this.tenantId,
			principal.keyId,
			taskId,
		);
		if (!task) throw failure(404, "TASK_NOT_ACCESSIBLE", "Task 不存在或不可访问");
		const after = pageCursor(query.after);
		const operations = await this.client.run(
			`select id,operation_sequence,state,error_code,result from router_operations where tenant_id=$1 and task_id=$2 and operation_sequence>$3 order by operation_sequence limit $4`,
			this.tenantId,
			taskId,
			after,
			query.limit + 1,
		);
		const page = operations.slice(0, query.limit);
		const canceled = task.canceled_at !== null;
		const pending = await this.client.run(
			"select count(*)::int as n from router_operations where tenant_id=$1 and task_id=$2 and state in ('queued','running')",
			this.tenantId,
			taskId,
		);
		const occupancy = await this.client.run(
			"select count(*)::int as n from router_operations where tenant_id=$1 and task_id=$2 and holds_task_occupancy",
			this.tenantId,
			taskId,
		);
		const pendingCount = Number(pending[0].n);
		const occupancyCount = Number(occupancy[0].n);
		const status = canceled ? "canceled" : pendingCount > 0 || occupancyCount > 0 ? "active" : "idle";
		const [latestCompleted] = await this.client.run(
			"select id,result from router_operations where tenant_id=$1 and id=$2",
			this.tenantId,
			task.latest_completed_operation_id as string | null,
		);
		const [latest] = await this.client.run(
			"select id,state,error_code from router_operations where tenant_id=$1 and id=$2",
			this.tenantId,
			task.latest_operation_id as string | null,
		);
		return {
			id: String(task.id),
			status,
			cleanup_status: canceled ? (occupancyCount > 0 ? "pending" : "completed") : "none",
			cleanup_reason: canceled && occupancyCount > 0 ? "等待执行实例结束" : null,
			latest_result: latestCompleted
				? { operation_id: String(latestCompleted.id), result: String(latestCompleted.result ?? "") }
				: null,
			latest_operation: latest
				? {
						id: String(latest.id),
						status: String(latest.state),
						error: latest.error_code ? { code: String(latest.error_code) } : null,
					}
				: null,
			operations: page.map((op) => ({
				id: String(op.id),
				sequence: Number(op.operation_sequence),
				status: String(op.state),
			})),
			usage: await this.usageFor(principal.keyId, taskId),
			next_cursor: operations.length > query.limit ? String(page[page.length - 1].operation_sequence) : null,
			has_more: operations.length > query.limit,
		};
	}

	async operationView(principal: Pick<ApiKeyPrincipal, "keyId">, operationId: string) {
		const [row] = await this.client.run(
			`select o.*,e.payload->>'text' as input_text from router_operations o
			 join router_task_events e on e.tenant_id=o.tenant_id and e.task_id=o.task_id and e.sequence=o.input_event_sequence
			 where o.tenant_id=$1 and o.id=$2 and o.task_id in (select id from router_tasks where tenant_id=$1 and key_id=$3)`,
			this.tenantId,
			operationId,
			principal.keyId,
		);
		if (!row) throw failure(404, "OPERATION_NOT_ACCESSIBLE", "Operation 不存在或不可访问");
		const usage = row.usage as Usage;
		return {
			id: String(row.id),
			task_id: String(row.task_id),
			sequence: Number(row.operation_sequence),
			status: String(row.state),
			input: String(row.input_text ?? ""),
			result: row.result === null ? null : String(row.result),
			error: row.error_code === null ? null : { code: String(row.error_code) },
			cancel_reason: row.cancel_reason === null ? null : String(row.cancel_reason),
			progress: row.progress === null ? null : (JSON.parse(JSON.stringify(row.progress)) as Record<string, unknown>),
			usage: {
				complete: row.usage_complete === true,
				total_tokens: usage.total_tokens ?? null,
				input_tokens: usage.input_tokens ?? null,
				output_tokens: usage.output_tokens ?? null,
			},
			queued_at: (row.queued_at as Date).toISOString(),
			started_at: row.started_at ? (row.started_at as Date).toISOString() : null,
			ended_at: row.ended_at ? (row.ended_at as Date).toISOString() : null,
		};
	}

	private async eventsView(
		principal: ApiKeyPrincipal,
		taskId: string,
		query: ReturnType<typeof eventsQuerySchema.parse>,
	) {
		const [task] = await this.client.run(
			"select 1 from router_tasks where tenant_id=$1 and key_id=$2 and id=$3",
			this.tenantId,
			principal.keyId,
			taskId,
		);
		if (!task) throw failure(404, "TASK_NOT_ACCESSIBLE", "Task 不存在或不可访问");
		const after = pageCursor(query.after);
		const rows = await this.client.run(
			`select * from router_task_public_events where tenant_id=$1 and task_id=$2 and sequence>$3 order by sequence limit $4`,
			this.tenantId,
			taskId,
			after,
			query.limit + 1,
		);
		const page = rows.slice(0, query.limit);
		return {
			events: page.map((row) => ({
				sequence: String(row.sequence),
				operation_id: row.operation_id === null ? null : String(row.operation_id),
				type: String(row.event_type),
				schema_version: Number(row.schema_version),
				payload: JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>,
				created_at: (row.created_at as Date).toISOString(),
			})),
			next_cursor: rows.length > query.limit ? String(page[page.length - 1].sequence) : null,
			has_more: rows.length > query.limit,
		};
	}

	private async cancelTask(principal: ApiKeyPrincipal, taskId: string, reason: string | undefined) {
		const result = await this.client.transaction(async (tx) => {
			await this.keys.lockAndVerify(tx, principal, principal.secretHash);
			const task = await this.lockedTask(tx, principal, taskId);
			if (task.canceled_at === null) {
				await txRows(
					tx,
					"update router_tasks set canceled_at=now(),cancel_reason=$3,updated_at=now() where tenant_id=$1 and id=$2",
					this.tenantId,
					taskId,
					reason ?? "USER_CANCELED",
				);
				await this.addEvents(tx, task, [{ type: "task.canceled", payload: { reason: "USER_CANCELED" } }]);
				await this.cancelWaiting(tx, task, "USER_CANCELED");
			}
			const [fresh] = await txRows(
				tx,
				"select canceled_at from router_tasks where tenant_id=$1 and id=$2",
				this.tenantId,
				taskId,
			);
			const [occupancy] = await txRows(
				tx,
				"select count(*)::int as n from router_operations where tenant_id=$1 and task_id=$2 and holds_task_occupancy",
				this.tenantId,
				taskId,
			);
			return {
				task_id: taskId,
				status: "canceled",
				canceled_at: (fresh.canceled_at as Date).toISOString(),
				cleanup_pending: Number(occupancy.n) > 0,
			};
		});
		for (const { op, controller } of this.active.values()) if (op.taskId === taskId) controller.abort();
		return result;
	}

	/** R030-R033: the six frozen HTTP routes. */
	http(): HttpRequestHandler {
		return async (request: IncomingMessage, response: ServerResponse) => {
			const pathname = requestPathname(request.url) ?? "";
			if (!pathname.startsWith("/api/aaas/v1/")) return false;
			const isRouterPath =
				pathname === TASKS || pathname.startsWith(`${TASKS}/`) || pathname.startsWith(`${OPERATIONS}/`);
			if (!isRouterPath) return false;
			response.setHeader("Cache-Control", "no-store");
			const requestId = readRequestId(request);
			try {
				const authorization = request.headers.authorization;
				const principal = await this.keys.authenticate(authorization);
				const header = request.headers[ROUTER_CAPABILITY_HEADER];
				const scopeHeader = Array.isArray(header) ? header[0] : header;
				let body: unknown;
				if (["POST", "PUT", "PATCH"].includes(request.method ?? "")) {
					const parsed = await readJsonBody(request, 96 * 1024);
					if (parsed.kind !== "ok")
						throw failure(
							parsed.kind === "too_large" ? 413 : 400,
							parsed.kind === "too_large" ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
							"请求体无效或过大",
						);
					body = parsed.value;
				}
				let data: unknown;
				let schema: z.ZodType;
				let status = 200;
				if (pathname === TASKS && request.method === "POST") {
					const idem = request.headers["idempotency-key"];
					if (typeof idem !== "string") throw failure(400, "INVALID_REQUEST", "缺少 Idempotency-Key");
					const accepted = await this.accept(principal, idem, scopeHeader, body, true);
					data = {
						task_id: accepted.taskId,
						status: "active",
						operation_id: accepted.operationId,
						operation_status: "queued",
						ordinal: accepted.ordinal,
						duplicate: accepted.duplicate,
					};
					status = 201;
					schema = createTaskResponseSchema;
				} else if (
					pathname.startsWith(`${TASKS}/`) &&
					pathname.endsWith(INPUTS_SUFFIX) &&
					request.method === "POST"
				) {
					const taskId = z
						.string()
						.uuid()
						.parse(pathname.slice(TASKS.length + 1, -INPUTS_SUFFIX.length));
					const idem = request.headers["idempotency-key"];
					if (typeof idem !== "string") throw failure(400, "INVALID_REQUEST", "缺少 Idempotency-Key");
					const accepted = await this.accept(principal, idem, scopeHeader, body, false, taskId);
					data = {
						task_id: accepted.taskId,
						operation_id: accepted.operationId,
						operation_status: "queued",
						ordinal: accepted.ordinal,
						duplicate: accepted.duplicate,
					};
					status = 202;
					schema = appendInputResponseSchema;
				} else if (pathname.startsWith(`${OPERATIONS}/`) && request.method === "GET") {
					data = await this.operationView(
						principal,
						z
							.string()
							.uuid()
							.parse(pathname.slice(OPERATIONS.length + 1)),
					);
					schema = operationViewSchema;
				} else if (pathname === TASKS) {
					return false;
				} else {
					const tail = pathname.slice(TASKS.length + 1);
					const parts = tail.split("/").filter(Boolean);
					const taskId = z.string().uuid().parse(parts[0]);
					const query: Record<string, unknown> = Object.fromEntries(
						new URL(request.url ?? "/", "http://localhost").searchParams,
					);
					if (typeof query.limit === "string" && /^\d+$/.test(query.limit)) query.limit = Number(query.limit);
					if (parts.length === 1 && request.method === "GET") {
						data = await this.taskView(principal, taskId, taskQuerySchema.parse(query));
						schema = taskViewSchema;
					} else if (parts.length === 2 && parts[1] === EVENTS_SUFFIX.slice(1) && request.method === "GET") {
						data = await this.eventsView(principal, taskId, eventsQuerySchema.parse(query));
						schema = taskEventsResponseSchema;
					} else if (parts.length === 2 && parts[1] === CANCEL_SUFFIX.slice(1) && request.method === "POST") {
						data = await this.cancelTask(principal, taskId, cancelTaskRequestSchema.parse(body ?? {}).reason);
						schema = cancelTaskResponseSchema;
					} else throw failure(404, "NOT_FOUND", "接口不存在");
				}
				const output = schema.safeParse(data);
				if (!output.success) throw failure(500, "INTERNAL", "响应不符合 Router 契约");
				jsonBody(response, status, { data: output.data, requestId });
			} catch (error) {
				const e =
					error instanceof OrchestrationError
						? error
						: error instanceof ZodError
							? failure(400, "INVALID_REQUEST", "请求不符合 Router 契约")
							: error instanceof Error && "code" in error && String(error.code) === "23505"
								? failure(409, "IDEMPOTENCY_CONFLICT", "幂等键冲突")
								: failure(500, "INTERNAL", "操作失败");
				jsonBody(response, e.status, errorEnvelope(e.code, e.message, requestId, e.status >= 500));
			}
			return true;
		};
	}
}
