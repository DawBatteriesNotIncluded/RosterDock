-- An authorisation in flight names the authorization server it was started at, so a callback that arrives
-- after Authorise moved the connection to another one is refused: the code and the PKCE verifier were for
-- the first, and never go to the second. Null for an attempt started before this: checked as before.

ALTER TABLE oauth_starts ADD COLUMN issuer text;
