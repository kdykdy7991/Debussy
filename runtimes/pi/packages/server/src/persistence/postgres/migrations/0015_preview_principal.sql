-- Preview sessions use an app-scoped administrator principal. The domain
-- type was added before the database CHECK constraint was expanded, causing
-- the first preview-ticket exchange to fail after consuming the ticket.

ALTER TABLE principals
    DROP CONSTRAINT IF EXISTS principals_principal_type_check;

ALTER TABLE principals
    ADD CONSTRAINT principals_principal_type_check
    CHECK (principal_type IN (
        'platform_user',
        'external_user',
        'anonymous_visitor',
        'service',
        'platform_admin_preview'
    ));
