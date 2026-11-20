-- Router V1 phase 1: contract and storage foundation.
-- Router tables are phase-1 artifacts and may be reshaped before delivery. Legacy
-- tables keep their rows, historical owner columns, old queries and the exact
-- ON CONFLICT (turn_id, call_index) write; only additive/compatibility columns and
-- mutual-exclusion constraints are introduced. Task has no status column: status
-- is derived from cancellation, queued/running Operations and one valid occupancy.

CREATE TABLE router_tasks (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    key_id uuid NOT NULL,
    canceled_at timestamptz NULL,
    cancel_reason text NULL,
    next_operation_sequence bigint NOT NULL DEFAULT 1 CHECK (next_operation_sequence > 0),
    event_sequence bigint NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
    max_pending_operations integer NOT NULL DEFAULT 4 CHECK (max_pending_operations BETWEEN 1 AND 4),
    fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
    latest_completed_operation_id uuid NULL,
    latest_operation_id uuid NULL,
    accumulated_usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(accumulated_usage) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, key_id, id),
    FOREIGN KEY (tenant_id, key_id) REFERENCES aaas_api_keys(tenant_id, id)
);

CREATE INDEX router_tasks_owner_idx ON router_tasks (tenant_id, key_id, created_at DESC);
CREATE INDEX router_tasks_canceled_idx ON router_tasks (tenant_id, canceled_at) WHERE canceled_at IS NOT NULL;

CREATE TABLE router_operations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    task_id uuid NOT NULL,
    operation_sequence bigint NOT NULL CHECK (operation_sequence > 0),
    -- The input text is the payload of one user.message History event. The
    -- Operation only references that event; the composite FK below forces the
    -- event, Operation and Task to agree.
    input_event_sequence bigint NOT NULL CHECK (input_event_sequence > 0),
    state text NOT NULL CHECK (state IN ('queued','running','completed','failed','canceled')),
    cancel_reason text NULL,
    error_code text NULL,
    result text NULL,
    -- Only verifiable execution-stage / tool-count signals. The same whitelist is
    -- declared in router-contracts.ts and in the Router OpenAPI document.
    progress jsonb NULL CHECK (
        progress IS NULL
        OR (
            jsonb_typeof(progress) = 'object'
            AND (progress - ARRAY['stage','stage_at','tools_completed','tools_total','updated_at']) = '{}'::jsonb
        )
    ),
    capability_scope text NOT NULL DEFAULT 'router' CHECK (capability_scope = 'router'),
    capability_snapshot jsonb NOT NULL CHECK (jsonb_typeof(capability_snapshot) = 'object'),
    capability_snapshot_hash text NOT NULL CHECK (char_length(capability_snapshot_hash) = 64),
    context_baseline_sequence bigint NOT NULL DEFAULT 0 CHECK (context_baseline_sequence >= 0),
    context_committed_sequence bigint NULL CHECK (context_committed_sequence IS NULL OR context_committed_sequence >= 0),
    context_snapshot jsonb NULL,
    context_snapshot_hash text NULL CHECK (context_snapshot_hash IS NULL OR char_length(context_snapshot_hash) = 64),
    usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage) = 'object'),
    usage_complete boolean NOT NULL DEFAULT false,
    credential_deadline timestamptz NULL,
    execution_deadline timestamptz NULL,
    -- Single source of truth for a valid execution/cleanup occupancy: queued may
    -- hold it after claim but before start; a terminal Operation may hold it while
    -- physical cleanup is still pending.
    holds_task_occupancy boolean NOT NULL DEFAULT false,
    claimed_at timestamptz NULL,
    worker_instance_id text NULL CHECK (worker_instance_id IS NULL OR char_length(worker_instance_id) BETWEEN 1 AND 200),
    lease_token bigint NULL CHECK (lease_token IS NULL OR lease_token > 0),
    lease_expires_at timestamptz NULL,
    queue_deadline timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
    queued_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz NULL,
    ended_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, id, task_id),
    UNIQUE (tenant_id, task_id, id),
    UNIQUE (tenant_id, task_id, operation_sequence),
    CONSTRAINT router_running_holds_occupancy CHECK (state <> 'running' OR holds_task_occupancy),
    CONSTRAINT router_claimed_has_evidence CHECK (
        NOT holds_task_occupancy
        OR (claimed_at IS NOT NULL AND worker_instance_id IS NOT NULL)
    ),
    CONSTRAINT router_context_snapshot_pair CHECK (
        (context_snapshot IS NULL AND context_snapshot_hash IS NULL)
        OR (context_snapshot IS NOT NULL AND context_snapshot_hash IS NOT NULL)
    ),
    FOREIGN KEY (tenant_id, task_id) REFERENCES router_tasks(tenant_id, id)
);

