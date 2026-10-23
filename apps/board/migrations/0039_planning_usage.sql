-- A manager's own model calls count in Costs and budgets like a run's. Until now a goal kept only a running
-- total of its planning (goals.planning_usage, still what its card shows), with no model and no date, so
-- Costs could neither window nor price it and no budget counted it; a re-plan of a task outside any goal
-- and an org proposal (drafts.usage) were counted nowhere. One row per call: the manager who made it (Peter,
-- or a department's lead), what for (a goal's plan, a re-plan note, an org proposal), the goal, task,
-- project and department it served when it was made, the model that answered, and the tokens.

CREATE TABLE planning_usage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  teammate_id        uuid NOT NULL,
  purpose            text NOT NULL CHECK (purpose IN ('plan', 'replan', 'org')),
  goal_id            uuid,
  task_id            uuid,
  project_id         uuid,
  department_id      uuid,
  model              text NOT NULL,
  -- One, except on the rows below that carry what a goal or a draft spent before calls were counted one by one.
  calls              integer NOT NULL DEFAULT 1,
  input_tokens       bigint NOT NULL DEFAULT 0,
  output_tokens      bigint NOT NULL DEFAULT 0,
  cache_read_tokens  bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planning_usage_company_time_idx ON planning_usage (company_id, created_at DESC);
CREATE INDEX planning_usage_goal_idx ON planning_usage (goal_id) WHERE goal_id IS NOT NULL;

-- What goals spent planning before this: one row each, under the company's Peter, dated when the goal was
-- planned (or opened, while it waits on its questions), on the model its planner names when a model planned
-- it, else on Peter's model. Re-plan notes of its tasks are in the same total, so in the same row.
INSERT INTO planning_usage (company_id, teammate_id, purpose, goal_id, project_id, department_id, model, calls,
                            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
SELECT g.company_id, peter.id, 'plan', g.id, g.project_id, g.department_id,
       CASE WHEN g.planner LIKE 'model:_%' THEN substr(g.planner, 7) ELSE peter.model END,
       greatest(coalesce((g.planning_usage->>'calls')::int, 1), 1),
       coalesce((g.planning_usage->>'inputTokens')::bigint, 0),
       coalesce((g.planning_usage->>'outputTokens')::bigint, 0),
       coalesce((g.planning_usage->>'cacheReadTokens')::bigint, 0),
       coalesce((g.planning_usage->>'cacheWriteTokens')::bigint, 0),
       coalesce(g.planned_at, g.created_at)
FROM goals g
JOIN LATERAL (
  SELECT t.id, t.model FROM teammates t
  WHERE t.company_id = g.company_id AND (t.handle = 'peter' OR t.role ILIKE '%project manager%')
  ORDER BY (t.handle = 'peter') DESC, t.created_at LIMIT 1
) peter ON true
WHERE coalesce((g.planning_usage->>'inputTokens')::bigint, 0) + coalesce((g.planning_usage->>'outputTokens')::bigint, 0)
    + coalesce((g.planning_usage->>'cacheReadTokens')::bigint, 0) + coalesce((g.planning_usage->>'cacheWriteTokens')::bigint, 0) > 0;

-- And what org proposals spent: one row each, under the manager who drafted it, on the model its planner
-- names, else on that manager's model.
INSERT INTO planning_usage (company_id, teammate_id, purpose, model, calls,
                            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
SELECT d.company_id, d.created_by_id, 'org',
       CASE WHEN d.planner LIKE 'model:_%' THEN substr(d.planner, 7) ELSE coalesce(m.model, 'unknown') END,
       greatest(coalesce((d.usage->>'calls')::int, 1), 1),
       coalesce((d.usage->>'inputTokens')::bigint, 0),
       coalesce((d.usage->>'outputTokens')::bigint, 0),
       coalesce((d.usage->>'cacheReadTokens')::bigint, 0),
       coalesce((d.usage->>'cacheWriteTokens')::bigint, 0),
       d.created_at
FROM drafts d
LEFT JOIN teammates m ON m.id = d.created_by_id
WHERE d.created_by_kind = 'teammate'
  AND coalesce((d.usage->>'inputTokens')::bigint, 0) + coalesce((d.usage->>'outputTokens')::bigint, 0)
    + coalesce((d.usage->>'cacheReadTokens')::bigint, 0) + coalesce((d.usage->>'cacheWriteTokens')::bigint, 0) > 0;
