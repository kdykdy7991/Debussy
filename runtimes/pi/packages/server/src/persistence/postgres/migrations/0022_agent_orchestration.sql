-- Business work is independent of its Conversation and execution attempts.
CREATE TABLE orchestration_integrations (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 published_app_id uuid NOT NULL REFERENCES published_apps(id),
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
 enabled boolean NOT NULL DEFAULT true,
 secret_hash text NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 published_app_version_id uuid NOT NULL,
 settings jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, published_app_id),
 UNIQUE (tenant_id, id),
 FOREIGN KEY (published_app_version_id, published_app_id) REFERENCES published_app_versions(id, published_app_id)
);

CREATE TABLE orchestration_work_items (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 alarm_id text NOT NULL,
 state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
 configuration_revision integer NOT NULL,
 published_app_version_id uuid NOT NULL,
 settings jsonb NOT NULL,
 principal_id uuid NOT NULL REFERENCES principals(id),
 conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, integration_id, id),
 FOREIGN KEY (tenant_id,published_app_version_id) REFERENCES published_app_versions(tenant_id,id),
 FOREIGN KEY (tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
 FOREIGN KEY (tenant_id, integration_id) REFERENCES orchestration_integrations(tenant_id,id)
);

CREATE TABLE orchestration_events (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
 alarm_id text NOT NULL,
 input text NOT NULL,
 request_hash text NOT NULL,
 work_item_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,integration_id,event_id),
 UNIQUE (tenant_id,integration_id,id),
 FOREIGN KEY (tenant_id,integration_id,work_item_id) REFERENCES orchestration_work_items(tenant_id,integration_id,id)
);

CREATE TABLE orchestration_subscriptions (
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 alarm_id text NOT NULL,
 work_item_id uuid NOT NULL,
 PRIMARY KEY (tenant_id,integration_id,alarm_id,work_item_id),
 FOREIGN KEY (tenant_id,integration_id,work_item_id) REFERENCES orchestration_work_items(tenant_id,integration_id,id)
);

CREATE TABLE orchestration_credentials (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 work_item_id uuid NOT NULL,
 sealed jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 UNIQUE (tenant_id,integration_id,work_item_id,id),
 FOREIGN KEY (tenant_id,integration_id,work_item_id) REFERENCES orchestration_work_items(tenant_id,integration_id,id)
);

CREATE TABLE orchestration_assignments (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 work_item_id uuid NOT NULL,
 event_id uuid NOT NULL,
 credential_id uuid NOT NULL REFERENCES orchestration_credentials(id),
 state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
 turn_id uuid NOT NULL UNIQUE,
 report jsonb NULL,
 error text NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz NULL,
 ended_at timestamptz NULL,
 FOREIGN KEY (tenant_id,integration_id,work_item_id,credential_id) REFERENCES orchestration_credentials(tenant_id,integration_id,work_item_id,id),
 FOREIGN KEY (tenant_id,integration_id,work_item_id) REFERENCES orchestration_work_items(tenant_id,integration_id,id),
 FOREIGN KEY (tenant_id,integration_id,event_id) REFERENCES orchestration_events(tenant_id,integration_id,id)
);
CREATE INDEX orchestration_pending ON orchestration_assignments(created_at,id) WHERE state='queued';
CREATE UNIQUE INDEX orchestration_one_running ON orchestration_assignments(work_item_id) WHERE state='running';
CREATE INDEX orchestration_alarm ON orchestration_work_items(tenant_id,integration_id,alarm_id,created_at DESC);
