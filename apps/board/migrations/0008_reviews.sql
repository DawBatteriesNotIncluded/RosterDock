-- Milestone 3: the review object. One review per task, advanced a round each
-- time the author's run completes. Comments anchor to file, hunk and line.
-- An approved review is the only thing that marks a task Done.

-- Weighted acceptance criteria the reviewer scores: [{text, weight}].
ALTER TABLE tasks ADD COLUMN criteria jsonb NOT NULL DEFAULT '[]'::jsonb;

-- HEAD of the clone a run's diff was taken against.
ALTER TABLE runs ADD COLUMN base_sha text;
-- A reviewer teammate works a review in a run of kind 'review' (like a turn, it never moves the task).
ALTER TABLE runs DROP CONSTRAINT runs_kind_check;
ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('task', 'turn', 'review'));

CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- The run whose diff is under review (the latest round).
  run_id          uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  round           integer NOT NULL DEFAULT 1,
  author_kind     text NOT NULL CHECK (author_kind IN ('user', 'teammate')),
  author_id       uuid NOT NULL,
  reviewer_kind   text CHECK (reviewer_kind IN ('user', 'teammate')),
  reviewer_id     uuid,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'changes_requested', 'approved')),
  diff_sha256     text NOT NULL,
  base_sha        text,
  -- Evaluation against the task's criteria: [{index, text, weight, score, note}].
  scores          jsonb,
  -- The last decision's note.
  summary         text,
  decided_at      timestamptz,
  decided_by_kind text CHECK (decided_by_kind IN ('user', 'teammate')),
  decided_by_id   uuid,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id)
);
CREATE INDEX reviews_company_status_idx ON reviews (company_id, status, opened_at DESC);

-- Files of the round under review, hunks and numbered lines as parsed from the diff artifact.
CREATE TABLE review_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id  uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  round      integer NOT NULL,
  position   integer NOT NULL,
  path       text NOT NULL,
  status     text NOT NULL CHECK (status IN ('added', 'modified', 'deleted')),
  is_binary  boolean NOT NULL DEFAULT false,
  additions  integer NOT NULL DEFAULT 0,
  deletions  integer NOT NULL DEFAULT 0,
  hunks      jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (review_id, round, path)
);

CREATE TABLE review_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id   uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  round       integer NOT NULL,
  file_path   text NOT NULL,
  hunk_index  integer NOT NULL,
  -- Anchor within the hunk: a new-side or old-side line number; both null for the whole hunk.
  line_new    integer,
  line_old    integer,
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'teammate')),
  author_id   uuid NOT NULL,
  body        text NOT NULL,
  resolved    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_comments_review_idx ON review_comments (review_id, created_at);

CREATE TABLE review_decisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id    uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  round        integer NOT NULL,
  decider_kind text NOT NULL CHECK (decider_kind IN ('user', 'teammate')),
  decider_id   uuid NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('approve', 'request_changes', 'veto')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_decisions_review_idx ON review_decisions (review_id, created_at);

-- Checks on a round: secret scan, declared outputs, the repository's tests, the criteria evaluation.
CREATE TABLE review_checks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id  uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  round      integer NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('secrets', 'outputs', 'tests', 'evaluation')),
  -- null: not run (no test script, nothing declared, not scored yet).
  ok         boolean,
  title      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, round, kind)
);

-- The pull request an approval opens: a proposed external write bound to the
-- sha256 of its exact payload, executed against the git host.
CREATE TABLE pull_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id      uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  task_id        uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider       text NOT NULL DEFAULT 'github',
  repo           text NOT NULL,
  base_branch    text NOT NULL,
  head_branch    text NOT NULL,
  payload        jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  status         text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'opened', 'failed')),
  number         integer,
  url            text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  executed_at    timestamptz
);
CREATE INDEX pull_requests_review_idx ON pull_requests (review_id, created_at DESC);
