-- A proposal replaced by a newer one from the same task for the same write (connection, tool, target)
-- while it waited: it can no longer be approved, and it names what replaced it.
ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'superseded'));
ALTER TABLE approvals ADD COLUMN superseded_by uuid REFERENCES approvals(id) ON DELETE SET NULL;
