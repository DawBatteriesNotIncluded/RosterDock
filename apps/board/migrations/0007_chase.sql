-- Turns and chasing. A message remembers the run it was written in, so the
-- board can tell a reply from a fresh question (loop prevention). A task
-- remembers when it was last chased so Peter does not nag.
ALTER TABLE messages ADD COLUMN run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN last_chased_at timestamptz;
