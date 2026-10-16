-- How hard a teammate's model thinks: Claude Code's --effort, Codex's
-- model_reasoning_effort, the API's output_config.effort. Null: the engine's
-- own default. A template carries one for the teammates made from it.
ALTER TABLE teammates ADD COLUMN effort text
  CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
ALTER TABLE teammate_templates ADD COLUMN effort text
  CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
