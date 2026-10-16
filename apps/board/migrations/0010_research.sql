-- Milestone 4: the research path. A research task's review checks that its
-- documents cite sources, alongside the diff checks.
ALTER TABLE review_checks DROP CONSTRAINT review_checks_kind_check;
ALTER TABLE review_checks ADD CONSTRAINT review_checks_kind_check
  CHECK (kind IN ('secrets', 'outputs', 'tests', 'evaluation', 'sources'));
