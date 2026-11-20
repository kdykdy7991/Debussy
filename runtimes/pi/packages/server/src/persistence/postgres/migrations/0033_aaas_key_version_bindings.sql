-- Version bindings are tenant-scoped; existing Keys retain the default behavior.
ALTER TABLE aaas_api_keys ADD COLUMN orchestration_version_id uuid;
ALTER TABLE aaas_api_keys ADD FOREIGN KEY (tenant_id, orchestration_version_id)
 REFERENCES orchestration_versions(tenant_id, id);

-- Presence is significant: an explicitly registered empty array is distinct
-- from a version whose sensitive-parameter mappings have not been reviewed.
CREATE TABLE aaas_version_credential_bindings (
 tenant_id uuid NOT NULL,
 orchestration_version_id uuid NOT NULL,
 credential_bindings jsonb NOT NULL CHECK (jsonb_typeof(credential_bindings) = 'array'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, orchestration_version_id),
 FOREIGN KEY (tenant_id, orchestration_version_id) REFERENCES orchestration_versions(tenant_id, id)
);

INSERT INTO aaas_version_credential_bindings(tenant_id, orchestration_version_id, credential_bindings)
 SELECT tenant_id, orchestration_version_id, credential_bindings FROM aaas_platform_configuration;
