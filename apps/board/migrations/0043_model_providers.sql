-- Company model providers: a company's own model account, which its teammates may think with instead of the
-- board's own models (docs/plan.html, Company model providers). Credentials are env var NAMES the board alone
-- resolves, from the company's secrets or the names the operator shares; never a value. Which kinds a company
-- may add is the operator's (ROSTERDOCK_MODEL_PROVIDERS), checked when a provider is written and when it is used.

CREATE TABLE model_providers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Short and unique in the company: acme-azure.
  name           text NOT NULL,
  -- What people read: Acme Azure (prod).
  label          text NOT NULL,
  kind           text NOT NULL
    CHECK (kind IN ('anthropic', 'openai', 'azure_openai', 'bedrock', 'openai_compatible')),
  -- azure_openai: https://<resource>.openai.azure.com or .services.ai.azure.com (the board adds /openai/v1);
  -- openai_compatible: the server's base URL. Null for the kinds whose hosts are fixed or come from the region.
  endpoint       text,
  -- bedrock only: the AWS region it is reached in.
  region         text,
  -- openai_compatible only: the header its key goes in (authorization, api-key, x-api-key); null without a key.
  auth_header    text CHECK (auth_header IN ('authorization', 'api-key', 'x-api-key')),
  -- {role: env var NAME}: apiKey, or bearerToken for bedrock. Never a value.
  credentials    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{id, label, family, source, contextWindow}]: the models it serves, at most 200.
  models         jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled        boolean NOT NULL DEFAULT true,
  -- The last check of its key and models, in the board's words.
  last_check     jsonb,
  -- Archived: kept with its history, used by nothing.
  archived_at    timestamptz,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'teammate')),
  created_by_id  uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  CHECK ((kind IN ('azure_openai', 'openai_compatible')) = (endpoint IS NOT NULL)),
  CHECK ((kind = 'bedrock') = (region IS NOT NULL)),
  CHECK (kind = 'openai_compatible' OR auth_header IS NULL)
);
