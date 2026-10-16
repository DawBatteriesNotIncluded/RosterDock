-- Basic sandbox preset per department, applied to the worker for every run of
-- a task in that department. Keys: allowedTools (engine tool allowlist),
-- envNames (env var NAMES the engine may see, narrowing the worker's own list),
-- timeoutSeconds. Names only; never values. Network policies arrive in M6.
ALTER TABLE departments ADD COLUMN sandbox jsonb NOT NULL DEFAULT '{}'::jsonb;
