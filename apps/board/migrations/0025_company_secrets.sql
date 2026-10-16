-- Company secrets. A person sets a credential's value from Settings instead of
-- on the board's environment; the value goes, write-only, into the board's
-- secret store under rosterdock-company-<id> (one key per name) and is never read
-- back by any route. This table keeps what is not secret: the names, when each
-- was set and by whom, so the panel can list them and the deletion has a row
-- to remove. Names resolve for that company's connections before the board's
-- own environment.

CREATE TABLE company_secrets (
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_kind text NOT NULL,
  updated_by_id   text NOT NULL,
  PRIMARY KEY (company_id, name)
);
