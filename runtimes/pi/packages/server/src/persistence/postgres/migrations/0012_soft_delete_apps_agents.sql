-- Keep historical versions/conversations while removing app and Agent subjects
-- from active control-plane and public lookups.
ALTER TABLE published_apps ADD COLUMN deleted_at timestamptz NULL;
ALTER TABLE agent_definitions ADD COLUMN deleted_at timestamptz NULL;

CREATE INDEX published_apps_active_tenant_idx
    ON published_apps (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX agent_definitions_active_tenant_idx
    ON agent_definitions (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
