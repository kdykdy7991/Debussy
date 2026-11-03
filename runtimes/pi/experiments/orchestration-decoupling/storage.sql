-- EXPERIMENT ONLY: applied after real migrations to a disposable schema.
-- Not a production migration: management, backfill and complete query coverage remain separate work.
CREATE TABLE prototype_configurations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 draft jsonb NOT NULL, UNIQUE(tenant_id,id)
);
CREATE TABLE prototype_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, configuration_id uuid NOT NULL,
 runtime_spec jsonb NOT NULL, runtime_spec_hash text NOT NULL,
 UNIQUE(tenant_id,id,configuration_id),
 FOREIGN KEY(tenant_id,configuration_id) REFERENCES prototype_configurations(tenant_id,id)
);
ALTER TABLE orchestration_integrations
 ALTER COLUMN published_app_id DROP NOT NULL,
 ALTER COLUMN published_app_version_id DROP NOT NULL,
 ADD COLUMN configuration_id uuid,
 ADD COLUMN orchestration_version_id uuid,
 ADD UNIQUE(tenant_id,id,configuration_id),
 ADD FOREIGN KEY(tenant_id,configuration_id) REFERENCES prototype_configurations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,orchestration_version_id,configuration_id)
 REFERENCES prototype_versions(tenant_id,id,configuration_id),
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
CREATE UNIQUE INDEX prototype_task_principal_uniq
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
 REFERENCES prototype_versions(tenant_id,id,configuration_id),
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
 ADD COLUMN execution_turn_id uuid,
 ADD FOREIGN KEY(tenant_id,integration_id,configuration_id)
 REFERENCES orchestration_integrations(tenant_id,id,configuration_id),
 ADD FOREIGN KEY(tenant_id,orchestration_version_id,configuration_id)
 REFERENCES prototype_versions(tenant_id,id,configuration_id),
 ADD FOREIGN KEY(tenant_id,conversation_id,integration_id,principal_id)
 REFERENCES conversations(tenant_id,id,integration_id,owner_principal_id),
 ADD CHECK((published_app_version_id IS NOT NULL AND configuration_id IS NULL AND orchestration_version_id IS NULL)
 OR (published_app_version_id IS NULL AND configuration_id IS NOT NULL AND orchestration_version_id IS NOT NULL
   AND request_contract IS NOT NULL AND request_contract IN ('input_v1','legacy_prompt') AND execution_turn_id IS NOT NULL));
