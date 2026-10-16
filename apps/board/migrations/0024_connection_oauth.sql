-- Backlog: OAuth on MCP connections. A connection may authorise against its
-- server's authorization server instead of naming an env var. The row keeps
-- what is not secret (the server, the client id, the scopes, when it was
-- authorised); the tokens live in the board's secret store under
-- rosterdock-connection-<id>. An authorisation in flight (the state, the PKCE
-- verifier, who started it) lives here between the redirect and the callback,
-- so any replica can finish it; consumed on callback, swept when expired.

ALTER TABLE connections ADD COLUMN oauth jsonb;

CREATE TABLE oauth_starts (
  state         text PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  code_verifier text NOT NULL,
  redirect_uri  text NOT NULL,
  return_to     text NOT NULL DEFAULT '/',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX oauth_starts_expires_idx ON oauth_starts (expires_at);
