ALTER TABLE router_task_events
    DROP CONSTRAINT router_task_events_event_type_check,
    ADD CONSTRAINT router_task_events_event_type_check CHECK (event_type IN (
        'task.created','operation.accepted','operation.queued','operation.started',
        'operation.progress','operation.completed','operation.failed','operation.canceled',
        'task.canceled','context.committed','task.cleanup_completed',
        'user.message','assistant.message','tool.call','tool.result','sandbox.execution'
    )),
    ADD CONSTRAINT router_sandbox_execution_payload CHECK (
        event_type <> 'sandbox.execution' OR (
            NOT public_visible AND operation_id IS NOT NULL
            AND payload ?& ARRAY['status','startedAt','endedAt','durationMs','reason']
            AND payload - ARRAY['status','startedAt','endedAt','durationMs','reason'] = '{}'::jsonb
            AND coalesce(payload->>'status' IN ('success','command_failed','start_failed','timeout','canceled'), false)
            AND jsonb_typeof(payload->'startedAt') = 'string'
            AND jsonb_typeof(payload->'endedAt') = 'string'
            AND jsonb_typeof(payload->'durationMs') = 'number'
            AND payload->'durationMs' >= '0'::jsonb
            AND jsonb_typeof(payload->'reason') IN ('string','null')
        )
    );

CREATE INDEX router_sandbox_execution_recent_idx
    ON router_task_events (tenant_id, created_at DESC, id DESC)
    WHERE event_type = 'sandbox.execution';
