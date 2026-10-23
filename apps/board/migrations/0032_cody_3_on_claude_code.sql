-- The built-in 'Cody 3' template ran on OpenCode, which no worker can run yet (docs/backlog.md), so every run
-- of a teammate hired from it failed at once. It runs on Claude Code, as the GTM company template already has
-- it. A teammate already hired on OpenCode keeps it until someone picks another engine.

UPDATE teammate_templates SET engine = 'claude_code'
WHERE id = '00000000-0000-4000-8000-000000000008' AND company_id IS NULL AND engine = 'opencode';
