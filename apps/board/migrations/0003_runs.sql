-- Milestone 1: runs, run events, artifacts, budgets, prices. Engines are rows.

CREATE TABLE engines (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  default_model text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true
);
INSERT INTO engines (id, name, default_model, enabled) VALUES
  ('claude_code', 'Claude Code', 'claude-sonnet-5', true),
  ('codex', 'Codex', 'gpt-5-codex', true),
  ('opencode', 'OpenCode', 'claude-sonnet-5', false),
  ('stub', 'Stub (tests)', 'stub', true);

ALTER TABLE projects ADD COLUMN repo_url text;
ALTER TABLE projects ADD COLUMN default_branch text NOT NULL DEFAULT 'main';

-- Files a task is expected to produce (flat names). Checked at review time.
ALTER TABLE tasks ADD COLUMN declared_outputs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN active_run_id uuid;

CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  teammate_id     uuid NOT NULL REFERENCES teammates(id) ON DELETE CASCADE,
  engine          text NOT NULL REFERENCES engines(id),
  model           text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'interrupted', 'completed', 'failed', 'stopped', 'blocked')),
  attempt         integer NOT NULL DEFAULT 1,
  job_id          text,
  worker_id       text,
  current_step    text,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  heartbeat_at    timestamptz,
  stop_requested  boolean NOT NULL DEFAULT false,
  summary         text,
  error           text,
  blocker         jsonb,
  -- {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
  usage           jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_minor_units bigint,
  duration_ms     integer,
  run_spec_hash   text,
  -- Sanitised resume state from the worker; a requeued attempt starts from here.
  checkpoint      jsonb,
  note            text,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'teammate')),
  created_by_id   uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_task_idx ON runs (task_id, created_at DESC);
CREATE INDEX runs_company_status_idx ON runs (company_id, status);
-- One live run per task.
CREATE UNIQUE INDEX runs_one_active_per_task ON runs (task_id)
  WHERE status IN ('queued', 'running', 'interrupted');

ALTER TABLE tasks ADD CONSTRAINT tasks_active_run_fk FOREIGN KEY (active_run_id) REFERENCES runs(id) ON DELETE SET NULL;

-- The fine-grained log of one run: what the engine is doing, tool calls, output lines.
CREATE TABLE run_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id     uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id     uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path       text NOT NULL,
  kind       text NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'diff', 'document', 'log', 'handover')),
  sha256     text NOT NULL,
  bytes      integer NOT NULL,
  -- Small text artifacts live inline; larger ones in object storage under object_key.
  content    text,
  object_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, path)
);
CREATE INDEX artifacts_task_idx ON artifacts (task_id, created_at DESC);

-- Run-scoped tokens: a token minted at claim time, valid for one run.
ALTER TABLE api_tokens ADD COLUMN run_id uuid REFERENCES runs(id) ON DELETE CASCADE;

CREATE TABLE budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope_kind   text NOT NULL CHECK (scope_kind IN ('company', 'department', 'project', 'teammate')),
  scope_id     uuid NOT NULL,
  tokens_limit bigint NOT NULL CHECK (tokens_limit >= 0),
  window_kind  text NOT NULL DEFAULT 'week' CHECK (window_kind IN ('day', 'week', 'month')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, scope_kind, scope_id)
);

-- Per-company price table. Prices in minor units (pence, cents) per million tokens.
CREATE TABLE model_prices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  model                    text NOT NULL,
  currency                 text NOT NULL DEFAULT 'GBP',
  input_per_million        bigint,
  output_per_million       bigint,
  cache_read_per_million   bigint,
  cache_write_per_million  bigint,
  seat_price_month         bigint,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, model)
);

-- One row per run and model, so costs roll up by department, project, teammate and model.
CREATE TABLE run_usage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id             uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id            uuid NOT NULL,
  teammate_id        uuid NOT NULL,
  project_id         uuid NOT NULL,
  department_id      uuid,
  model              text NOT NULL,
  input_tokens       bigint NOT NULL DEFAULT 0,
  output_tokens      bigint NOT NULL DEFAULT 0,
  cache_read_tokens  bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  cost_minor_units   bigint,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_usage_company_time_idx ON run_usage (company_id, created_at DESC);
