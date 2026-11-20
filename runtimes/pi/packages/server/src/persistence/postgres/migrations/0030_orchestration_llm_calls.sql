-- Admin-only model-call diagnostics. These payloads never enter the shared conversation event stream.
CREATE TABLE orchestration_llm_calls (
 tenant_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 turn_id uuid NOT NULL REFERENCES orchestration_assignments(turn_id),
 call_index integer NOT NULL CHECK (call_index > 0),
 model_provider text NOT NULL,
 model_id text NOT NULL,
 request_payload jsonb NOT NULL,
 response_payload jsonb NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz NULL,
 PRIMARY KEY (turn_id, call_index),
 FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);
CREATE INDEX orchestration_llm_calls_conversation ON orchestration_llm_calls(tenant_id,conversation_id,created_at,call_index);
