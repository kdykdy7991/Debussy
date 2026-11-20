import { randomUUID } from "node:crypto";
import type { AdminSandboxStatistics } from "@earendil-works/pi-protocol";
import { z } from "zod";
import { redact } from "../logging/redact.ts";
import type { PostgresClient } from "../persistence/postgres/client.ts";
import { routerCallUsageSql, routerKnownCacheReadSql, routerTokenSql } from "../persistence/postgres/repositories/router-call-usage.ts";
import { txRows } from "../persistence/postgres/repositories/tx.ts";
import type { PublishingRepositories } from "../publishing/repositories.ts";
import { inspectSandbox, type SandboxConfig } from "../runtime/sandbox.ts";
import { OrchestrationError } from "./contracts.ts";
import { directCapabilitiesSchema } from "./router-capability-contracts.ts";
import { resolveEffectiveCapabilities, saveDirectCapabilities } from "./router-capability.ts";
import { operationViewSchema, taskViewSchema } from "./router-contracts.ts";
import type { RouterRuntime } from "./router-runtime.ts";
import { routerWorkerHasExited } from "./router-worker-identity.ts";

const id = z.string().uuid();
const revision = z.number().int().min(0).max(2_147_483_646);
const saveRequest = z.object({ expected_revision: revision, capabilities: directCapabilitiesSchema }).strict();
const scopeRequest = z.discriminatedUnion("action", [
	z
		.object({ action: z.literal("cutover"), expected_revision: revision, migration_confirmed: z.literal(true) })
		.strict(),
	z.object({ action: z.literal("rollback"), expected_revision: revision }).strict(),
]);
const queryPage = z
	.object({
		limit: z
			.string()
			.regex(/^\d{1,3}$/)
			.transform(Number)
			.pipe(z.number().min(1).max(200))
			.optional(),
		after: z
			.string()
			.regex(/^\d{1,19}$/)
			.optional(),
	})
	.strict();
const taskListPage = z.object({ after: id.optional() }).strict();
const trajectoryPage = queryPage.extend({
	kind: z.literal("model").optional(),
	after: z.string().regex(/^(model|mcp|bash):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/).optional(),
});
const executionListQuery = z
	.object({
		after: id.optional(),
		key_id: id.optional(),
		q: z.string().trim().max(200).optional(),
		status: z.enum(["queued", "running", "completed", "failed", "canceled"]).optional(),
	})
	.strict();
const CUTOVER = "aaas.key.router-cutover";
const ROLLBACK = "aaas.key.router-rollback";
const sandboxRange = z.object({ hours: z.enum(["24", "168", "720"]).default("24") }).strict();

