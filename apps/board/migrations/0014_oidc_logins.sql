-- Milestone 6: OpenID Connect sign-in. A login attempt (state, nonce, PKCE
-- verifier) lives here between the redirect to the provider and the callback,
-- so any board replica can finish it. Rows are consumed on callback and swept
-- when they expire. Users keep only the provider's subject (users.oidc_subject).

CREATE TABLE oidc_logins (
  state         text PRIMARY KEY,
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  return_to     text NOT NULL DEFAULT '/',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX oidc_logins_expires_idx ON oidc_logins (expires_at);
