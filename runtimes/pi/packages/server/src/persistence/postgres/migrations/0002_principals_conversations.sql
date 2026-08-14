-- TASK-005: principals and conversations.
-- Baseline per spec section 26.2, plus composite FKs so a conversation can
-- never reference a version or principal that belongs to another app
-- (spec TASK-005: "Conversation 可引用另一个 App 的 Version" must be
-- prevented at the schema level).

CREATE TABLE principals (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    principal_type text NOT NULL CHECK (principal_type IN ('external_user', 'anonymous_visitor', 'service')),
    subject_hash text NOT NULL CHECK (char_length(subject_hash) = 64),
    external_user_id_ciphertext bytea NULL,
    status text NOT NULL CHECK (status IN ('active', 'blocked', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, published_app_id, principal_type, subject_hash),
    UNIQUE (tenant_id, id),
    UNIQUE (id, published_app_id)
);

-- Composite uniqueness so conversations can FK (id, published_app_id) and
-- therefore cannot point at a version of another app.
ALTER TABLE published_app_versions
    ADD CONSTRAINT published_app_versions_id_app_uq
    UNIQUE (id, published_app_id);

CREATE TABLE conversations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    published_app_version_id uuid NOT NULL,
    owner_principal_id uuid NOT NULL,
    title text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
    last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz NULL,
    UNIQUE (tenant_id, id),
    UNIQUE (id, published_app_id),
    FOREIGN KEY (published_app_version_id, published_app_id)
        REFERENCES published_app_versions (id, published_app_id),
    FOREIGN KEY (owner_principal_id, published_app_id)
        REFERENCES principals (id, published_app_id)
);

CREATE INDEX conversations_owner_list_idx
    ON conversations (tenant_id, published_app_id, owner_principal_id, last_active_at DESC)
    WHERE deleted_at IS NULL;
