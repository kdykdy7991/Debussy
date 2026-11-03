-- Keep the existing queue/runtime; distinguish one-shot service work at the mutation boundary.
ALTER TABLE orchestration_work_items
 ADD COLUMN origin text NOT NULL DEFAULT 'orchestration'
 CHECK (origin IN ('orchestration','aaas'));
