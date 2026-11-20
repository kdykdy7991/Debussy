/** Normalized provider counts stored under response_payload.usage (alias usage). */
export function routerTokenSql(field: "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"): string {
	return `case when usage->>'${field}' ~ '^[0-9]+$' then (usage->>'${field}')::numeric end`;
}

export const routerKnownCacheReadSql = `(usage->'cacheReadReported' = 'true'::jsonb or (${routerTokenSql("cacheRead")}) > 0)`;

/**
 * Correlated aggregate for the current Router Operation (alias o).
 * A positive legacy cacheRead is evidence of a hit. Zero requires the
 * provider-reported marker because older adapters also used it as a default.
 */
export const routerCallUsageSql = `
	with call_usage as (
		select response_payload->'usage' as usage
		from orchestration_llm_calls
		where tenant_id=o.tenant_id and router_operation_id=o.id
	), tokens as (
		select ${routerKnownCacheReadSql} as reported,
		       ${routerTokenSql("cacheRead")} as hit,
		       ${routerTokenSql("input")} as input,
		       ${routerTokenSql("cacheWrite")} as write
		from call_usage
	), classified as (
		select *, reported and hit is not null as known_hit,
		       input + hit + write as prompt
		from tokens
	)
	select count(*) as total_calls,
	       count(hit) filter (where known_hit) as reported_calls,
	       sum(hit) filter (where known_hit) as read_tokens,
	       count(prompt) filter (where known_hit) as cache_reported_calls,
	       sum(hit) filter (where known_hit and prompt is not null) as cache_hit_tokens,
	       sum(prompt) filter (where known_hit) as cache_prompt_tokens
	from classified
`;
