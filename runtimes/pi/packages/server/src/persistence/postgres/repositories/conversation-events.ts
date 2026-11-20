/**
 * Conversation event repository (spec section 26.3 / WB-007).
 *
 * `append` runs the sequence bump, the payload byte write and the event
 * insert in ONE transaction:
 * - sequence is allocated via `UPDATE ... RETURNING` (never read-then-increment)
 * - the conversation counter columns (`event_count`, `event_bytes`,
 *   `turn_count`) are advanced in the same statement
 * - if the insert fails the whole transaction rolls back, so a failed append
 *   can never leave a hole, an inflated counter, or advance `last_event_sequence`
 * Every read embeds the full ownership scope; a bare event-id lookup is
 * impossible.
 */
import {
	type AdminOrchestrationRunRow,
	type AdminOrchestrationUsage,
	type AdminOrchestrationUsageRow,
	type AdminUsageRunRow,
	type AdminUsageViewStats,
	buildUsageViewStats,
} from "@earendil-works/pi-protocol";
import {
	type AgentDefinitionId,
	type ConversationEventId,
	type ConversationId,
	newConversationEventId,
	type PublishedAppId,
	type TenantId,
	type TurnId,
	toPublicId,
} from "../../../publishing/domain/ids.ts";
import type {
	AdminConversationEventListParams,
	ConversationEventInput,
	ConversationEventListParams,
	ConversationEventRecord,
	ConversationEventRepository,
	OwnerScope,
	TenantScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient, SqlParameter } from "../client.ts";
import { executionOwnerColumn, executionOwnerId } from "./execution-owner.ts";
import { routerCallUsageSql } from "./router-call-usage.ts";
import { txRows } from "./tx.ts";

// The JSON value c is one normalized LLM call from a recorded Turn.
const cacheCallReportedSql = `(c->>'usageReported' is distinct from 'false'
	and (c->>'cacheRead')::bigint >= 0
	and (c->>'cacheReadReported' = 'true' or (c->>'cacheRead')::bigint > 0)
	and c->>'input' is not null and c->>'cacheWrite' is not null)`;

function rowToRecord(row: Record<string, unknown>): ConversationEventRecord {
	return {
		eventId: row.id as ConversationEventId,
		tenantId: row.tenant_id as TenantId,
		publishedAppId: row.published_app_id as PublishedAppId | null,
		conversationId: row.conversation_id as ConversationId,
		sequence: Number(row.sequence),
		eventType: String(row.event_type),
		eventSchemaVersion: Number(row.event_schema_version),
		turnId: (row.turn_id as TurnId | null) ?? null,
		payload: row.payload,
		payloadBytes: Number(row.payload_bytes ?? 0),
		createdAt: row.created_at as Date,
	};
}

