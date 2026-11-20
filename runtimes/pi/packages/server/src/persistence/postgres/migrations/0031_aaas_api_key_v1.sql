-- AaaS 通用任务接口 V1: independent API Key identity, one internal carrier per key,
-- key-scoped MCP authorisation, independent idempotency and per-Run capability snapshots.
-- Additive and backward compatible: existing integrations keep kind='legacy',
-- existing work items keep key_id=NULL, and no historical row is backfilled.

CREATE TABLE aaas_api_keys (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
 secret_hash text NOT NULL CHECK (char_length(secret_hash) = 64),
 status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id)
);

-- One logical Key owns exactly one non-login Integration carrier, and vice versa.
CREATE TABLE aaas_key_carriers (
 tenant_id uuid NOT NULL,
 key_id uuid NOT NULL,
 carrier_integration_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,key_id),
 UNIQUE (tenant_id,carrier_integration_id),
 UNIQUE (tenant_id,key_id,carrier_integration_id),
 FOREIGN KEY (tenant_id,key_id) REFERENCES aaas_api_keys(tenant_id,id),
 FOREIGN KEY (tenant_id,carrier_integration_id) REFERENCES orchestration_integrations(tenant_id,id)
);

-- Simple Key -> MCP Server grant, empty by default; no roles, inheritance or policy engine.
CREATE TABLE aaas_key_mcp_grants (
 tenant_id uuid NOT NULL,
 key_id uuid NOT NULL,
 mcp_server_id text NOT NULL CHECK (mcp_server_id ~ '^mcp_[0-9a-f-]{36}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,key_id,mcp_server_id),
 FOREIGN KEY (tenant_id,key_id) REFERENCES aaas_api_keys(tenant_id,id)
);

-- Platform-owned execution configuration referenced by every Key carrier.
-- The administrator prepares this through the existing orchestration admin surface;
-- key creation and acceptance refuse to proceed when it is missing or disabled.
CREATE TABLE aaas_platform_configuration (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 configuration_id uuid NOT NULL,
 orchestration_version_id uuid NOT NULL,
 -- Platform-registered Tool parameter credential mappings. Callers may not
 -- invent sensitive parameter names or authentication methods.
 credential_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
 enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,configuration_id) REFERENCES orchestration_configurations(tenant_id,id),
 FOREIGN KEY (tenant_id,orchestration_version_id,configuration_id)
 REFERENCES orchestration_versions(tenant_id,id,configuration_id)
);

ALTER TABLE orchestration_integrations
 ADD COLUMN kind text NOT NULL DEFAULT 'legacy' CHECK (kind IN ('legacy','internal_key_carrier'));

-- The composite FK only fires for new Runs (key_id NOT NULL); under MATCH SIMPLE a
-- NULL key_id skips the check, so historical rows remain valid without backfill.
ALTER TABLE orchestration_work_items
 ADD COLUMN key_id uuid,
 ADD COLUMN task_id text CHECK (task_id IS NULL OR char_length(task_id) BETWEEN 1 AND 200),
 ADD COLUMN capability_snapshot jsonb,
 ADD COLUMN capability_snapshot_hash text,
 ADD FOREIGN KEY (tenant_id,key_id,integration_id)
 REFERENCES aaas_key_carriers(tenant_id,key_id,carrier_integration_id);

-- Independent idempotency scope: digest never stores plaintext, and both the
-- canonicalisation version and the digest-key version are retained for replay.
CREATE TABLE aaas_key_idempotency (
 tenant_id uuid NOT NULL,
 key_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
 request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
 canonicalization_version integer NOT NULL CHECK (canonicalization_version > 0),
 digest_key_version integer NOT NULL CHECK (digest_key_version > 0),
 work_item_id uuid NOT NULL REFERENCES orchestration_work_items(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,key_id,idempotency_key),
 FOREIGN KEY (tenant_id,key_id) REFERENCES aaas_api_keys(tenant_id,id)
);

CREATE INDEX aaas_key_runs_owner_idx ON orchestration_work_items(tenant_id,key_id,created_at DESC)
 WHERE key_id IS NOT NULL;
CREATE INDEX aaas_key_runs_state_idx ON orchestration_work_items(tenant_id,key_id,state)
 WHERE key_id IS NOT NULL;
CREATE INDEX aaas_key_carrier_kind_idx ON orchestration_integrations(tenant_id,id)
 WHERE kind='internal_key_carrier';
