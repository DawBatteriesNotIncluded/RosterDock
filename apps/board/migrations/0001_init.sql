-- RosterDock schema, migration 0001. Every row carries company_id (users are the
-- one exception: a person can belong to several companies through
-- memberships). Actors are (kind, id) pairs where kind is 'user' or 'teammate'.

CREATE TABLE companies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  template           text,
  budget_tokens_week bigint,
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Per-company allocators. Row-locked in the writing transaction so event seq
-- and task numbers are dense and monotonic per company.
CREATE TABLE company_counters (
  company_id       uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  next_event_seq   bigint NOT NULL DEFAULT 1,
  next_task_number integer NOT NULL DEFAULT 1
);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  name         text NOT NULL,
  oidc_subject text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_oidc_subject_key ON users (oidc_subject) WHERE oidc_subject IS NOT NULL;

CREATE TABLE memberships (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'reviewer', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Templates with a NULL company_id are global (seeded); others belong to one company.
CREATE TABLE teammate_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  name       text NOT NULL,
  role       text NOT NULL,
  persona_md text NOT NULL DEFAULT '',
  playbooks  jsonb NOT NULL DEFAULT '[]'::jsonb,
  engine     text NOT NULL CHECK (engine IN ('claude_code', 'codex', 'opencode')),
  model      text NOT NULL,
  avatar     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teammates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id uuid REFERENCES teammate_templates(id) ON DELETE SET NULL,
  name        text NOT NULL,
  -- @mention handle: the name lowercased with non-alphanumerics removed. Unique per company.
  handle      text NOT NULL,
  role        text NOT NULL,
  persona_md  text NOT NULL DEFAULT '',
  playbooks   jsonb NOT NULL DEFAULT '[]'::jsonb,
  engine      text NOT NULL CHECK (engine IN ('claude_code', 'codex', 'opencode')),
  model       text NOT NULL,
  avatar      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, handle)
);

CREATE TABLE departments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug             text NOT NULL,
  name             text NOT NULL,
  write_policy     text NOT NULL DEFAULT 'ask' CHECK (write_policy IN ('readonly', 'drafts', 'ask')),
  lead_teammate_id uuid REFERENCES teammates(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug)
);

CREATE TABLE department_members (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  teammate_id   uuid NOT NULL REFERENCES teammates(id) ON DELETE CASCADE,
  is_lead       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, teammate_id)
);
CREATE INDEX department_members_teammate_idx ON department_members (company_id, teammate_id);

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       text NOT NULL,
  client     text NOT NULL DEFAULT 'Internal',
  goal       text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_company_idx ON projects (company_id);

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES departments(id) ON DELETE SET NULL,
  -- Human-facing number, dense per company (#144).
  number          integer NOT NULL,
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'blocked', 'review', 'done')),
  assignee_kind   text CHECK (assignee_kind IN ('user', 'teammate')),
  assignee_id     uuid,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'teammate')),
  created_by_id   uuid NOT NULL,
  -- BlockerRecord from @rosterdock/shared while status = 'blocked'.
  blocker         jsonb,
  -- Who or what marked it done (an approved review from M3). Null until then.
  done_by         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  CHECK ((assignee_kind IS NULL) = (assignee_id IS NULL)),
  CHECK ((status = 'blocked') = (blocker IS NOT NULL))
);
CREATE INDEX tasks_company_project_idx ON tasks (company_id, project_id);
CREATE INDEX tasks_company_status_idx ON tasks (company_id, status);
CREATE INDEX tasks_assignee_idx ON tasks (company_id, assignee_kind, assignee_id);

CREATE TABLE task_dependencies (
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX task_dependencies_reverse_idx ON task_dependencies (depends_on_task_id);

CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'teammate')),
  author_id   uuid NOT NULL,
  body        text NOT NULL,
  -- Resolved @mentions: [{kind:'teammate', id, handle}]
  mentions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_task_idx ON messages (task_id, created_at);

-- The one event stream. Activity, office and map are projections of this table.
CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  seq          bigint NOT NULL,
  type         text NOT NULL,
  actor_kind   text CHECK (actor_kind IN ('user', 'teammate')),
  actor_id     uuid,
  subject_kind text,
  subject_id   uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, seq)
);
CREATE INDEX events_subject_idx ON events (company_id, subject_kind, subject_id, seq);

-- Browser sessions for users. Only the sha256 of the token is stored.
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bearer tokens for teammates (and, later, run-scoped tokens). Hash only.
CREATE TABLE api_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_kind         text NOT NULL CHECK (actor_kind IN ('user', 'teammate')),
  actor_id           uuid NOT NULL,
  token_hash         text NOT NULL UNIQUE,
  label              text,
  scopes             jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at         timestamptz NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz
);
CREATE INDEX api_tokens_actor_idx ON api_tokens (company_id, actor_kind, actor_id);