function sandboxTraceText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return redact(value)
		.replace(/\b(?:ak_|oi_|sk-)[\w-]{16,}\b/g, "[REDACTED]")
		.replace(/\b([\w-]*(?:password|secret|token|api[_-]?key)\s*=\s*)("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s;]+)/gi, "$1[REDACTED]")
		.slice(0, 4096);
}

export function createRouterAdmin(options: {
	client: PostgresClient;
	repos: PublishingRepositories;
	tenantId: string;
	router: RouterRuntime;
	sandboxConfig?: SandboxConfig;
	listModels: () => Promise<readonly { provider: string; id: string }[]>;
}) {
	const { client, repos, tenantId, router } = options;
	const notFound = () => new OrchestrationError(404, "NOT_FOUND", "资源不存在或不可访问");
	const lockKeySql =
		"select router_capability_scope,direct_capability_revision,status from aaas_api_keys where tenant_id=$1 and id=$2 for update";
	const hasCutoverSql =
		"select 1 from audit_events where tenant_id=$1 and resource_type='aaas_api_key' and resource_id=$2 and action=$3 limit 1";

	async function listExecutions(url: URL): Promise<unknown> {
		const query = executionListQuery.parse(Object.fromEntries(url.searchParams));
		const rows = await client.run(
			`select o.id,o.task_id,o.operation_sequence::text,o.state as status,o.created_at,
			        t.key_id,k.name as key_name
			 from router_operations o
			 join router_tasks t on t.tenant_id=o.tenant_id and t.id=o.task_id
			 join aaas_api_keys k on k.tenant_id=t.tenant_id and k.id=t.key_id
			 where o.tenant_id=$1 and ($2::uuid is null or t.key_id=$2)
			   and ($3::text is null or o.state=$3)
			   and ($4::text is null or position(lower($4) in o.id::text)>0
			        or position(lower($4) in t.id::text)>0
			        or position(lower($4) in t.key_id::text)>0
			        or position(lower($4) in lower(k.name))>0)
			   and ($5::uuid is null or (o.created_at,o.id) <
			     (select c.created_at,c.id from router_operations c
			      join router_tasks ct on ct.tenant_id=c.tenant_id and ct.id=c.task_id
			      where c.tenant_id=$1 and c.id=$5 and ($2::uuid is null or ct.key_id=$2)))
			 order by o.created_at desc,o.id desc limit 51`,
			tenantId,
			query.key_id ?? null,
			query.status ?? null,
			query.q || null,
			query.after ?? null,
		);
		return {
			items: rows.slice(0, 50),
			next_cursor: rows.length > 50 ? rows[49].id : null,
			...(query.key_id ? { usage: await router.usageFor(query.key_id) } : {}),
		};
	}

	async function sandboxStatistics(url: URL): Promise<AdminSandboxStatistics> {
		const { hours } = sandboxRange.parse(Object.fromEntries(url.searchParams));
		const [row] = await client.run(
			`with bounds as (
				select statement_timestamp() - make_interval(hours => $2::int) as range_start,
					statement_timestamp() as range_end,
					case when $2::int = 24 then interval '1 hour' else interval '24 hours' end as width,
					timestamptz '2000-01-01 00:00:00+08' as origin
			), executions as (
				select id,task_id,operation_id,created_at,payload->>'status' as status,
					payload->>'startedAt' as started_at,payload->>'endedAt' as ended_at,
					(payload->>'durationMs')::numeric as ms,payload->>'reason' as reason
				from router_task_events, bounds where tenant_id=$1 and event_type='sandbox.execution'
				  and created_at between range_start and range_end
			), counts_by_bucket as (
				select date_bin(width,created_at,origin) as bucket,count(*) as count
				from executions, bounds group by 1
			), trend as (
				select bucket,coalesce(count,0) as count
				from bounds cross join lateral generate_series(
					date_bin(width,range_start,origin),date_bin(width,range_end,origin),width
				) as buckets(bucket) left join counts_by_bucket using (bucket)
			), recent as (
				select e.*,t.key_id from (
					select * from executions order by created_at desc,id desc limit 50
				) e join router_tasks t on t.tenant_id=$1 and t.id=e.task_id
			)
			select jsonb_build_object(
				'total',count(*),
				'counts',jsonb_build_object(
					'success',count(*) filter (where status='success'),
					'command_failed',count(*) filter (where status='command_failed'),
					'start_failed',count(*) filter (where status='start_failed'),
					'timeout',count(*) filter (where status='timeout'),
					'canceled',count(*) filter (where status='canceled')
				),
				'successRate',count(*) filter (where status='success')::float / nullif(count(*),0),
				'averageMs',round(avg(ms)),
				'p95Ms',percentile_disc(0.95) within group (order by ms),
				'trend',(select jsonb_agg(jsonb_build_object('startAt',bucket,'count',count) order by bucket) from trend),
				'recent',coalesce((select jsonb_agg(jsonb_build_object(
					'id',id,'keyId',key_id,'taskId',task_id,'operationId',operation_id,'tool','bash',
					'startedAt',started_at,'endedAt',ended_at,'status',status,'durationMs',ms,'reason',reason
				) order by created_at desc,id desc) from recent),'[]'::jsonb)
			) as data from executions`,
			tenantId,
			hours,
		);
		return row.data as AdminSandboxStatistics;
	}

	async function handle(
		keyIdValue: string,
		parts: readonly string[],
		method: string | undefined,
		url: URL,
		body: unknown,
		requestId: string,
	): Promise<unknown> {
		const keyId = id.parse(keyIdValue);
		const auditRead = (resourceType: "router_task" | "router_operation", resourceId: string, action: string) =>
			client.run(
				`insert into audit_events(id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id,metadata)
			 values ($1,$2,'platform_admin',$2::uuid::text,$3,$4,$5,$6,$7::jsonb)`,
				randomUUID(),
				tenantId,
				action,
				resourceType,
				resourceId,
				requestId,
				{ key_id: keyId },
			);
		const root = parts.length === 0;
		if (root && method === "PUT") {
			const { capabilities, expected_revision } = saveRequest.parse(body);
			if (
				!(await options.listModels()).some(
					(model) => model.provider === capabilities.model.provider && model.id === capabilities.model.model_id,
				)
			)
				throw new OrchestrationError(422, "INVALID_MODEL", "模型不在当前可用目录中");
			return saveDirectCapabilities({
				client,
				repos,
				tenantId,
				keyId,
				expectedRevision: expected_revision,
				capabilities,
				requestId,
			});
		}
		if (root && method === "PATCH") {
			const input = scopeRequest.parse(body);
			return client.transaction(async (tx) => {
				const [key] = await txRows(tx, lockKeySql, tenantId, keyId);
				if (!key) throw notFound();
				if (key.status === "revoked") throw new OrchestrationError(409, "KEY_REVOKED", "Key 已撤销");
				if (Number(key.direct_capability_revision) !== input.expected_revision)
					throw new OrchestrationError(409, "CAPABILITY_REVISION_CONFLICT", "能力修订已更新，请重新加载");
				const cutover = input.action === "cutover";
				const previous = cutover ? "dual" : "router";
				const scope = cutover ? "router" : "dual";
				if (key.router_capability_scope !== previous)
					throw new OrchestrationError(409, "INVALID_CAPABILITY_SCOPE", "Key 当前范围不支持此切换");
				if (!cutover && !(await txRows(tx, hasCutoverSql, tenantId, keyId, CUTOVER)).length)
					throw new OrchestrationError(409, "LEGACY_ROLLBACK_UNAVAILABLE", "此 Key 没有退出旧入口的记录");
				await resolveEffectiveCapabilities({
					client,
					tx,
					repos,
					tenantId,
					principal: { keyId },
					scope: cutover ? "router" : "legacy",
				});
				// Scope and capability edits share one revision, so a stale editor cannot undo a switch.
				const capabilityRevision = input.expected_revision + 1;
				await txRows(
					tx,
					`update aaas_api_keys set router_capability_scope=$3,direct_capability_revision=$4,
					router_capability_updated_at=now(),updated_at=now() where tenant_id=$1 and id=$2`,
					tenantId,
					keyId,
					scope,
					capabilityRevision,
				);
				await txRows(
					tx,
					`insert into audit_events(id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id,metadata)
					values ($1,$2,'platform_admin',$2::uuid::text,$3,'aaas_api_key',$4,$5,$6::jsonb)`,
					randomUUID(),
					tenantId,
					cutover ? CUTOVER : ROLLBACK,
					keyId,
					requestId,
					{
						previous_scope: previous,
						capability_scope: scope,
						capability_revision: capabilityRevision,
						...(cutover ? { migration_confirmed: true } : {}),
					},
				);
				return { scope, capabilityRevision };
			});
		}
		if (method !== "GET") throw notFound();
		if (root) {
			const [key] = await client.run(
				"select router_capability_scope,direct_capabilities,direct_capability_revision,status from aaas_api_keys where tenant_id=$1 and id=$2",
				tenantId,
				keyId,
			);
			if (!key) throw notFound();
			return {
				scope: key.router_capability_scope,
				capabilityRevision: Number(key.direct_capability_revision),
				capabilities:
					key.direct_capabilities === null ? null : directCapabilitiesSchema.parse(key.direct_capabilities),
				canRollback:
					key.status !== "revoked" &&
					key.router_capability_scope === "router" &&
					(await client.run(hasCutoverSql, tenantId, keyId, CUTOVER)).length > 0,
			};
		}
		if (parts.length === 1 && parts[0] === "tasks") {
			const { after } = taskListPage.parse(Object.fromEntries(url.searchParams));
			if (!(await client.run("select 1 from aaas_api_keys where tenant_id=$1 and id=$2", tenantId, keyId)).length)
				throw notFound();
			const rows = await client.run(
				`select t.id,t.created_at,t.updated_at,case when t.canceled_at is not null then 'canceled'
				when exists(select 1 from router_operations o where o.tenant_id=t.tenant_id and o.task_id=t.id and (o.state in ('queued','running') or o.holds_task_occupancy))
				then 'active' else 'idle' end as status from router_tasks t where t.tenant_id=$1 and t.key_id=$2
				and ($3::uuid is null or (t.created_at,t.id) < (select c.created_at,c.id from router_tasks c where c.tenant_id=$1 and c.key_id=$2 and c.id=$3))
				order by t.created_at desc,t.id desc limit 51`,
				tenantId,
				keyId,
				after ?? null,
			);
			return {
				tasks: rows.slice(0, 50),
				next_cursor: rows.length > 50 ? rows[49].id : null,
				usage: await router.usageFor(keyId),
			};
		}
		if (parts.length === 2 && parts[0] === "operations") {
			const operation = operationViewSchema.parse(await router.operationView({ keyId }, id.parse(parts[1])));
			const [cache] = await client.run(
				`select usage.*
				from router_operations o
				cross join lateral (${routerCallUsageSql}) usage
				where o.tenant_id=$1 and o.id=$2`,
				tenantId,
				operation.id,
			);
			await auditRead("router_operation", operation.id, "router.operation.read");
			return {
				...operation,
				cache_read: {
					tokens: cache.read_tokens == null ? null : Number(cache.read_tokens),
					reported_calls: Number(cache.reported_calls),
					total_calls: Number(cache.total_calls),
				},
			};
		}
		if (parts.length === 3 && parts[0] === "operations" && parts[2] === "trajectory") {
			const operationId = id.parse(parts[1]);
			const { after, limit = 50, kind } = trajectoryPage.parse(Object.fromEntries(url.searchParams));
			const [owned] = await client.run(
				`select 1 from router_operations o
				join router_tasks t on t.tenant_id=o.tenant_id and t.id=o.task_id
				where o.tenant_id=$1 and o.id=$2 and t.key_id=$3`,
				tenantId,
				operationId,
				keyId,
			);
			if (!owned) throw new OrchestrationError(404, "OPERATION_NOT_ACCESSIBLE", "Operation 不存在或不可访问");
			const rows = await client.run(
				`with entries as (
					select 'model:' || id::text as id, 'model' as kind,
					       model_provider || '/' || model_id as name, call_index,
					       created_at as recorded_at, created_at as started_at, completed_at as ended_at,
					       case when completed_at is not null then
					        floor(extract(epoch from greatest(completed_at-created_at, interval '0 milliseconds')) * 1000)::float8
					       end as duration_ms,
					       case when completed_at is null then 'request_recorded'
					            when response_payload->>'stopReason'='error' then 'error'
					            when response_payload->>'stopReason'='aborted' then 'cancelled'
					            else 'response_recorded' end as outcome,
					       null::text as error_code, null::uuid as mcp_server_id, null::integer as mcp_revision,
					       (${routerTokenSql("input")})::float8 as input_tokens,
					       (${routerTokenSql("output")})::float8 as output_tokens,
					       (case when ${routerKnownCacheReadSql} then ${routerTokenSql("cacheRead")} end)::float8 as cache_read_tokens,
					       (${routerTokenSql("cacheWrite")})::float8 as cache_write_tokens,
					       (${routerTokenSql("totalTokens")})::float8 as total_tokens,
					       null::text as bash_command, null::text as bash_output
					from orchestration_llm_calls
					cross join lateral (select response_payload->'usage' as usage) normalized
					where tenant_id=$1 and router_operation_id=$2
					union all
					select 'mcp:' || id::text, 'mcp', tool_name, null::integer,
					       created_at, created_at - latency_ms * interval '1 millisecond', created_at,
					       latency_ms::float8, outcome,
					       case when error_code ~ '^[A-Z0-9_]{1,80}$' then error_code end,
					       mcp_server_id,mcp_revision,null::float8,null::float8,null::float8,null::float8,null::float8,
					       null::text,null::text
					from mcp_call_audits where tenant_id=$1 and router_operation_id=$2 and not $5::boolean
					union all
					select 'bash:' || c.id::text, 'bash', 'bash', null::integer,
					       c.created_at, c.created_at, r.created_at, null::float8,
					       case when r.id is null then 'request_recorded'
					            when r.payload->'isError' = 'true'::jsonb then 'error' else 'success' end,
					       null::text,null::uuid,null::integer,null::float8,null::float8,null::float8,null::float8,null::float8,
					       left(c.payload#>>'{input,command}',8192),left(r.payload#>>'{content,0,text}',8192)
					from router_task_events c
					left join router_task_events r on r.tenant_id=c.tenant_id and r.operation_id=c.operation_id
						and r.sequence>c.sequence and r.event_type='tool.result' and r.payload->>'provider'='linux-bwrap'
						and r.payload->>'toolCallId'=c.payload->>'toolCallId'
					where c.tenant_id=$1 and c.operation_id=$2 and c.event_type='tool.call'
						and c.payload->>'provider'='linux-bwrap' and not $5::boolean
				)
				select id,kind,name,call_index,started_at,ended_at,duration_ms,outcome,error_code,mcp_server_id,mcp_revision,
				       input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,bash_command,bash_output
				from entries
				where $3::text is null or (recorded_at,id) > (select recorded_at,id from entries where id=$3)
				order by recorded_at,id limit $4`,
				tenantId,
				operationId,
				after ?? null,
				limit + 1,
				kind === "model",
			);
			await auditRead("router_operation", operationId, "router.trajectory.read");
			return {
				entries: rows.slice(0, limit).map(({ bash_command, bash_output, ...row }) =>
					row.kind === "bash" ? {
						...row,
						bash: { command: sandboxTraceText(bash_command), output: sandboxTraceText(bash_output) },
					} : row,
				),
				next_cursor: rows.length > limit ? rows[limit - 1].id : null,
			};
		}
		if (parts[0] !== "tasks" || (parts.length !== 2 && (parts.length !== 3 || parts[2] !== "history")))
			throw notFound();
		const taskId = id.parse(parts[1]);
		const page = queryPage.parse(Object.fromEntries(url.searchParams));
		const limit = page.limit ?? 50;
		if (parts.length === 2) {
			const task = taskViewSchema.parse(await router.taskView({ keyId }, taskId, { ...page, limit }));
			const [owner] = await client.run(
				`select o.id,o.state,o.lease_expires_at,o.worker_instance_id from router_operations o
				join router_tasks t on t.tenant_id=o.tenant_id and t.id=o.task_id and t.key_id=$2
				where o.tenant_id=$1 and o.task_id=$3 and o.holds_task_occupancy`,
				tenantId,
				keyId,
				taskId,
			);
			const expired = owner?.lease_expires_at instanceof Date && owner.lease_expires_at.getTime() <= Date.now();
			const occupancy = owner
				? {
						operation_id: owner.id,
						status: expired
							? routerWorkerHasExited(String(owner.worker_instance_id))
								? "exit_verified"
								: "exit_unverified"
							: task.status === "canceled" || ["completed", "failed", "canceled"].includes(String(owner.state))
								? "pending"
								: "executing",
					}
				: null;
			const [duration] = await client.run(
				`select coalesce(round(sum(greatest(0,
					extract(epoch from (coalesce(o.ended_at, statement_timestamp()) - o.started_at)) * 1000))), 0)
					as execution_duration_ms
				from router_operations o
				join router_tasks t on t.tenant_id=o.tenant_id and t.id=o.task_id and t.key_id=$2
				where o.tenant_id=$1 and o.task_id=$3 and o.started_at is not null`,
				tenantId,
				keyId,
				taskId,
			);
			return { ...task, occupancy, execution_duration_ms: Number(duration.execution_duration_ms) };
		}
		if (
			!(
				await client.run(
					"select 1 from router_tasks where tenant_id=$1 and key_id=$2 and id=$3",
					tenantId,
					keyId,
					taskId,
				)
			).length
		)
			throw new OrchestrationError(404, "TASK_NOT_ACCESSIBLE", "Task 不存在或不可访问");
		const after = page.after ?? "0";
		if (BigInt(after) > 9_223_372_036_854_775_807n)
			throw new OrchestrationError(400, "INVALID_REQUEST", "分页游标无效");
		const rows = await client.run(
			`select e.sequence::text,e.operation_id,e.event_type as type,e.created_at,e.public_visible,
			case when e.event_type in ('user.message','assistant.message') then e.payload->>'text'
			     when e.event_type='operation.failed' then e.payload->'error'->>'code'
			     when e.event_type='operation.progress' then concat_ws(' · ', e.payload->>'stage',
			          case when e.payload ? 'tools_completed' then concat('tools: ', e.payload->>'tools_completed') end)
			     when e.event_type in ('tool.call','tool.result') then e.payload->>'tool_name' end as summary,
			case when e.event_type in ('assistant.message','tool.call','tool.result')
			     then coalesce(o.state='completed' and e.sequence<=o.context_committed_sequence,false) end as context_committed,
			case when e.event_type='tool.result' and e.payload->>'provider'='linux-bwrap'
			     then jsonb_build_object('provider',e.payload->>'provider','is_error',e.payload->'isError',
			          'output',left(e.payload#>>'{content,0,text}',8192)) end as local_result
			from router_task_events e join router_tasks t on t.tenant_id=e.tenant_id and t.id=e.task_id and t.key_id=$2
			left join router_operations o on o.tenant_id=e.tenant_id and o.task_id=e.task_id and o.id=e.operation_id
			where e.tenant_id=$1 and e.task_id=$3 and e.sequence>$4
			  and e.event_type <> 'sandbox.execution' order by e.sequence limit $5`,
			tenantId,
			keyId,
			taskId,
			after,
			limit + 1,
		);
		await auditRead("router_task", taskId, "router.history.read");
		return {
			events: rows.slice(0, limit).map(({ local_result, ...row }) => {
				if (!local_result) return row;
				const result = local_result as Record<string, unknown>;
				return { ...row, local_result: { ...result, output: sandboxTraceText(result.output) } };
			}),
			next_cursor: rows.length > limit ? rows[limit - 1].sequence : null,
		};
	}

	return {
		handle,
		listExecutions,
		sandboxEnvironment: () => inspectSandbox(options.sandboxConfig),
		sandboxStatistics,
	};
}
