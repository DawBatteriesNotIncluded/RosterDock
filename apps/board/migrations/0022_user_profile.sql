-- Backlog: the provider's user record beyond name and email. What the id_token
-- says about the person (picture, username, given and family names, locale)
-- as the provider last said it, refreshed on every sign-in. Never a token.
ALTER TABLE users ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb;
