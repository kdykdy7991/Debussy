-- Agent V2 Reasoning: conversation-level effort fact store (V2-README §4.3).
--
-- Dedicated per-conversation state (the "fact source"): `conversationId ->
-- effort / updatedAt / updatedBy`. It is NOT a `conversation_events` row and
-- does not advance the event sequence counter; session recovery and
-- `GET .../reasoning` read from here. `effort` is a stable product tier or
-- NULL (= revert to the Agent Revision default). `request_id` records which
-- authenticated request set it; the append-only audit log carries the
-- before/after for accountability.
--
-- The composite key (conversation_id, published_app_id) plus the FK to
-- principals keeps cross-app / cross-principal scope impossible to express.

CREATE TABLE conversation_reasoning_state (
    conversation_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    owner_principal_id uuid NOT NULL,
    effort text NULL,
    updated_by text NOT NULL,
    request_id uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, conversation_id),
    UNIQUE (conversation_id, published_app_id),
    FOREIGN KEY (conversation_id, published_app_id)
        REFERENCES conversations (id, published_app_id),
    FOREIGN KEY (owner_principal_id, published_app_id)
        REFERENCES principals (id, published_app_id),
    CHECK (effort IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max') OR effort IS NULL)
);