-- One Operation per Task may hold the occupancy in any valid phase. This is a
-- state invariant, not proof that a worker has exited; worker exit is a later
-- stage runtime gate.
CREATE UNIQUE INDEX router_one_occupancy_per_task
    ON router_operations (tenant_id, task_id) WHERE holds_task_occupancy;
CREATE UNIQUE INDEX router_one_running_per_task
    ON router_operations (tenant_id, task_id) WHERE state = 'running';
CREATE INDEX router_operations_queue_idx
    ON router_operations (tenant_id, task_id, operation_sequence) WHERE state = 'queued';
CREATE INDEX router_operations_owner_idx ON router_operations (tenant_id, id, created_at DESC);

-- Task pointers carry task_id so they cannot point at a sibling Task in the same
-- tenant. There is no independent Task lease pointer: fence_token is only a
-- monotonic guard, while the Operation row owns the occupancy fact.
ALTER TABLE router_tasks
    ADD CONSTRAINT router_task_latest_completed_fk
        FOREIGN KEY (tenant_id, id, latest_completed_operation_id)
        REFERENCES router_operations(tenant_id, task_id, id),
    ADD CONSTRAINT router_task_latest_operation_fk
        FOREIGN KEY (tenant_id, id, latest_operation_id)
        REFERENCES router_operations(tenant_id, task_id, id);

-- History is one append-only sequence per Task: the same value is the internal
-- History index and the public cursor source. Raw user/assistant/tool round-trips
-- live here; only rows marked public_visible are projected to callers.
CREATE TABLE router_task_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    task_id uuid NOT NULL,
    sequence bigint NOT NULL CHECK (sequence > 0),
    operation_id uuid NULL,
    -- Set only on the user.message event that is the single input fact for an Operation.
    user_input_for_operation_id uuid NULL,
    event_type text NOT NULL CHECK (event_type IN (
        'task.created','operation.accepted','operation.queued','operation.started',
        'operation.progress','operation.completed','operation.failed','operation.canceled',
        'task.canceled','context.committed','task.cleanup_completed',
        'user.message','assistant.message','tool.call','tool.result'
    )),
    public_visible boolean NOT NULL DEFAULT false,
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, task_id, sequence),
    UNIQUE (tenant_id, task_id, user_input_for_operation_id, sequence),
    CONSTRAINT router_event_public_type CHECK (
        NOT public_visible OR event_type IN (
            'task.created','operation.accepted','operation.queued','operation.started',
            'operation.progress','operation.completed','operation.failed','operation.canceled',
            'task.canceled','context.committed','task.cleanup_completed'
        )
    ),
    CONSTRAINT router_progress_event_payload CHECK (
        NOT (public_visible AND event_type = 'operation.progress')
        OR (payload - ARRAY['stage','stage_at','tools_completed','tools_total','updated_at']) = '{}'::jsonb
    ),
    CONSTRAINT router_user_message_payload CHECK (
        (event_type = 'user.message' AND user_input_for_operation_id IS NOT NULL
            AND NOT public_visible
            AND payload ? 'text' AND jsonb_typeof(payload->'text') = 'string')
        OR (event_type <> 'user.message' AND user_input_for_operation_id IS NULL)
    ),
    CONSTRAINT router_input_event_operation CHECK (
        user_input_for_operation_id IS NULL
        OR operation_id IS NULL
        OR operation_id = user_input_for_operation_id
    ),
    CONSTRAINT router_assistant_message_payload CHECK (
        event_type <> 'assistant.message'
        OR (payload ? 'text' AND jsonb_typeof(payload->'text') = 'string')
    ),
    CONSTRAINT router_tool_roundtrip_payload CHECK (
        event_type NOT IN ('tool.call','tool.result')
        OR (payload ? 'server_id' AND payload ? 'tool_name'
            AND jsonb_typeof(payload->'server_id') = 'string'
            AND jsonb_typeof(payload->'tool_name') = 'string')
    ),
    FOREIGN KEY (tenant_id, task_id) REFERENCES router_tasks(tenant_id, id),
    -- Composite FK rejects an event that points at an Operation from another Task.
    FOREIGN KEY (tenant_id, task_id, operation_id)
        REFERENCES router_operations(tenant_id, task_id, id)
);
CREATE INDEX router_task_events_operation_idx ON router_task_events (tenant_id, operation_id, sequence);

