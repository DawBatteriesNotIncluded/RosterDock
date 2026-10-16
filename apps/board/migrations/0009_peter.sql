-- Milestone 4: Peter. A goal is what a person hands Peter; he opens a project
-- for it, plans it into tasks, watches them and reports what it spent.

CREATE TABLE goals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The project Peter opened for the goal. One goal, one project.
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The department the goal is routed to; its lead plans and watches it. Null: the company Peter.
  department_id  uuid REFERENCES departments(id) ON DELETE SET NULL,
  text           text NOT NULL,
  title          text NOT NULL,
  -- planning: Peter is reading it. needs_you: Peter asked questions or gave up on a task.
  -- active: planned and running. done: every task Done. stopped: a person stopped it.
  status         text NOT NULL DEFAULT 'planning'
                 CHECK (status IN ('planning', 'needs_you', 'active', 'done', 'stopped')),
  -- The last plan Peter produced (background, outcome, done definition, tasks).
  plan           jsonb,
  -- Clarifying questions and the person's answers: [{text, answer}].
  questions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Caps: {maxTasks, maxDepth, tokens}. Peter cannot create tasks past them without a person.
  caps           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Tokens Peter himself spent planning: {inputTokens, outputTokens, calls}.
  planning_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Why the goal needs a person, while status = 'needs_you'.
  attention      text,
  -- How Peter planned it: model or heuristic.
  planner        text,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'teammate')),
  created_by_id   uuid NOT NULL,
  planned_at     timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id)
);
CREATE INDEX goals_company_status_idx ON goals (company_id, status, created_at DESC);

-- build: a diff is reviewed. research: documents with sources are reviewed against a checklist.
ALTER TABLE tasks ADD COLUMN work_kind text NOT NULL DEFAULT 'build' CHECK (work_kind IN ('build', 'research'));
-- The task a teammate was working when it filed this one; depth from the goal's tasks is capped.
ALTER TABLE tasks ADD COLUMN parent_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
-- How many times Peter re-planned this task after a failed run.
ALTER TABLE tasks ADD COLUMN replans integer NOT NULL DEFAULT 0;

-- A per-goal token cap is a lifetime budget on the goal's project.
ALTER TABLE budgets DROP CONSTRAINT budgets_window_kind_check;
ALTER TABLE budgets ADD CONSTRAINT budgets_window_kind_check CHECK (window_kind IN ('day', 'week', 'month', 'goal'));
