-- The commit a run's clone was at, as the worker reported it after cloning and before the engine ran. Kept once
-- per attempt (a claim clears it): a pull request is built only on it, so a run that checked out another ref,
-- or committed, never carries commits its review did not show. The report carries a key the claim gave the
-- worker alone (its sha256 here), so the engine, which holds the run's token, cannot make it.
ALTER TABLE runs ADD COLUMN cloned_sha text;
ALTER TABLE runs ADD COLUMN clone_key_sha256 text;
