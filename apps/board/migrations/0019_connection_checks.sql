-- Backlog: a connection health check from Settings. The last check's outcome
-- lives on the row so the page can say "checked 2 minutes ago, 14 tools, one
-- new" without asking the system again: {ok, at, latencyMs, error, tools:
-- {seen, missing, extra}}. Never a credential value; errors are scrubbed.
ALTER TABLE connections ADD COLUMN last_check jsonb;
