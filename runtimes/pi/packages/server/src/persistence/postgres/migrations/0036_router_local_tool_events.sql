-- Existing MCP history keeps its Server attribution. Local Bash events carry
-- the enforcing Provider and are eligible only for internal history.
ALTER TABLE router_task_events
    DROP CONSTRAINT router_tool_roundtrip_payload,
    ADD CONSTRAINT router_tool_roundtrip_payload CHECK (
        event_type NOT IN ('tool.call','tool.result')
        OR (
            payload ? 'tool_name'
            AND jsonb_typeof(payload->'tool_name') = 'string'
            AND (
                (payload ? 'server_id' AND jsonb_typeof(payload->'server_id') = 'string')
                OR (
                    NOT public_visible
                    AND NOT (payload ? 'server_id')
                    AND payload ? 'provider'
                    AND jsonb_typeof(payload->'provider') = 'string'
                    AND payload->>'provider' = 'linux-bwrap'
                    AND payload->>'tool_name' = 'bash'
                )
            )
        )
    );
