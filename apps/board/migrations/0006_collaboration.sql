-- Milestone 2: teammates act on the board through the MCP server.

-- Decision audit trail: what a teammate assumed and how sure it was.
CREATE TABLE decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      uuid REFERENCES runs(id) ON DELETE SET NULL,
  teammate_id uuid NOT NULL REFERENCES teammates(id) ON DELETE CASCADE,
  decision    text NOT NULL,
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 0..1
  confidence  numeric(3, 2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_task_idx ON decisions (task_id, created_at DESC);

-- A run is either the assignee working the task, or a teammate's turn on a
-- task they were mentioned on. Several teammates may be live on one task, but
-- each teammate only once.
ALTER TABLE runs ADD COLUMN kind text NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'turn'));
ALTER TABLE runs ADD COLUMN trigger_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
DROP INDEX runs_one_active_per_task;
CREATE UNIQUE INDEX runs_one_active_per_task_teammate ON runs (task_id, teammate_id)
  WHERE status IN ('queued', 'running', 'interrupted');
