-- Backlog: sign-out at the provider. A session remembers how it was opened
-- ('dev', 'oidc'), so signing out of one opened by the identity provider can
-- send the browser to the provider's end_session_endpoint as well.
ALTER TABLE sessions ADD COLUMN provider text NOT NULL DEFAULT 'dev';
