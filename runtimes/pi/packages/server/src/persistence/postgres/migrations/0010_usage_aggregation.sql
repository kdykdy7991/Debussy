-- UI-004: bounded tenant/time scan for provider-reported usage events.
-- Token values remain inside the append-only turn/end payload; this index
-- accelerates aggregation without creating a second source of truth.

CREATE INDEX conversation_events_usage_idx
    ON conversation_events (tenant_id, created_at DESC)
    WHERE event_type = 'turn/end' AND jsonb_typeof(payload->'usage') = 'object';
