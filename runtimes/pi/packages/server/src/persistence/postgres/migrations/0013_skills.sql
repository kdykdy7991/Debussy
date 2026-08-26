-- Agent Platform MVP: immutable Skill artifacts, revisions, and Agent bindings.

CREATE TABLE skills (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL,
    status text NOT NULL CHECK (status IN ('enabled', 'disabled')),
    current_revision integer NOT NULL CHECK (current_revision > 0),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz NULL,
    UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX skills_active_tenant_name_idx
    ON skills (tenant_id, name) WHERE deleted_at IS NULL;

CREATE TABLE skill_artifacts (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    filename text NOT NULL,
    media_type text NOT NULL,
    source_hash text NOT NULL CHECK (char_length(source_hash) = 64),
    size_bytes integer NOT NULL CHECK (size_bytes > 0),
    content bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE skill_revisions (
    skill_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    artifact_id uuid NOT NULL REFERENCES skill_artifacts(id),
    source_hash text NOT NULL CHECK (char_length(source_hash) = 64),
    parsed_name text NOT NULL,
    description text NOT NULL,
    instruction_text text NOT NULL,
    disable_model_invocation boolean NOT NULL DEFAULT false,
    diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (skill_id, revision),
    UNIQUE (tenant_id, skill_id, revision),
    FOREIGN KEY (tenant_id, skill_id) REFERENCES skills(tenant_id, id),
    FOREIGN KEY (tenant_id, artifact_id) REFERENCES skill_artifacts(tenant_id, id)
);

ALTER TABLE agent_definitions
    ADD CONSTRAINT agent_definitions_tenant_revision_unique
    UNIQUE (tenant_id, id, revision);

CREATE TABLE agent_revision_skills (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    agent_definition_id uuid NOT NULL,
    agent_revision bigint NOT NULL,
    position integer NOT NULL CHECK (position >= 0),
    skill_id uuid NOT NULL,
    skill_revision integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, agent_definition_id, agent_revision, skill_id),
    UNIQUE (tenant_id, agent_definition_id, agent_revision, position),
    FOREIGN KEY (tenant_id, agent_definition_id, agent_revision)
        REFERENCES agent_definitions(tenant_id, id, revision),
    FOREIGN KEY (tenant_id, skill_id, skill_revision)
        REFERENCES skill_revisions(tenant_id, skill_id, revision)
);
