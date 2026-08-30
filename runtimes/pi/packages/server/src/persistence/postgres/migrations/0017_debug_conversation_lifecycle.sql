-- Debug Conversation Phase 2F: Lifecycle / TTL / GC.
--
-- Sliding TTL is a two-step process driven by `last_active_at`:
--   1) soft delete (expire): active -> deleted, stamp `deleted_at`
--   2) physical GC: rows that stayed deleted past the grace window are removed
--      (events + row), after the owning runtime and its attached
--      AttachmentStore / CitationStore resources have been cleaned up.
--
-- `deleted_at` is NULL for live rows and ONLY set by the expire step; it is
-- never written directly. It exists so physical GC can age deleted rows without
-- re-reading mutation history. `status` remains the single source of truth for
-- visibility (only 'active' is listed / resumed / appended to), so no new
-- status value is added.
ALTER TABLE debug_conversations
    ADD COLUMN deleted_at timestamptz NULL;

-- Expire scan: active conversations ordered by last activity, oldest first.
CREATE INDEX debug_conversations_expire_idx
    ON debug_conversations (tenant_id, owner_principal_id, last_active_at ASC)
    WHERE status = 'active';

-- Physical GC scan: soft-deleted conversations past their grace window.
CREATE INDEX debug_conversations_gc_idx
    ON debug_conversations (tenant_id, owner_principal_id, deleted_at ASC)
    WHERE status = 'deleted' AND deleted_at IS NOT NULL;