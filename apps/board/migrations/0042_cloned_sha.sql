-- The commit a run's clone was at, as the worker reported it after cloning and before the engine ran. Kept once
-- per attempt (a claim clears it): a pull request is built only on it, so a run that checked out another ref,
-- or committed, never carries commits its review did not show.
ALTER TABLE runs ADD COLUMN cloned_sha text;
