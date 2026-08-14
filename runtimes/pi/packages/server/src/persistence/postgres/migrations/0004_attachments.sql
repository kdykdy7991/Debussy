-- TASK-006: attachments metadata (spec section 26.2). Object keys are always
-- server-generated; the `object_key` column is unique and never derived from
-- the client filename (TASK-006 禁止继续条件). Composite FKs keep an
-- attachment inside the same app as its conversation and principal.

CREATE TABLE attachments (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    conversation_id uuid NOT NULL,
    owner_principal_id uuid NOT NULL,
    object_key text NOT NULL UNIQUE,
    filename text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    checksum_sha256 text NOT NULL CHECK (char_length(checksum_sha256) = 64),
    status text NOT NULL CHECK (status IN ('staged', 'ready', 'rejected', 'deleted')),
    expires_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz NULL,
    UNIQUE (tenant_id, id),
    UNIQUE (id, published_app_id),
    FOREIGN KEY (conversation_id, published_app_id)
        REFERENCES conversations (id, published_app_id),
    FOREIGN KEY (owner_principal_id, published_app_id)
        REFERENCES principals (id, published_app_id)
);

-- Expiry sweep query support (staged/expired records cleaned by a background
-- job; spec 6.3 deletion semantics).
CREATE INDEX attachments_expiry_idx
    ON attachments (expires_at)
    WHERE status IN ('staged', 'ready') AND deleted_at IS NULL;
