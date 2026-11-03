ALTER TABLE orchestration_work_items
 ADD COLUMN external_ref_type text,
 ADD COLUMN external_ref_id text,
 ADD COLUMN metadata jsonb;

CREATE INDEX orchestration_external_ref ON orchestration_work_items
 (tenant_id, integration_id, external_ref_type, external_ref_id, created_at DESC)
 WHERE external_ref_id IS NOT NULL;
