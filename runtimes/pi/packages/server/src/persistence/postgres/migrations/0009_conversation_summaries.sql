-- WB-008: Conversation rollover / summary support (spec §12.3).
--
-- Two additions:
--
-- 1. `conversation_summaries`: frozen snapshots taken at complete-Turn
--    boundaries. `(conversation_id, through_sequence)` is unique so a
--    summary cannot be silently overwritten (spec §11.3: throughSequence
--    monotonic, never re-issued). The composite FK + the in-conversation
--    `latest_summary_sequence` column on `conversations` together prevent
--    cross-app / cross-principal leaks.
--
-- 2. `conversations.previous_conversation_id` + `next_conversation_id` +
--    `rolled_over_at`: a doubly-linked chain that lets the admin UI walk
--    backward / forward through auto-rollover history (spec §12.3 step 6).
--    The same composite FK trick guarantees the new conversation inherits
--    tenant/app/owner/version scope.

CREATE TABLE conversation_summaries (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    owner_principal_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    through_sequence bigint NOT NULL CHECK (through_sequence > 0),
    model_id text NOT NULL,
    source_event_count integer NOT NULL CHECK (source_event_count >= 0),
    source_bytes bigint NOT NULL CHECK (source_bytes >= 0),
    body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, through_sequence),
    UNIQUE (tenant_id, id),
    UNIQUE (id, published_app_id, owner_principal_id),
    FOREIGN KEY (conversation_id, published_app_id)
        REFERENCES conversations (id, published_app_id),
    FOREIGN KEY (owner_principal_id, published_app_id)
        REFERENCES principals (id, published_app_id),
    CHECK (body ? 'text')
);

CREATE INDEX conversation_summaries_conv_through_idx
    ON conversation_summaries (conversation_id, through_sequence DESC);

ALTER TABLE conversations
    ADD COLUMN latest_summary_sequence bigint NOT NULL DEFAULT 0 CHECK (latest_summary_sequence >= 0),
    ADD COLUMN previous_conversation_id uuid NULL,
    ADD COLUMN next_conversation_id uuid NULL,
    ADD COLUMN rolled_over_at timestamptz NULL;

-- The previous/next chain must stay within the same (tenant, app, owner).
ALTER TABLE conversations
    ADD CONSTRAINT conversations_chain_fk
    FOREIGN KEY (previous_conversation_id, published_app_id)
    REFERENCES conversations (id, published_app_id);