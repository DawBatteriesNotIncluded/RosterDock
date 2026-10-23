-- A task says which goal it serves: the goal Peter planned it for, the goal of the task a teammate filed it
-- from, or the goal its project was opened for. A goal's caps, stop, close, result, spend and token cap
-- count its own tasks, not whatever else is in its project.
ALTER TABLE tasks ADD COLUMN goal_id uuid REFERENCES goals(id) ON DELETE SET NULL;
-- Until now a goal had its project to itself, and every task in it was the goal's.
UPDATE tasks t SET goal_id = g.id FROM goals g WHERE g.project_id = t.project_id;
CREATE INDEX tasks_goal_idx ON tasks (goal_id) WHERE goal_id IS NOT NULL;

-- A goal's token cap is a lifetime budget on the goal, no longer on its project.
ALTER TABLE budgets DROP CONSTRAINT budgets_scope_kind_check;
ALTER TABLE budgets ADD CONSTRAINT budgets_scope_kind_check
  CHECK (scope_kind IN ('company', 'department', 'project', 'teammate', 'goal'));
UPDATE budgets b SET scope_kind = 'goal', scope_id = g.id, updated_at = now() FROM goals g
  WHERE b.scope_kind = 'project' AND b.window_kind = 'goal' AND b.scope_id = g.project_id
    AND b.company_id = g.company_id;
