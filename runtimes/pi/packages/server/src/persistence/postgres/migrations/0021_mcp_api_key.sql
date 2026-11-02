-- Credentials remain in mcp_secrets; revisions store only the authentication mode.
ALTER TABLE mcp_server_revisions
    DROP CONSTRAINT mcp_server_revisions_authentication_check;

ALTER TABLE mcp_server_revisions
    ADD CONSTRAINT mcp_server_revisions_authentication_check
    CHECK (authentication IN ('none', 'bearer', 'api_key'));
