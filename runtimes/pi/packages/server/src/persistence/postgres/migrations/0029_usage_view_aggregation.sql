-- Usage detail views scan every `turn/end` (not only rows with legacy
-- `payload.usage`) and every orchestration work item in a bounded UTC period.
-- 0010's partial index is too narrow for that predicate, so add scan indexes.
-- Read-only schema change: no column, no backfill, no historical data rewrite.

CREATE INDEX IF NOT EXISTS conversation_events_turn_end_idx
    ON conversation_events (tenant_id, created_at DESC)
    WHERE event_type = 'turn/end';

CREATE INDEX IF NOT EXISTS orchestration_usage_period_idx
    ON orchestration_work_items (tenant_id, created_at DESC);
