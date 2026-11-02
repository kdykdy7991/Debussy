-- Backend-authenticated hosts for one-time Embed login codes.
CREATE TABLE trusted_embed_apps (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    published_app_id uuid NOT NULL REFERENCES published_apps(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    client_id text NOT NULL UNIQUE,
    secret_hash text NOT NULL CHECK (char_length(secret_hash) = 64),
    enabled boolean NOT NULL DEFAULT true,
    allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, published_app_id, id)
);

ALTER TABLE published_apps DROP CONSTRAINT published_apps_access_mode_check;
ALTER TABLE published_apps ADD CONSTRAINT published_apps_access_mode_check
    CHECK (access_mode IN ('anonymous', 'signed_user', 'mixed', 'trusted_app'));

CREATE TABLE trusted_embed_identity_profiles (
    principal_id uuid PRIMARY KEY REFERENCES principals(id),
    trusted_app_id uuid NOT NULL REFERENCES trusted_embed_apps(id),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
    roles jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);
