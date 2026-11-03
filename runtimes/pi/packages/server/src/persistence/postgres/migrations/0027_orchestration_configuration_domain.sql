-- Independent task configuration and explicit execution ownership; historical Chat rows are retained.
CREATE TABLE orchestration_configurations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL, enabled boolean NOT NULL DEFAULT true, draft jsonb NOT NULL, draft_revision integer NOT NULL DEFAULT 1 CHECK(draft_revision>0), UNIQUE(tenant_id,id)
);
CREATE TABLE orchestration_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, configuration_id uuid NOT NULL,
 snapshot jsonb NOT NULL, source_draft_revision integer NOT NULL CHECK(source_draft_revision>0), runtime_spec jsonb NOT NULL, runtime_spec_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,id,configuration_id),
 FOREIGN KEY(tenant_id,configuration_id) REFERENCES orchestration_configurations(tenant_id,id)
);
ALTER TABLE orchestration_integrations
 ALTER COLUMN published_app_id DROP NOT NULL,
 ALTER COLUMN published_app_version_id DROP NOT NULL,
 ADD COLUMN configuration_id uuid,
 ADD COLUMN orchestration_version_id uuid,
 ADD UNIQUE(tenant_id,id,configuration_id),
 ADD FOREIGN KEY(tenant_id,configuration_id) REFERENCES orchestration_configurations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,orchestration_version_id,configuration_id)
 REFERENCES orchestration_versions(tenant_id,id,configuration_id),
 ADD CHECK((published_app_id IS NOT NULL AND published_app_version_id IS NOT NULL
   AND configuration_id IS NULL AND orchestration_version_id IS NULL)
 OR (published_app_id IS NULL AND published_app_version_id IS NULL
   AND configuration_id IS NOT NULL AND orchestration_version_id IS NOT NULL));

ALTER TABLE principals ADD COLUMN integration_id uuid,
 ADD FOREIGN KEY(tenant_id,integration_id) REFERENCES orchestration_integrations(tenant_id,id),
 ADD UNIQUE(tenant_id,id,integration_id),
 ADD CHECK(integration_id IS NULL OR (published_app_id IS NULL AND principal_type='service'));
-- Preserve the existing tenant platform-service category; task service principals have their own key.
DROP INDEX principals_platform_service_uniq;
CREATE UNIQUE INDEX principals_platform_service_uniq
 ON principals(tenant_id,principal_type,subject_hash)
 WHERE published_app_id IS NULL AND integration_id IS NULL;
CREATE UNIQUE INDEX orchestration_task_principal_uniq
 ON principals(tenant_id,integration_id,principal_type,subject_hash) WHERE integration_id IS NOT NULL;

ALTER TABLE conversations
 ALTER COLUMN published_app_id DROP NOT NULL,
 ALTER COLUMN published_app_version_id DROP NOT NULL,
 ADD COLUMN source text NOT NULL DEFAULT 'chat',
 ADD COLUMN integration_id uuid,
 ADD COLUMN configuration_id uuid,
 ADD COLUMN orchestration_version_id uuid,
 ADD UNIQUE(tenant_id,id,integration_id,owner_principal_id),
 ADD FOREIGN KEY(tenant_id,integration_id,configuration_id)
 REFERENCES orchestration_integrations(tenant_id,id,configuration_id),
 ADD FOREIGN KEY(tenant_id,orchestration_version_id,configuration_id)
 REFERENCES orchestration_versions(tenant_id,id,configuration_id),
 ADD FOREIGN KEY(tenant_id,owner_principal_id,integration_id) REFERENCES principals(tenant_id,id,integration_id),
 ADD CHECK((source='chat' AND published_app_id IS NOT NULL AND published_app_version_id IS NOT NULL
   AND integration_id IS NULL AND configuration_id IS NULL AND orchestration_version_id IS NULL)
 OR (source='orchestration' AND published_app_id IS NULL AND published_app_version_id IS NULL
   AND integration_id IS NOT NULL AND configuration_id IS NOT NULL AND orchestration_version_id IS NOT NULL));

ALTER TABLE conversation_events
 ALTER COLUMN published_app_id DROP NOT NULL,
 ADD COLUMN source text NOT NULL DEFAULT 'chat',
 ADD COLUMN integration_id uuid,
 ADD COLUMN owner_principal_id uuid,
 ADD FOREIGN KEY(tenant_id,conversation_id,integration_id,owner_principal_id)
 REFERENCES conversations(tenant_id,id,integration_id,owner_principal_id),
 ADD CHECK((source='chat' AND published_app_id IS NOT NULL AND integration_id IS NULL AND owner_principal_id IS NULL)
 OR (source='orchestration' AND published_app_id IS NULL AND integration_id IS NOT NULL AND owner_principal_id IS NOT NULL));

