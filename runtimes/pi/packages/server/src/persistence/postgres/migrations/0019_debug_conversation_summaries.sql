-- Debussy compaction for the Debug plane (Phase-3).
--
-- Debug Conversations are physically separate from Production `conversations`
-- (no published app, no `conversation_summaries` FK), so their compacted
-- Working Context needs a store of its own. This table mirrors the Production
-- summary row shape (through_sequence / previous_summary_id / tokens_before /
-- body) but is scoped by debug_conversation_id and references the Debug
-- conversation directly. It is CONTEXT-ONLY: `body` carries the compressed
-- summary; never tool call/result transcripts.

CREATE TABLE debug_conversation_summaries (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    owner_principal_id uuid NOT NULL,
    debug_conversation_id uuid NOT NULL REFERENCES debug_conversations (id),
    through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
    model_id text NOT NULL,
    source_event_count integer NOT NULL DEFAULT 0,
    source_bytes bigint NOT NULL DEFAULT 0,
    body jsonb NOT NULL,
    previous_summary_id uuid NULL REFERENCES debug_conversation_summaries (id),
    tokens_before bigint NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (debug_conversation_id, through_sequence)
);

CREATE INDEX debug_conversation_summaries_resume_idx
    ON debug_conversation_summaries (debug_conversation_id, through_sequence DESC);