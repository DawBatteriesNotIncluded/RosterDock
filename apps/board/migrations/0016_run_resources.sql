-- Milestone 6: the worker reports its pod's CPU and memory with each heartbeat,
-- so the live process panel shows what a running teammate costs the cluster.
-- {cpuMillis, memoryBytes}; the last sample only.
ALTER TABLE runs ADD COLUMN resources jsonb;