ALTER TABLE conversation_summaries
 ALTER COLUMN published_app_id DROP NOT NULL,
 ADD COLUMN source text NOT NULL DEFAULT 'chat',
 ADD COLUMN integration_id uuid,
 ADD FOREIGN KEY(tenant_id,conversation_id,integration_id,owner_principal_id)
 REFERENCES conversations(tenant_id,id,integration_id,owner_principal_id),
 ADD CHECK((source='chat' AND published_app_id IS NOT NULL AND integration_id IS NULL)
 OR (source='orchestration' AND published_app_id IS NULL AND integration_id IS NOT NULL));

ALTER TABLE orchestration_work_items
 ALTER COLUMN published_app_version_id DROP NOT NULL,
 ADD COLUMN configuration_id uuid,
 ADD COLUMN orchestration_version_id uuid,
 ADD COLUMN request_contract text,
 ADD COLUMN request_hash_version integer NOT NULL DEFAULT 1,
 ADD COLUMN execution_integration_id uuid GENERATED ALWAYS AS
  (CASE WHEN orchestration_version_id IS NOT NULL THEN integration_id ELSE NULL END) STORED,
 ADD FOREIGN KEY(tenant_id,integration_id,configuration_id)
 REFERENCES orchestration_integrations(tenant_id,id,configuration_id),
 ADD FOREIGN KEY(tenant_id,orchestration_version_id,configuration_id)
 REFERENCES orchestration_versions(tenant_id,id,configuration_id),
 ADD FOREIGN KEY(tenant_id,conversation_id,execution_integration_id,principal_id)
 REFERENCES conversations(tenant_id,id,integration_id,owner_principal_id),
 ADD CHECK((published_app_version_id IS NOT NULL AND configuration_id IS NULL AND orchestration_version_id IS NULL)
 OR (published_app_version_id IS NULL AND configuration_id IS NOT NULL AND orchestration_version_id IS NOT NULL
   AND request_contract IS NOT NULL AND request_contract IN ('input_v1','legacy_prompt','orchestration_event')));

UPDATE orchestration_work_items SET request_contract=CASE
 WHEN task_prompt IS NOT NULL THEN 'legacy_prompt'
 WHEN origin='aaas' THEN 'legacy_input' ELSE 'orchestration_event' END;
ALTER TABLE orchestration_work_items ALTER COLUMN request_contract SET NOT NULL;
ALTER TABLE orchestration_events ADD COLUMN request_hash_version integer NOT NULL DEFAULT 1;

-- Versions are append-only facts, not pointers to a mutable draft.
CREATE FUNCTION reject_orchestration_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'orchestration versions are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER orchestration_version_immutable BEFORE UPDATE OR DELETE ON orchestration_versions
 FOR EACH ROW EXECUTE FUNCTION reject_orchestration_version_change();

-- Task chains cannot silently cross a tenant, Integration, owner or conversation.
ALTER TABLE conversations ADD CONSTRAINT orchestration_previous_context_fk
 FOREIGN KEY(tenant_id,previous_conversation_id,integration_id,owner_principal_id)
 REFERENCES conversations(tenant_id,id,integration_id,owner_principal_id);
ALTER TABLE conversation_summaries ADD UNIQUE(tenant_id,id,conversation_id);
ALTER TABLE conversation_summaries ADD CONSTRAINT orchestration_summary_chain_fk
 FOREIGN KEY(tenant_id,previous_summary_id,conversation_id)
 REFERENCES conversation_summaries(tenant_id,id,conversation_id);
CREATE INDEX orchestration_context_owner_idx ON conversations(tenant_id,integration_id,owner_principal_id,last_active_at DESC)
 WHERE source='orchestration' AND deleted_at IS NULL;

ALTER TABLE orchestration_versions ADD UNIQUE(tenant_id,configuration_id,source_draft_revision);
ALTER TABLE mcp_call_audits ADD COLUMN integration_id uuid,
 ADD COLUMN orchestration_version_id uuid,
 ADD FOREIGN KEY(tenant_id,integration_id) REFERENCES orchestration_integrations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,orchestration_version_id) REFERENCES orchestration_versions(tenant_id,id),
 ADD CHECK(orchestration_version_id IS NULL OR (integration_id IS NOT NULL AND published_app_version_id IS NULL));