-- The referenced row must be a user.message input event bound to this very
-- Operation; the composite key also rejects cross-Task references.
ALTER TABLE router_operations
    ADD CONSTRAINT router_operation_input_event_fk
        FOREIGN KEY (tenant_id, task_id, id, input_event_sequence)
        REFERENCES router_task_events(tenant_id, task_id, user_input_for_operation_id, sequence);

CREATE VIEW router_task_public_events AS
SELECT tenant_id, task_id, sequence, operation_id, event_type, schema_version, payload, created_at
FROM router_task_events
WHERE public_visible;

CREATE TABLE router_operation_credentials (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    task_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    dimension text NOT NULL CHECK (dimension IN ('connection','tool')),
    server_id text NOT NULL CHECK (server_id ~ '^mcp_[0-9a-f-]{36}$'),
    tool_name text NULL,
    credential_id text NOT NULL CHECK (char_length(credential_id) BETWEEN 1 AND 100),
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
    key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    CONSTRAINT router_credential_dimension_shape CHECK (
        (dimension = 'connection' AND tool_name IS NULL)
        OR (dimension = 'tool' AND tool_name IS NOT NULL)
    ),
    FOREIGN KEY (tenant_id, task_id, operation_id)
        REFERENCES router_operations(tenant_id, task_id, id)
);
CREATE UNIQUE INDEX router_operation_credentials_scope
    ON router_operation_credentials (tenant_id, operation_id, dimension, server_id, coalesce(tool_name, ''), credential_id);
CREATE INDEX router_operation_credentials_expiry ON router_operation_credentials (tenant_id, expires_at);

CREATE TABLE router_idempotency (
    tenant_id uuid NOT NULL,
    key_id uuid NOT NULL,
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    request_scope text NOT NULL CHECK (request_scope IN ('task.create','operation.input')),
    -- Creation is isolated by Key (scope_id = key_id); input is isolated by
    -- Key + target Task (scope_id = task_id).
    scope_id uuid NOT NULL,
    request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
    canonicalization_version integer NOT NULL CHECK (canonicalization_version > 0),
    digest_key_version integer NOT NULL CHECK (digest_key_version > 0),
    task_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Same Idempotency-Key may be reused across Tasks for inputs, but never
    -- twice for the same Task or the same Task creation.
    PRIMARY KEY (tenant_id, key_id, request_scope, scope_id, idempotency_key),
    CONSTRAINT router_idempotency_scope_binding CHECK (
        (request_scope = 'task.create' AND scope_id = key_id)
        OR (request_scope = 'operation.input' AND scope_id = task_id)
    ),
    UNIQUE (tenant_id, task_id, operation_id),
    FOREIGN KEY (tenant_id, key_id) REFERENCES aaas_api_keys(tenant_id, id),
    FOREIGN KEY (tenant_id, key_id, task_id) REFERENCES router_tasks(tenant_id, key_id, id),
    FOREIGN KEY (tenant_id, task_id, operation_id) REFERENCES router_operations(tenant_id, task_id, id)
);

