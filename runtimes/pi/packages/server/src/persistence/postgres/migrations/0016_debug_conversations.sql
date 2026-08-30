-- Debug Conversation Phase 1 (admin workbench).
--
-- Persistent, per-agent debug conversations that survive Agent revision
-- changes (revision is resolved per Turn, never stored on the conversation).
-- Physically independent from the Production `conversations` /
-- `conversation_events` pair: a Debug conversation is scoped by
-- (tenant, agent, owner) instead of (tenant, app, owner principal), has no
-- published version, a short-lived TTL-dominated lifecycle and full log-level
-- event capture. Production schema / FK / repository semantics are untouched.
--
-- `last_event_sequence` mirrors the Production atomic-sequence machine so a
-- Debug event append can bump it in the SAME transaction as the insert.

CREATE TABLE debug_conversations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    agent_id uuid NULL,
    owner_principal_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'deleted')),
    last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now()
);

-- Resume lookup: most recent active conversation for (owner, agent).
CREATE INDEX debug_conversations_resume_idx
    ON debug_conversations (tenant_id, agent_id, owner_principal_id, last_active_at DESC)
    WHERE status = 'active';

-- Append-only event stream, structurally aligned with `conversation_events`.
CREATE TABLE debug_conversation_events (
    id uuid PRIMARY KEY,
    debug_conversation_id uuid NOT NULL REFERENCES debug_conversations (id),
    sequence bigint NOT NULL CHECK (sequence > 0),
    event_type text NOT NULL,
    event_schema_version integer NOT NULL DEFAULT 1,
    turn_id uuid NULL,
    payload jsonb NOT NULL,
    payload_bytes bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (debug_conversation_id, sequence),
    UNIQUE (debug_conversation_id, id)
);

CREATE INDEX debug_conversation_events_replay_idx
    ON debug_conversation_events (debug_conversation_id, sequence);

CREATE INDEX debug_conversation_events_turn_idx
    ON debug_conversation_events (debug_conversation_id, turn_id)
    WHERE turn_id IS NOT NULL;