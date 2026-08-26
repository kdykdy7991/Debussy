-- Agent Platform MVP: immutable MCP revisions, Tool snapshots, protected secrets, and runtime audit.

CREATE TABLE mcp_servers (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL,
    status text NOT NULL CHECK (status IN ('enabled', 'disabled')),
    current_revision integer NOT NULL CHECK (current_revision > 0),
    last_test_ok boolean NULL,
    last_test_latency_ms integer NULL CHECK (last_test_latency_ms >= 0),
    last_test_at timestamptz NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz NULL,
    UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX mcp_servers_active_tenant_name_idx
    ON mcp_servers (tenant_id, name) WHERE deleted_at IS NULL;

CREATE TABLE mcp_server_revisions (
    mcp_server_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    transport text NOT NULL CHECK (transport = 'streamable_http'),
    endpoint text NOT NULL,
    authentication text NOT NULL CHECK (authentication IN ('none', 'bearer')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mcp_server_id, revision),
    UNIQUE (tenant_id, mcp_server_id, revision),
    FOREIGN KEY (tenant_id, mcp_server_id) REFERENCES mcp_servers(tenant_id, id)
);

CREATE TABLE mcp_tools (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    mcp_server_id uuid NOT NULL,
    mcp_revision integer NOT NULL,
    name text NOT NULL,
    description text NULL,
    input_schema jsonb NOT NULL,
    input_schema_hash text NOT NULL CHECK (char_length(input_schema_hash) = 64),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, mcp_server_id, mcp_revision, name),
    FOREIGN KEY (tenant_id, mcp_server_id, mcp_revision)
        REFERENCES mcp_server_revisions(tenant_id, mcp_server_id, revision)
);

-- Ciphertext is isolated from ordinary MCP reads. AES-256-GCM nonce/tag are stored separately.
CREATE TABLE mcp_secrets (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    mcp_server_id uuid NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
    key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, mcp_server_id),
    FOREIGN KEY (tenant_id, mcp_server_id) REFERENCES mcp_servers(tenant_id, id)
);

CREATE TABLE agent_revision_mcp_bindings (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    agent_definition_id uuid NOT NULL,
    agent_revision bigint NOT NULL,
    position integer NOT NULL CHECK (position >= 0),
    mcp_server_id uuid NOT NULL,
    mcp_revision integer NOT NULL,
    tool_allowlist text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, agent_definition_id, agent_revision, mcp_server_id),
    UNIQUE (tenant_id, agent_definition_id, agent_revision, position),
    FOREIGN KEY (tenant_id, agent_definition_id, agent_revision)
        REFERENCES agent_definitions(tenant_id, id, revision),
    FOREIGN KEY (tenant_id, mcp_server_id, mcp_revision)
        REFERENCES mcp_server_revisions(tenant_id, mcp_server_id, revision)
);

CREATE TABLE mcp_call_audits (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    conversation_id uuid NULL,
    published_app_version_id uuid NULL,
    mcp_server_id uuid NOT NULL,
    mcp_revision integer NOT NULL,
    tool_name text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('success', 'error', 'cancelled')),
    latency_ms integer NOT NULL CHECK (latency_ms >= 0),
    result_bytes integer NOT NULL DEFAULT 0 CHECK (result_bytes >= 0),
    result_truncated boolean NOT NULL DEFAULT false,
    error_code text NULL,
    request_id uuid NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, mcp_server_id, mcp_revision)
        REFERENCES mcp_server_revisions(tenant_id, mcp_server_id, revision)
);

CREATE INDEX mcp_call_audits_tenant_created_idx ON mcp_call_audits (tenant_id, created_at DESC);
