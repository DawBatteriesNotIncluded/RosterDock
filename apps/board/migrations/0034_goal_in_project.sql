-- A goal can go into a project that exists instead of opening one, so a project can carry many goals.
-- opened_project: the goal opened its project (and names it after its plan) rather than joining one; a task
-- filed by hand into a project a goal opened serves that goal. At most one goal opens a project.
ALTER TABLE goals ADD COLUMN opened_project boolean NOT NULL DEFAULT true;
ALTER TABLE goals DROP CONSTRAINT goals_project_id_key;
CREATE INDEX goals_project_idx ON goals (project_id);
CREATE UNIQUE INDEX goals_opened_project_key ON goals (project_id) WHERE opened_project;
