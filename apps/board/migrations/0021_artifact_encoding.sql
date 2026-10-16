-- Backlog: pull requests for diffs that carry binary files. A binary artifact
-- is stored as the base64 text the worker sent, and the row says so; readers
-- decode by encoding. Text artifacts are as before.
ALTER TABLE artifacts ADD COLUMN encoding text NOT NULL DEFAULT 'utf8' CHECK (encoding IN ('utf8', 'base64'));
