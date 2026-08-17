-- WB-007: event-log bookkeeping. The conversation event log is the only
-- authoritative truth source for a conversation (spec §11.1) and must carry
-- running counters so dashboards / rollover / export can answer "how big is
-- this conversation" without scanning every event.
--
-- Three counters live on `conversations` and are advanced in the SAME
-- transaction that inserts the event row:
--
--   event_count  — total number of `conversation_events` rows for the
--                  conversation (every append).
--   event_bytes  — sum of `conversation_events.payload_bytes`. Counts UTF-8
--                  bytes of the persisted payload only; archived raw bytes
--                  (object-store artefacts) are referenced by `artifactId`
--                  and counted via `attachments` not here.
--   turn_count   — number of distinct non-null `turn_id` values. Turn
--                  identity is stable across assistant.* / tool.* / turn.*
--                  events for one user turn.
--
-- `payload_bytes` is denormalised onto the event row so the counter can be
-- advanced atomically without re-reading the payload.
--
-- A partial uniqueness check ensures the counter never advances past the
-- real row count without leaving a gap: a conversation can never have
-- more event rows than `event_count`, and `event_bytes` cannot be negative.
-- The actual transactional invariant lives in the repository (the migration
-- only adds the columns and the supporting index for cursor pagination on
-- `(conversation_id, sequence)` that already exists).
ALTER TABLE conversations
    ADD COLUMN event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    ADD COLUMN event_bytes bigint NOT NULL DEFAULT 0 CHECK (event_bytes >= 0),
    ADD COLUMN turn_count bigint NOT NULL DEFAULT 0 CHECK (turn_count >= 0);

ALTER TABLE conversation_events
    ADD COLUMN payload_bytes integer NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0);

CREATE INDEX conversation_events_turn_idx
    ON conversation_events (conversation_id, turn_id)
    WHERE turn_id IS NOT NULL;