-- Debussy-owned compaction / Working Context management (Phase-3, spec §12.2v2).
--
-- Two nullable columns on `conversation_summaries` so summaries can be CHAINED
-- incrementally instead of re-scanning the whole conversation:
--
--   previous_summary_id uuid NULL REFERENCES conversation_summaries(id)
--       Every summary after the first records the summary it was built from.
--       Restore / the next compaction read only the head summary and the events
--       after its through_sequence, so a 1000-turn conversation never re-reads
--       sequences [0, prevThrough] when producing Summary vN -> vN+1.
--   tokens_before bigint NULL
--       The compacted token budget covered by `before` (the cumulative committed
--       history already collapsed by predecessors). Lets the context-budget
--       decision treat the head summary's own size as part of the running window.
--
-- Both are monotonic-aware: through_sequence stays unique per conversation and
-- strictly increasing down the chain, so the "last complete Turn boundary"
-- invariant is never broken by a chained write.

ALTER TABLE conversation_summaries
    ADD COLUMN previous_summary_id uuid NULL,
    ADD COLUMN tokens_before bigint NULL;

ALTER TABLE conversation_summaries
    ADD CONSTRAINT conversation_summaries_chain_fk
    FOREIGN KEY (previous_summary_id)
    REFERENCES conversation_summaries (id);