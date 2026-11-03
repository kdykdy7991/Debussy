-- New executions preserve the model's final text, including JSON/Markdown and whitespace.
-- Existing structured reports retain their data as JSON text; prior formatting is unavailable.
ALTER TABLE orchestration_assignments ALTER COLUMN report TYPE text
 USING CASE WHEN jsonb_typeof(report) = 'string' THEN report #>> '{}' ELSE report::text END;

UPDATE orchestration_integrations SET settings = settings - 'reportSchemaVersion'
 WHERE settings ? 'reportSchemaVersion';
UPDATE orchestration_work_items SET settings = settings - 'reportSchemaVersion'
 WHERE settings ? 'reportSchemaVersion';
