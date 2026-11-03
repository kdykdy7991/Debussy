CREATE TABLE orchestration_configuration_grants (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 name text NOT NULL,
 secret_hash text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1,
 permissions jsonb NOT NULL,
 editable_fields jsonb NOT NULL,
 allowed_origins jsonb NOT NULL,
 capability_version_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,integration_id,id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES orchestration_integrations(tenant_id,id),
 FOREIGN KEY (tenant_id,capability_version_id) REFERENCES published_app_versions(tenant_id,id)
);
CREATE TABLE orchestration_configuration_drafts (
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision > 0),
 base_version_id uuid NOT NULL,
 configuration jsonb NOT NULL,
 mcp_refs jsonb NOT NULL,
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,integration_id),
 FOREIGN KEY (tenant_id,integration_id) REFERENCES orchestration_integrations(tenant_id,id),
 FOREIGN KEY (tenant_id,base_version_id) REFERENCES published_app_versions(tenant_id,id),
 FOREIGN KEY (tenant_id,integration_id,updated_by) REFERENCES orchestration_configuration_grants(tenant_id,integration_id,id)
);
CREATE TABLE orchestration_configuration_sessions (
 secret_hash text PRIMARY KEY,
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 grant_revision integer NOT NULL,
 kind text NOT NULL CHECK (kind IN ('code','session')),
 origin text NOT NULL,
 expires_at timestamptz NOT NULL,
 FOREIGN KEY (tenant_id,integration_id,grant_id) REFERENCES orchestration_configuration_grants(tenant_id,integration_id,id)
);
CREATE INDEX orchestration_configuration_expiry ON orchestration_configuration_sessions(expires_at);