-- Router-only Keys default to direct capabilities. Legacy Keys keep their old
-- configuration resolution. NULL direct_capabilities means "not registered";
-- an explicit object with revision > 0 is the only usable direct capability.
ALTER TABLE aaas_api_keys
    ADD COLUMN router_capability_scope text NOT NULL DEFAULT 'legacy'
        CHECK (router_capability_scope IN ('legacy','dual','router')),
    ADD COLUMN direct_capabilities jsonb NULL,
    ADD COLUMN direct_capability_revision integer NOT NULL DEFAULT 0 CHECK (direct_capability_revision >= 0),
    ADD COLUMN router_capability_updated_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT router_direct_capabilities_shape
        CHECK (direct_capabilities IS NULL OR jsonb_typeof(direct_capabilities) = 'object'),
    ADD CONSTRAINT router_direct_capabilities_revision
        CHECK (
            (direct_capabilities IS NULL AND direct_capability_revision = 0)
            OR (direct_capabilities IS NOT NULL AND direct_capability_revision > 0)
        );

-- Sensitive rules are frozen together with the MCP Revision and Tool schema.
-- NULL = never registered; '[]' = explicitly reviewed and empty.
ALTER TABLE mcp_server_revisions
    ADD COLUMN sensitive_bindings jsonb NULL,
    ADD CONSTRAINT mcp_revision_sensitive_bindings_shape
        CHECK (sensitive_bindings IS NULL OR jsonb_typeof(sensitive_bindings) = 'array');
ALTER TABLE mcp_tools
    ADD COLUMN sensitive_bindings jsonb NULL,
    ADD CONSTRAINT mcp_tool_sensitive_bindings_shape
        CHECK (sensitive_bindings IS NULL OR jsonb_typeof(sensitive_bindings) = 'array');

-- Tracking attribution is mutually exclusive. The old (turn_id, call_index)
-- primary key is replaced by a generated UUID primary key with default
-- gen_random_uuid(); existing rows keep their UUIDs implicitly assigned by that
-- default and the old ON CONFLICT (turn_id, call_index) write still works through
-- a retained UNIQUE constraint. The old INSERT statement is unchanged. A pure
-- Router call needs no Conversation, Assignment or Turn at all.
ALTER TABLE orchestration_llm_calls
    ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN router_operation_id uuid NULL;
ALTER TABLE orchestration_llm_calls
    DROP CONSTRAINT orchestration_llm_calls_pkey,
    ADD CONSTRAINT orchestration_llm_calls_pkey PRIMARY KEY (id),
    ALTER COLUMN conversation_id DROP NOT NULL,
    ALTER COLUMN turn_id DROP NOT NULL,
    ADD CONSTRAINT orchestration_llm_calls_turn_call_uq UNIQUE (turn_id, call_index),
    ADD CONSTRAINT orchestration_llm_calls_router_call_uq UNIQUE (router_operation_id, call_index),
    ADD CONSTRAINT orchestration_llm_calls_attribution CHECK (
        (router_operation_id IS NULL AND turn_id IS NOT NULL AND conversation_id IS NOT NULL)
        OR (router_operation_id IS NOT NULL AND turn_id IS NULL AND conversation_id IS NULL)
    ),
    ADD CONSTRAINT router_llm_call_operation_fk
        FOREIGN KEY (tenant_id, router_operation_id) REFERENCES router_operations(tenant_id, id);
CREATE INDEX router_llm_calls_operation_idx ON orchestration_llm_calls (tenant_id, router_operation_id)
    WHERE router_operation_id IS NOT NULL;

-- MCP audit: a Router attribution never mixes with legacy Chat/Integration
-- ownership columns. Existing rows are untouched.
ALTER TABLE mcp_call_audits
    ADD COLUMN router_operation_id uuid NULL,
    ADD CONSTRAINT router_mcp_audit_operation_fk
        FOREIGN KEY (tenant_id, router_operation_id) REFERENCES router_operations(tenant_id, id),
    ADD CONSTRAINT router_mcp_audit_attribution CHECK (
        router_operation_id IS NULL
        OR (
            conversation_id IS NULL
            AND published_app_version_id IS NULL
            AND integration_id IS NULL
            AND orchestration_version_id IS NULL
        )
    );
CREATE INDEX router_mcp_audits_operation_idx ON mcp_call_audits (tenant_id, router_operation_id)
    WHERE router_operation_id IS NOT NULL;
