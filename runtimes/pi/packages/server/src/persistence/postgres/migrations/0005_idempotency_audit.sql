-- TASK-006: idempotency records and audit events (spec section 26.2).
--
-- Idempotency key uniqueness is enforced per (tenant, principal, operation,
-- key) so the same key cannot replay a different request body.
-- Audit events are append-only; requests are traceable by request_id without
-- storing conversation bodies.

CREATE TABLE idempotency_records (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    principal_id uuid NOT NULL REFERENCES principals(id),
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    response_status integer NULL,
    response_body jsonb NULL,
    state text NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, principal_id, operation, idempotency_key)
);

-- Expiry sweep support for stale idempotency records (spec TASK-008: running
-- 超时回收策略).
CREATE INDEX idempotency_records_expiry_idx
    ON idempotency_records (expires_at);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    request_id text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_request_idx
    ON audit_events (tenant_id, request_id);

CREATE INDEX audit_events_resource_idx
    ON audit_events (tenant_id, resource_type, resource_id);
