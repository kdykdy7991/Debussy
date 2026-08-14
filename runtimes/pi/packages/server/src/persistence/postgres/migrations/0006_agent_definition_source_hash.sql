-- TASK-011: agent definition revisions (spec section 33.3).
--
-- Two fixes to the TASK-004 agent_definitions schema that the control
-- service needs:
--
-- 1. source_hash: the import-current flow persists the canonicalised source
--    configuration's SHA-256 so re-importing can decide between "no change"
--    (same hash, no new revision) and "config drifted" (new hash,
--    revision + 1). Existing rows default to '' (legacy/unknown).
-- 2. Revision rows: `id` used to be the PRIMARY KEY, which allowed only ONE
--    row per agent. Spec 33.3 requires keeping every revision (never
--    overwrite old revisions), so the primary key becomes (id, revision)
--    and the UNIQUE(tenant_id, id) that would also block multiple rows is
--    dropped. The published_apps.agent_definition_id foreign key referenced
--    the single-row id and cannot survive a composite key, so it is removed;
--    cross-tenant agent ownership is enforced by the control service
--    (createPublishedApp resolves the agent within the tenant scope).

ALTER TABLE agent_definitions
    ADD COLUMN source_hash text NOT NULL DEFAULT '';

-- Drop the FK first: it depends on the single-column primary key below.
ALTER TABLE published_apps DROP CONSTRAINT published_apps_agent_definition_id_fkey;
ALTER TABLE agent_definitions DROP CONSTRAINT agent_definitions_pkey;
ALTER TABLE agent_definitions DROP CONSTRAINT agent_definitions_tenant_id_id_key;
ALTER TABLE agent_definitions DROP CONSTRAINT agent_definitions_id_revision_key;
ALTER TABLE agent_definitions
    ADD CONSTRAINT agent_definitions_pkey PRIMARY KEY (id, revision);

-- A rejected version carries no activatable RuntimeSpec: allow NULL so the
-- absence is explicit instead of an empty placeholder (spec 27.2). The hash
-- is NULL together with the spec (the CHECK is NULL-tolerant).
ALTER TABLE published_app_versions ALTER COLUMN runtime_spec DROP NOT NULL;
ALTER TABLE published_app_versions ALTER COLUMN runtime_spec_hash DROP NOT NULL;
