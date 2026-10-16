-- Milestone 5: connections and toolboxes. A connection is an external system
-- the board can reach: an MCP server over HTTP or stdio, or an OpenAPI
-- service. Credentials are env var NAMES the board resolves at call time.
-- A teammate's toolbox names connections with a mode each (the ceiling); a
-- project's client policy caps them (it only narrows).

CREATE TABLE connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The short name toolboxes and approvals use: hubspot, slack, xero.
  name           text NOT NULL,
  -- The catalog entry it was added from, when it was.
  catalog_id     text,
  kind           text NOT NULL DEFAULT 'mcp' CHECK (kind IN ('mcp', 'openapi')),
  transport      text NOT NULL DEFAULT 'http' CHECK (transport IN ('http', 'stdio')),
  url            text,
  command        text,
  args           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Env var NAME on the board: the bearer token (http) or handed to the child (stdio). Never a value.
  auth_env_name  text,
  -- More env var NAMES handed to a stdio child.
  env_names      jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled        boolean NOT NULL DEFAULT true,
  -- The connection's tools: [{name, description, write, source}]. Discovery replaces them; a person may reclassify.
  tools          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- OpenAPI: the manifest the runtime enforces (operations, auth header, limits).
  manifest       jsonb,
  discovered_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- [{connection, mode}] with mode off, read or ask. The ceiling; policy narrows from here.
ALTER TABLE teammates ADD COLUMN toolbox jsonb NOT NULL DEFAULT '[]'::jsonb;
-- {default, caps: {connection: mode}}: what this client lets any teammate do. Only narrows.
ALTER TABLE projects ADD COLUMN client_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
-- The connection an approval is bound to, when it still exists (the name stays either way).
ALTER TABLE approvals ADD COLUMN connection_id uuid REFERENCES connections(id) ON DELETE SET NULL;