export function computePayloadBytes(payload: unknown): number {
	// JSON round-trip keeps the exact wire shape; encoder handles escaping.
	const json = JSON.stringify(payload);
	return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

export function createConversationEventRepository(client: PostgresClient): ConversationEventRepository {
	return {
		async append(scope: OwnerScope, input: ConversationEventInput) {
			const eventId = newConversationEventId();
			const eventSchemaVersion = input.eventSchemaVersion ?? 1;
			const turnId = input.turnId ?? null;
			const payloadBytes = input.payloadBytes ?? computePayloadBytes(input.payload);
			return client.transaction(async (tx) => {
				// Advance the conversation counter in the SAME UPDATE that bumps
				// the sequence. The RETURNING clause lets us fail fast when the
				// conversation is missing / out of scope. `turn_count` is only
				// incremented when the row does not already record this turn
				// id (first event for the turn wins).
				const bumped = await txRows(
					tx,
					`update conversations
					 set last_event_sequence = last_event_sequence + 1,
					     event_count = event_count + 1,
					     event_bytes = event_bytes + $5,
					     turn_count = turn_count + case
					         when $6::uuid is null then 0
					         else (select case when exists (
					             select 1 from conversation_events ce
					             where ce.conversation_id = conversations.id
					               and ce.turn_id = $6::uuid
					         ) then 0 else 1 end)
					     end,
					     updated_at = now(),
					     last_active_at = now()
					 where id = $1 and tenant_id = $2 and ${executionOwnerColumn(scope)} = $3 and owner_principal_id = $4
					   and deleted_at is null
					 returning last_event_sequence`,
					input.conversationId,
					scope.tenantId,
					executionOwnerId(scope),
					scope.principalId,
					payloadBytes,
					turnId,
				);
				if (bumped.length !== 1) return undefined;
				const sequence = Number(bumped[0].last_event_sequence);
				await txRows(
					tx,
					`insert into conversation_events
					 (id, tenant_id, published_app_id, conversation_id, sequence, event_type,
					  event_schema_version, turn_id, payload, payload_bytes, created_at,source,integration_id,owner_principal_id)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(),$11,$12,$13)`,
					eventId,
					scope.tenantId,
					scope.publishedAppId,
					input.conversationId,
					sequence,
					input.eventType,
					eventSchemaVersion,
					turnId,
					input.payload as SqlParameter,
					payloadBytes,
					scope.integrationId ? "orchestration" : "chat",
					scope.integrationId ?? null,
					scope.integrationId ? scope.principalId : null,
				);
				return {
					eventId,
					tenantId: scope.tenantId,
					publishedAppId: scope.publishedAppId,
					conversationId: input.conversationId,
					sequence,
					eventType: input.eventType,
					eventSchemaVersion,
					turnId,
					payload: input.payload,
					payloadBytes,
					createdAt: new Date(),
				};
			});
		},
		async list(scope: OwnerScope, conversationId: ConversationId, params: ConversationEventListParams) {
			const limit = Math.min(Math.max(params.limit, 1), 500);
			// The events table has no owner column, so the conversation's
			// ownership is enforced via a join: out-of-scope callers see an
			// empty page, indistinguishable from a conversation with no events.
			const rows = await client.run(
				`select e.* from conversation_events e
				 join conversations c on c.id = e.conversation_id and c.published_app_id is not distinct from e.published_app_id and c.integration_id is not distinct from e.integration_id and c.tenant_id=e.tenant_id
				 where e.conversation_id = $1 and e.tenant_id = $2 and e.${executionOwnerColumn(scope)} = $3
				   and c.owner_principal_id = $4 and c.deleted_at is null
				   and e.sequence > $5
				 order by e.sequence asc
				 limit $6`,
				conversationId,
				scope.tenantId,
				executionOwnerId(scope),
				scope.principalId,
				params.afterSequence ?? 0,
				limit,
			);
			return rows.map((row) => rowToRecord(row));
		},
		async listByConversation(params: AdminConversationEventListParams) {
			const limit = Math.min(Math.max(params.limit, 1), 500);
			// Tenant-scoped admin variant of `list`: a conversationId is
			// globally unique, so tenant + conversation is sufficient scope —
			// cross-owner (any principal in the tenant) is allowed,
			// cross-tenant is not. Empty page = indistinguishable from no
			// events (uniform 404).
			const rows = await client.run(
				`select e.* from conversation_events e
				 join conversations c on c.id = e.conversation_id and c.published_app_id is not distinct from e.published_app_id and c.integration_id is not distinct from e.integration_id and c.tenant_id=e.tenant_id
				 where e.conversation_id = $1 and e.tenant_id = $2
				   and c.deleted_at is null
				   and e.sequence > $3
				 order by e.sequence asc
				 limit $4`,
				params.conversationId,
				params.scope.tenantId,
				params.afterSequence ?? 0,
				limit,
			);
			return rows.map((row) => rowToRecord(row));
		},
		async countErrors(scope: TenantScope) {
			const rows = await client.run(
				`select count(*)::int as cnt from conversation_events
				 where tenant_id = $1 and event_type in ('turn.failed', 'tool.error')`,
				scope.tenantId,
			);
			return Number(rows[0]?.cnt ?? 0);
		},
		async summarizeUsage(input) {
			const rows = await client.run(
				`select pa.agent_definition_id,
				        coalesce(ad.name, pa.name) as agent_name,
				        coalesce(sum((e.payload->'usage'->>'input')::bigint), 0)::bigint as input_tokens,
				        coalesce(sum((e.payload->'usage'->>'output')::bigint), 0)::bigint as output_tokens,
				        coalesce(sum((e.payload->'usage'->>'cacheRead')::bigint), 0)::bigint as cache_read_tokens,
				        coalesce(sum((e.payload->'usage'->>'cacheWrite')::bigint), 0)::bigint as cache_write_tokens,
				        coalesce(sum((e.payload->'usage'->>'totalTokens')::bigint), 0)::bigint as total_tokens,
				        count(*)::bigint as request_count
				 from conversation_events e
				 join conversations c
				   on c.id = e.conversation_id and c.published_app_id is not distinct from e.published_app_id and c.integration_id is not distinct from e.integration_id and c.tenant_id=e.tenant_id
				 join published_app_versions pav on pav.id = c.published_app_version_id
				 join published_apps pa on pa.id = c.published_app_id
				 left join agent_definitions ad
				   on ad.id = pa.agent_definition_id and ad.revision = pav.source_agent_revision
				 where e.tenant_id = $1
				   and e.event_type = 'turn/end'
				   and e.created_at >= $2 and e.created_at < $3
				   and jsonb_typeof(e.payload->'usage') = 'object'
				   and e.source is distinct from 'orchestration'
				   and not exists (
				     select 1 from orchestration_work_items w
				     where w.tenant_id = e.tenant_id and w.conversation_id = e.conversation_id
				   )
				 group by pa.agent_definition_id, coalesce(ad.name, pa.name)
				 order by total_tokens desc, agent_name asc`,
				input.scope.tenantId,
				input.from,
				input.to,
			);
			return rows.map((row) => ({
				agentDefinitionId: row.agent_definition_id as AgentDefinitionId,
				agentName: String(row.agent_name),
				source: "embed" as const,
				inputTokens: Number(row.input_tokens ?? 0),
				outputTokens: Number(row.output_tokens ?? 0),
				cacheReadTokens: Number(row.cache_read_tokens ?? 0),
				cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
				totalTokens: Number(row.total_tokens ?? 0),
				requestCount: Number(row.request_count ?? 0),
			}));
		},
		/**
		 * AaaS Run facts + provider usage. Chat rows are excluded by the WorkItem
		 * relationship; tokens are only summed for runs whose every LLM call has
		 * a persisted llmUsage. Never estimates from message length or tool count.
		 */
		async summarizeOrchestrationUsage(input): Promise<AdminOrchestrationUsage> {
			const rows = await client.run(
				`select w.id as run_id, w.integration_id,
				        case when w.key_id is not null then 'aaas_key:' || coalesce(k.name, w.key_id::text)
				             else coalesce(i.name, 'Integration') end as integration_name,
				        case when w.key_id is not null then 'aaas_key' else 'legacy' end as run_source,
				        w.state, w.created_at, w.conversation_id,
				        case when w.orchestration_version_id is not null
				                  then 'orv_' || w.orchestration_version_id::text
				             when w.published_app_version_id is not null
				                  then 'pav_' || w.published_app_version_id::text end as frozen_version,
				        s.payload->>'model' as model,
				        u.turn_count, u.complete, u.total_tokens, u.input_tokens, u.output_tokens,
				        u.cache_read_tokens, u.cache_write_tokens, u.llm_calls, u.legacy_tokens,
				        cc.cache_hit_tokens, cc.cache_prompt_tokens,
				        cc.cache_reported_calls, cc.cache_unknown_calls,
				        a.started_at, a.ended_at
				 from orchestration_work_items w
				 join orchestration_integrations i on i.id=w.integration_id and i.tenant_id=w.tenant_id
				 left join aaas_api_keys k on k.id=w.key_id and k.tenant_id=w.tenant_id
				 left join lateral (
				   select payload from conversation_events e
				   where e.tenant_id=w.tenant_id and e.conversation_id=w.conversation_id
				     and e.event_type='turn/start' order by e.sequence asc limit 1
				 ) s on true
				 left join lateral (
				   select count(*)::bigint as turn_count,
				          bool_and(e.event_type='turn/end'
				            and e.payload->'llmUsage' is not null
				            and e.payload->'llmUsage'->>'partial'='false') as complete,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'totalTokens')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as total_tokens,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'input')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as input_tokens,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'output')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as output_tokens,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'cacheRead')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as cache_read_tokens,
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'cacheWrite')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as cache_write_tokens,
				          coalesce(sum((e.payload->'llmUsage'->>'callCount')::bigint)
				            filter (where e.payload->'llmUsage'->>'partial'='false'),0)::bigint as llm_calls,
				          coalesce(sum((e.payload->'usage'->>'totalTokens')::bigint)
				            filter (where e.payload->'llmUsage' is null
				              or e.payload->'llmUsage'->>'partial'='true'),0)::bigint as legacy_tokens,
				          -- Confirmed consumption from EVERY terminal event that has
				          -- llmUsage (complete, partial or cancelled). Kept separate
				          -- from the complete flag so an incomplete Run still surfaces the
				          -- tokens the provider actually reported.
				          coalesce(sum((e.payload->'llmUsage'->'total'->>'totalTokens')::bigint),0)::bigint as confirmed_tokens
				   from conversation_events e
				   where e.tenant_id=w.tenant_id and e.conversation_id=w.conversation_id
				     and e.event_type in ('turn/end','turn/interrupted')
				     and (jsonb_typeof(e.payload->'usage')='object'
				       or jsonb_typeof(e.payload->'llmUsage')='object')
				 ) u on true
				 left join lateral (
				   -- Cache data is aggregated PER CALL: only calls that explicitly
				   -- reported prompt-cache read tokens contribute to the hit and
				   -- the prompt denominator. Unmarked zero values are unknown,
				   -- never a miss, so they are counted separately and excluded.
				   select coalesce(sum(coalesce((c->>'cacheRead')::bigint,0))
				            filter (where ${cacheCallReportedSql}),0)::bigint as cache_hit_tokens,
				          coalesce(sum((coalesce((c->>'input')::bigint,0)
				                      +coalesce((c->>'cacheRead')::bigint,0)
				                      +coalesce((c->>'cacheWrite')::bigint,0)))
				            filter (where ${cacheCallReportedSql}),0)::bigint as cache_prompt_tokens,
				          count(*) filter (where ${cacheCallReportedSql})::bigint as cache_reported_calls,
				          count(*) filter (where not coalesce(${cacheCallReportedSql},false))::bigint as cache_unknown_calls
				   from conversation_events e2
				   cross join lateral jsonb_array_elements(
				     case when jsonb_typeof(e2.payload->'llmUsage'->'calls') = 'array'
				          then e2.payload->'llmUsage'->'calls' else '[]'::jsonb end) as c
				   where e2.tenant_id=w.tenant_id and e2.conversation_id=w.conversation_id
				     and e2.event_type='turn/end'
				 ) cc on true
				 left join lateral (
				   select started_at, ended_at from orchestration_assignments x
				   where x.tenant_id=w.tenant_id and x.work_item_id=w.id and x.started_at is not null
				   order by x.created_at asc limit 1
				 ) a on true
				 where w.tenant_id=$1 and w.created_at >= $2 and w.created_at < $3
				 order by w.created_at desc, w.id desc`,
				input.scope.tenantId,
				input.from,
				input.to,
			);
			const numberOrZero = (value: unknown): number => {
				const parsed = Number(value ?? 0);
				return Number.isFinite(parsed) ? parsed : 0;
			};
			const durationMs = (started: unknown, ended: unknown): number | null => {
				if (started === null || started === undefined || ended === null || ended === undefined) return null;
				const from = new Date(String(started)).getTime();
				const to = new Date(String(ended)).getTime();
				return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
			};
			interface Group {
				readonly integrationId: string;
				readonly name: string;
				readonly source: "legacy" | "aaas_key";
				readonly states: Record<string, number>;
				readonly durations: number[];
				tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
				llmCallCount: number;
				completeRuns: number;
				partialRuns: number;
				noUsageRuns: number;
				partialTokens: number;
				readonly models: Set<string>;
				readonly versions: Set<string>;
			}
			const groups = new Map<string, Group>();
			const recentRuns: AdminOrchestrationRunRow[] = [];
			const viewRuns: AdminUsageRunRow[] = [];
			for (const row of rows) {
				const integrationId = String(row.integration_id);
				const turnCount = numberOrZero(row.turn_count);
				const complete = turnCount > 0 && row.complete === true;
				const coverage: AdminOrchestrationRunRow["tokenCoverage"] =
					turnCount === 0 ? "none" : complete ? "complete" : "partial";
				const model = row.model === null || row.model === undefined ? null : String(row.model);
				const versionId =
					row.frozen_version === null || row.frozen_version === undefined ? null : String(row.frozen_version);
				const elapsed = durationMs(row.started_at, row.ended_at);
				let group = groups.get(integrationId);
				if (group === undefined) {
					group = {
						integrationId,
						name: String(row.integration_name),
						source: row.run_source === "aaas_key" ? "aaas_key" : "legacy",
						states: { succeeded: 0, failed: 0, cancelled: 0, queued: 0, running: 0 },
						durations: [],
						tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						llmCallCount: 0,
						completeRuns: 0,
						partialRuns: 0,
						noUsageRuns: 0,
						partialTokens: 0,
						models: new Set<string>(),
						versions: new Set<string>(),
					};
					groups.set(integrationId, group);
				}
				const state = String(row.state);
				if (state in group.states) group.states[state] = (group.states[state] ?? 0) + 1;
				if (elapsed !== null) group.durations.push(elapsed);
				if (model !== null) group.models.add(model);
				if (versionId !== null) group.versions.add(versionId);
				if (complete) {
					group.completeRuns += 1;
					group.tokens.input += numberOrZero(row.input_tokens);
					group.tokens.output += numberOrZero(row.output_tokens);
					group.tokens.cacheRead += numberOrZero(row.cache_read_tokens);
					group.tokens.cacheWrite += numberOrZero(row.cache_write_tokens);
					group.tokens.total += numberOrZero(row.total_tokens);
					group.llmCallCount += numberOrZero(row.llm_calls);
				} else if (turnCount > 0) {
					group.partialRuns += 1;
					// Prefer confirmed per-call tokens over the legacy last-call figure;
					// never add both (they are two calibers of the same Turn).
					group.partialTokens +=
						numberOrZero(row.confirmed_tokens) > 0
							? numberOrZero(row.confirmed_tokens)
							: numberOrZero(row.legacy_tokens);
				} else {
					group.noUsageRuns += 1;
				}
				const createdAt = new Date(String(row.created_at)).toISOString();
				const accurateTokens = complete ? numberOrZero(row.total_tokens) : null;
				const accurateLlmCallCount = complete ? numberOrZero(row.llm_calls) : null;
				// Cache coverage is per call: only calls that explicitly reported
				// prompt-cache read tokens contribute. A row without a single
				// reported call keeps every cache field unknown (never zero).
				const cacheReportedCalls = numberOrZero(row.cache_reported_calls);
				const cacheUnknownCalls = numberOrZero(row.cache_unknown_calls);
				const cacheReported = complete && cacheReportedCalls > 0;
				const cacheHitTokens = numberOrZero(row.cache_hit_tokens);
				const cachePromptTokens = numberOrZero(row.cache_prompt_tokens);
				viewRuns.push({
					id: String(row.run_id),
					source: group.source === "aaas_key" ? "aaas_key" : "integration",
					groupId: integrationId,
					groupName: String(row.integration_name),
					state,
					createdAt,
					model,
					versionId,
					tokenCoverage: coverage,
					accurateTokens,
					partialTokens:
						coverage === "partial"
							? numberOrZero(row.confirmed_tokens) > 0
								? numberOrZero(row.confirmed_tokens)
								: numberOrZero(row.legacy_tokens)
							: 0,
					accurateLlmCallCount,
					cacheHitTokens: cacheReported ? cacheHitTokens : null,
					cacheMissTokens: cacheReported ? cachePromptTokens - cacheHitTokens : null,
					cachePromptTokens: cacheReported ? cachePromptTokens : null,
					cacheHitRate: cacheReported && cachePromptTokens > 0 ? cacheHitTokens / cachePromptTokens : null,
					cacheReportedCalls,
					cacheUnknownCalls,
					durationMs: elapsed,
					conversationId: toPublicId("ConversationId", String(row.conversation_id) as ConversationId),
				});
				if (recentRuns.length < 50) {
					recentRuns.push({
						runId: String(row.run_id),
						integrationId,
						state,
						createdAt,
						model,
						versionId,
						tokenCoverage: coverage,
						totalTokens: accurateTokens ?? 0,
						llmCallCount: accurateLlmCallCount ?? 0,
						durationMs: elapsed,
					});
				}
			}
			const byIntegration: AdminOrchestrationUsageRow[] = [...groups.values()]
				.map((group) => ({
					integrationId: group.integrationId,
					integrationName: group.name,
					source: group.source,
					runCount: Object.values(group.states).reduce((sum, value) => sum + value, 0),
					succeeded: group.states.succeeded ?? 0,
					failed: group.states.failed ?? 0,
					cancelled: group.states.cancelled ?? 0,
					queued: group.states.queued ?? 0,
					running: group.states.running ?? 0,
					avgDurationMs: group.durations.length
						? Math.round(group.durations.reduce((sum, value) => sum + value, 0) / group.durations.length)
						: 0,
					maxDurationMs: group.durations.length ? Math.max(...group.durations) : 0,
					tokens: {
						inputTokens: group.tokens.input,
						outputTokens: group.tokens.output,
						cacheReadTokens: group.tokens.cacheRead,
						cacheWriteTokens: group.tokens.cacheWrite,
						totalTokens: group.tokens.total,
					},
					llmCallCount: group.llmCallCount,
					completeRuns: group.completeRuns,
					partialRuns: group.partialRuns,
					noUsageRuns: group.noUsageRuns,
					partialTokens: group.partialTokens,
					models: [...group.models].sort(),
					versionIds: [...group.versions].sort(),
				}))
				.sort((a, b) => b.runCount - a.runCount || a.integrationName.localeCompare(b.integrationName));
			const totals = byIntegration.reduce(
				(acc, row) => ({
					completeRuns: acc.completeRuns + row.completeRuns,
					partialRuns: acc.partialRuns + row.partialRuns,
					noUsageRuns: acc.noUsageRuns + row.noUsageRuns,
					completeTokens: acc.completeTokens + row.tokens.totalTokens,
					partialTokens: acc.partialTokens + row.partialTokens,
				}),
				{ completeRuns: 0, partialRuns: 0, noUsageRuns: 0, completeTokens: 0, partialTokens: 0 },
			);
			return {
				byIntegration,
				recentRuns,
				coverage: {
					...totals,
					note: "准确总量只统计 turn/end 中带完整 llmUsage 的 Run；不完整或取消 Turn 的已确认用量单列为部分用量（partialTokens），不混入准确总量。历史仅保存最后一次调用 usage 的 Run 同样计入部分用量。Integration 与 AaaS Key Run 共用这一种口径，且每个 Work Item 只计一次。",
				},
				view: buildUsageViewStats({
					runs: viewRuns,
					from: input.from.toISOString(),
					to: input.to.toISOString(),
				}),
			};
		},
		/**
		 * Chat Agent view: one row per non-orchestration `turn/end`. Complete rows
		 * take `llmUsage.total`; legacy single-call `usage` stays in `partialTokens`
		 * and is never presented as an accurate total. Uses the same exclusion
		 * predicates as `summarizeUsage`, so the two views never mix calibers.
		 */
		async summarizeChatUsageView(input): Promise<AdminUsageViewStats> {
			const rows = await client.run(
				`select e.id as event_id, e.turn_id, e.conversation_id, e.created_at,
				        e.event_type as terminal_event,
				        pa.agent_definition_id as group_id,
				        coalesce(ad.name, pa.name) as group_name,
				        s.payload->>'model' as model,
				        jsonb_typeof(e.payload->'llmUsage') as llm_usage_kind,
				        e.payload->'llmUsage'->>'partial' as llm_partial,
				        (e.payload->'llmUsage'->'total'->>'totalTokens')::bigint as accurate_tokens,
				        (e.payload->'llmUsage'->>'callCount')::bigint as llm_calls,
				        cc.cache_hit_tokens, cc.cache_prompt_tokens,
				        cc.cache_reported_calls, cc.cache_unknown_calls,
				        (e.payload->'usage'->>'totalTokens')::bigint as legacy_tokens
				 from conversation_events e
				 join conversations c
				   on c.id = e.conversation_id and c.published_app_id is not distinct from e.published_app_id and c.integration_id is not distinct from e.integration_id and c.tenant_id=e.tenant_id
				 join published_app_versions pav on pav.id = c.published_app_version_id
				 join published_apps pa on pa.id = c.published_app_id
				 left join agent_definitions ad
				   on ad.id = pa.agent_definition_id and ad.revision = pav.source_agent_revision
				 left join lateral (
				   select payload from conversation_events x
				   where x.tenant_id=e.tenant_id and x.conversation_id=e.conversation_id
				     and x.turn_id is not distinct from e.turn_id and x.event_type='turn/start'
				   order by x.sequence asc limit 1
				 ) s on true
				 left join lateral (
				   -- Cache data is aggregated PER CALL: only calls that explicitly
				   -- reported prompt-cache read tokens contribute to the hit and to
				   -- the prompt denominator. Unmarked zero values are unknown, never
				   -- a miss: they are counted separately and excluded from both.
				   select coalesce(sum(coalesce((c->>'cacheRead')::bigint,0))
				            filter (where ${cacheCallReportedSql}),0)::bigint as cache_hit_tokens,
				          coalesce(sum((coalesce((c->>'input')::bigint,0)
				                      +coalesce((c->>'cacheRead')::bigint,0)
				                      +coalesce((c->>'cacheWrite')::bigint,0)))
				            filter (where ${cacheCallReportedSql}),0)::bigint as cache_prompt_tokens,
				          count(*) filter (where ${cacheCallReportedSql})::bigint as cache_reported_calls,
				          count(*) filter (where not coalesce(${cacheCallReportedSql},false))::bigint as cache_unknown_calls
				   from jsonb_array_elements(
				     case when jsonb_typeof(e.payload->'llmUsage'->'calls') = 'array'
				          then e.payload->'llmUsage'->'calls' else '[]'::jsonb end) as c
				 ) cc on true
				 where e.tenant_id = $1
				   and e.event_type in ('turn/end', 'turn/interrupted')
				   and e.created_at >= $2 and e.created_at < $3
				   and e.source is distinct from 'orchestration'
				   and not exists (
				     select 1 from orchestration_work_items w
				     where w.tenant_id = e.tenant_id and w.conversation_id = e.conversation_id
				   )
				 order by e.created_at desc, e.id desc`,
				input.scope.tenantId,
				input.from,
				input.to,
			);
			const numberOrZero = (value: unknown): number => {
				const parsed = Number(value ?? 0);
				return Number.isFinite(parsed) ? parsed : 0;
			};
			const runs: AdminUsageRunRow[] = rows.map((row) => {
				// A cancelled Turn (turn/interrupted) can carry confirmed llmUsage, but
				// it is never a complete Turn: keep tokenCoverage partial and surface
				// its confirmed tokens in partialTokens, not accurateTokens.
				const isInterrupted = row.terminal_event === "turn/interrupted";
				const complete =
					!isInterrupted && row.llm_usage_kind === "object" && row.llm_partial === "false";
				// Cache coverage is per call: only calls that explicitly reported
				// prompt-cache read tokens contribute. A turn without a single
				// reported call keeps every cache field unknown (never zero).
				const cacheReportedCalls = numberOrZero(row.cache_reported_calls);
				const cacheUnknownCalls = numberOrZero(row.cache_unknown_calls);
				const cacheReported = complete && cacheReportedCalls > 0;
				const cacheHitTokens = numberOrZero(row.cache_hit_tokens);
				const cachePromptTokens = numberOrZero(row.cache_prompt_tokens);
				const hasLegacyUsage = row.legacy_tokens !== null && row.legacy_tokens !== undefined;
				const hasConfirmedLlmUsage = row.llm_usage_kind === "object";
				const coverage: AdminUsageRunRow["tokenCoverage"] = complete
					? "complete"
					: hasLegacyUsage || hasConfirmedLlmUsage
						? "partial"
						: "none";
				return {
					id: String(row.turn_id ?? row.event_id),
					source: "chat",
					groupId: String(row.group_id),
					groupName: String(row.group_name),
					state: isInterrupted ? "cancelled" : null,
					createdAt: new Date(String(row.created_at)).toISOString(),
					model:
						row.model === null || row.model === undefined || String(row.model) === "" ? null : String(row.model),
					versionId: null,
					tokenCoverage: coverage,
					accurateTokens: complete ? numberOrZero(row.accurate_tokens) : null,
					// For incomplete rows prefer confirmed per-call tokens; the legacy
					// last-call figure remains the fallback for historical data only.
					partialTokens: complete
						? 0
						: hasConfirmedLlmUsage
							? numberOrZero(row.accurate_tokens)
							: numberOrZero(row.legacy_tokens),
					accurateLlmCallCount: complete ? numberOrZero(row.llm_calls) : null,
					cacheHitTokens: cacheReported ? cacheHitTokens : null,
					cacheMissTokens: cacheReported ? cachePromptTokens - cacheHitTokens : null,
					cachePromptTokens: cacheReported ? cachePromptTokens : null,
					cacheHitRate: cacheReported && cachePromptTokens > 0 ? cacheHitTokens / cachePromptTokens : null,
					cacheReportedCalls,
					cacheUnknownCalls,
					durationMs: null,
					conversationId: toPublicId("ConversationId", String(row.conversation_id) as ConversationId),
				};
			});
			return buildUsageViewStats({
				runs,
				from: input.from.toISOString(),
				to: input.to.toISOString(),
			});
		},
		async summarizeRouterUsageView(input) {
			const [schema] = await client.run("select to_regclass('router_operations') is not null as available");
			if (schema?.available !== true) return undefined;
			const rows = await client.run(
				`select o.id,o.task_id,o.state,o.created_at,o.usage_complete,
				        (o.usage->>'total_tokens')::bigint as total_tokens,
				        o.capability_snapshot->'model'->>'modelId' as model,
				        extract(epoch from (o.ended_at-o.started_at))*1000 as duration_ms,
				        t.key_id,k.name as key_name,cache.total_calls,cache.cache_reported_calls,
				        cache.cache_hit_tokens,cache.cache_prompt_tokens
				 from router_operations o
				 join router_tasks t on t.tenant_id=o.tenant_id and t.id=o.task_id
				 join aaas_api_keys k on k.tenant_id=t.tenant_id and k.id=t.key_id
				 cross join lateral (${routerCallUsageSql}) cache
				 where o.tenant_id=$1 and o.created_at >= $2 and o.created_at < $3
				 order by o.created_at desc,o.id desc`,
				input.scope.tenantId,
				input.from,
				input.to,
			);
			const runs: AdminUsageRunRow[] = rows.map((row) => {
				const total = row.total_tokens == null ? null : Number(row.total_tokens);
				const complete = total !== null && row.usage_complete === true;
				const cacheReportedCalls = Number(row.cache_reported_calls ?? 0);
				const cacheReported = complete && cacheReportedCalls > 0;
				const cacheHitTokens = Number(row.cache_hit_tokens ?? 0);
				const cachePromptTokens = Number(row.cache_prompt_tokens ?? 0);
				return {
					id: String(row.id),
					source: "router",
					routerTaskId: String(row.task_id),
					routerKeyId: String(row.key_id),
					groupId: String(row.key_id),
					groupName: String(row.key_name),
					state: String(row.state),
					createdAt: new Date(String(row.created_at)).toISOString(),
					model: row.model == null ? null : String(row.model),
					versionId: null,
					tokenCoverage: complete ? "complete" : total === null ? "none" : "partial",
					accurateTokens: complete ? total : null,
					partialTokens: !complete && total !== null ? total : 0,
					accurateLlmCallCount: complete && Number(row.total_calls) > 0 ? Number(row.total_calls) : null,
					cacheHitTokens: cacheReported ? cacheHitTokens : null,
					cacheMissTokens: cacheReported ? cachePromptTokens - cacheHitTokens : null,
					cachePromptTokens: cacheReported ? cachePromptTokens : null,
					cacheHitRate: cacheReported && cachePromptTokens > 0 ? cacheHitTokens / cachePromptTokens : null,
					cacheReportedCalls,
					cacheUnknownCalls: Number(row.total_calls ?? 0) - cacheReportedCalls,
					durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
					conversationId: null,
				};
			});
			return buildUsageViewStats({
				runs,
				from: input.from.toISOString(),
				to: input.to.toISOString(),
			});
		},
	};
}
