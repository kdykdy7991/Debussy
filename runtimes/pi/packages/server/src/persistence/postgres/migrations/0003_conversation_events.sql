-- TASK-005: conversation events (append-only truth source for conversation
-- history, spec section 26.2). Sequence uniqueness is enforced per
-- conversation; the composite FK keeps events inside the same app as their
-- conversation.

CREATE TABLE conversation_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    conversation_id uuid NOT NULL,
    sequence bigint NOT NULL CHECK (sequence > 0),
    event_type text NOT NULL,
    event_schema_version integer NOT NULL DEFAULT 1,
    turn_id uuid NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, sequence),
    UNIQUE (conversation_id, id),
    FOREIGN KEY (conversation_id, published_app_id)
        REFERENCES conversations (id, published_app_id)
);

CREATE INDEX conversation_events_replay_idx
    ON conversation_events (conversation_id, sequence);
