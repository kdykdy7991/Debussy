-- AaaS configuration association: a configuration owns an explicit active version,
-- and a Key may follow a configuration (or the platform default) rather than pin a
-- historical Version ID. Existing pinned Keys are left untouched.

-- 1) Each configuration records which published version is currently effective.
--    This is distinct from "latest published": switching/rollback can point at any
--    published version. Preserve the existing platform default binding even when
--    a newer version exists. Other configurations use the latest published
--    revision; configurations without a published version remain NULL.
ALTER TABLE orchestration_configurations ADD COLUMN active_version_id uuid;
ALTER TABLE orchestration_configurations ADD FOREIGN KEY (tenant_id, active_version_id, id)
  REFERENCES orchestration_versions(tenant_id, id, configuration_id);
UPDATE orchestration_configurations c SET active_version_id = COALESCE((
  SELECT p.orchestration_version_id FROM aaas_platform_configuration p
  WHERE p.tenant_id = c.tenant_id AND p.configuration_id = c.id
), (
  SELECT v.id FROM orchestration_versions v
  WHERE v.tenant_id = c.tenant_id AND v.configuration_id = c.id
  ORDER BY v.source_draft_revision DESC, v.created_at DESC, v.id DESC
  LIMIT 1
));

-- 2) A Key may follow a named configuration (its active version). NULL = platform default.
--    Existing orchestration_version_id (pinned version) is preserved and takes priority
--    in resolution until an administrator explicitly converts the Key.
ALTER TABLE aaas_api_keys ADD COLUMN orchestration_configuration_id uuid;
ALTER TABLE aaas_api_keys ADD FOREIGN KEY (tenant_id, orchestration_configuration_id)
  REFERENCES orchestration_configurations(tenant_id, id);

-- A Key must not both pin a version and follow a configuration at the same time.
ALTER TABLE aaas_api_keys ADD CONSTRAINT aaas_key_config_exclusive CHECK (
  orchestration_version_id IS NULL OR orchestration_configuration_id IS NULL
);
