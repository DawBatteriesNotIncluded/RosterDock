-- A planning pass claims its goal. The request that opened a goal and Peter's
-- loop (or another board replica) can both reach a goal in planning, and a
-- model call can take most of a minute; without a claim both planned it and
-- the goal got its tasks twice. The first to set this plans; the others leave
-- the goal alone until the pass clears it, or until the claim is ten minutes
-- old (a planner that died mid-call).
ALTER TABLE goals ADD COLUMN planning_since timestamptz;
