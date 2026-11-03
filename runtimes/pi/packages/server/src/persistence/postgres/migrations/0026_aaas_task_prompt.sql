ALTER TABLE orchestration_work_items ADD COLUMN task_prompt text NULL
 CHECK (task_prompt IS NULL OR (origin = 'aaas' AND char_length(task_prompt) BETWEEN 1 AND 48000));
