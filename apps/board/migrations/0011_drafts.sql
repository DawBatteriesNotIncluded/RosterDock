-- Milestone 4: Peter as company architect. What he proposes is a draft a
-- person accepts: departments, teammates, toolboxes and policies (org), or
-- findings about the company as it stands (audit). Peter never grants a tool.

CREATE TABLE drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('org', 'audit')),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected')),
  -- What the person asked for (org), or empty (audit).
  brief           text NOT NULL DEFAULT '',
  -- OrgProposal or AuditReport from apps/board/src/peter/architect.ts.
  proposal        jsonb NOT NULL,
  -- How Peter produced it: model or heuristic.
  planner         text,
  usage           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'teammate')),
  created_by_id   uuid NOT NULL,
  decided_by_kind text CHECK (decided_by_kind IN ('user', 'teammate')),
  decided_by_id   uuid,
  decided_at      timestamptz,
  -- What accepting created: {departments: [{id, name}], teammates: [{id, name}]}.
  outcome         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drafts_company_idx ON drafts (company_id, status, created_at DESC);
