-- Backlog: a veto closes the pull request the approval opened. A fourth
-- state and when it happened; the provider's answer, if it refused, stays in
-- error with the row still 'opened' so a person can close it by hand.
ALTER TABLE pull_requests DROP CONSTRAINT pull_requests_status_check;
ALTER TABLE pull_requests ADD CONSTRAINT pull_requests_status_check
  CHECK (status IN ('proposed', 'opened', 'failed', 'closed'));
ALTER TABLE pull_requests ADD COLUMN closed_at timestamptz;
