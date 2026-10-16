-- A task can be closed without being Done: a person cancels it, or stopping its goal does.
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo', 'doing', 'blocked', 'review', 'done', 'cancelled'));
