-- Milestone 5: approvals. A teammate that wants to write to a live external
-- system proposes the exact tool call; the payload is stored with its sha256
-- and waits for a person. Approve re-verifies the hash and sends those bytes;
-- reject leaves the task blocked for Peter to re-plan. Nothing reaches a live
-- system without a row here whose sha256 matches what was sent.

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- The run that proposed it; the teammate is restarted with the outcome once decided.
  run_id          uuid REFERENCES runs(id) ON DELETE SET NULL,
  teammate_id     uuid REFERENCES teammates(id) ON DELETE SET NULL,
  -- The connection (by name) and the tool on it the payload is bound to.
  connection      text NOT NULL,
  tool            text NOT NULL,
  -- Manager language: what the write does, and why the teammate wants it.
  title           text NOT NULL,
  why             text NOT NULL DEFAULT '',
  -- The exact arguments that will be sent, and their sha256 (canonical JSON).
  payload         jsonb NOT NULL,
  payload_sha256  text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
  decided_by_kind text CHECK (decided_by_kind IN ('user', 'teammate')),
  decided_by_id   uuid,
  decided_at      timestamptz,
  -- The decider's note (why rejected, or a remark on approval).
  note            text,
  -- What the live system answered (redacted), or why the send failed.
  result          jsonb,
  error           text,
  executed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_company_status_idx ON approvals (company_id, status, created_at DESC);
CREATE INDEX approvals_task_idx ON approvals (task_id, created_at DESC);
