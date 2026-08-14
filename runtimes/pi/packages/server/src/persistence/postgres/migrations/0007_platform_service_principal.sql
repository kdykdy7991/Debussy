-- TASK-013: platform service principal for control-plane idempotency/audit.
--
-- Control operations (import-current, create app, ...) run before any app
-- exists, so their idempotency records and audit actor need a tenant-level
-- principal that is not bound to a published app (spec 26.2 / 33.1).
--
-- published_app_id becomes nullable, but only for principal_type = 'service':
-- user/visitor principals must still belong to an app (enforced by CHECK).

ALTER TABLE principals
    ALTER COLUMN published_app_id DROP NOT NULL;

ALTER TABLE principals
    ADD CONSTRAINT principals_platform_service_check
    CHECK (principal_type = 'service' OR published_app_id IS NOT NULL);

-- Exactly one platform service principal per tenant (Postgres UNIQUE treats
-- NULLs as distinct, so the table-level UNIQUE above cannot cover it).
CREATE UNIQUE INDEX principals_platform_service_uniq
    ON principals (tenant_id, principal_type, subject_hash)
    WHERE published_app_id IS NULL;
