-- Milestone 6: worker pools per department. A department's sandbox may name a
-- pool; its tasks' runs go on the pool's queue (runs.<pool>) and only workers
-- in that pool, with that pool's network policy, take them. The run remembers
-- its queue so the reaper and a stop find the job where it is.
ALTER TABLE runs ADD COLUMN queue_name text NOT NULL DEFAULT 'runs';
