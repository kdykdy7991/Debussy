-- TASK-004: publishing control-plane core tables.
-- Baseline per spec section 26.2. This file is append-only: deployed
-- environments must never rewrite an applied migration.

CREATE TABLE tenants (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    status text NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_definitions (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    revision bigint NOT NULL CHECK (revision > 0),
    draft_config jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (id, revision)
);

CREATE TABLE published_apps (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    agent_definition_id uuid NOT NULL REFERENCES agent_definitions(id),
    public_app_id text NOT NULL UNIQUE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    status text NOT NULL CHECK (status IN ('draft', 'active', 'suspended', 'archived')),
    access_mode text NOT NULL CHECK (access_mode IN ('anonymous', 'signed_user', 'mixed')),
    current_version_id uuid NULL,
    allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
    mutable_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE published_app_versions (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    version_number integer NOT NULL CHECK (version_number > 0),
    source_agent_revision bigint NOT NULL CHECK (source_agent_revision > 0),
    snapshot jsonb NOT NULL,
    runtime_spec jsonb NOT NULL,
    runtime_spec_hash text NOT NULL CHECK (char_length(runtime_spec_hash) = 64),
    status text NOT NULL CHECK (status IN ('ready', 'rejected', 'retired')),
    validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (published_app_id, version_number),
    UNIQUE (tenant_id, id)
);

ALTER TABLE published_apps
    ADD CONSTRAINT published_apps_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES published_app_versions(id);

CREATE TABLE embed_launch_keys (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    key_id text NOT NULL,
    algorithm text NOT NULL,
    public_key_pem text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'retiring', 'revoked')),
    not_before timestamptz NOT NULL,
    expires_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (published_app_id, key_id)
);
