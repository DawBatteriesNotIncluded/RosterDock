-- The built-in templates move to the current models: Opus 5.5 for Peter, Verifier, Archy and Finn, Sonnet 5.5
-- for the rest. Opus 5.5 is also cheaper than the Opus 5 they were seeded with. Only a row still on its seeded
-- model moves. Teammates already hired keep their model until someone edits them.

UPDATE teammate_templates SET model = 'claude-opus-5-5'
WHERE company_id IS NULL AND model = 'claude-opus-5' AND id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000009'
);

UPDATE teammate_templates SET model = 'claude-sonnet-5-5'
WHERE company_id IS NULL AND model = 'claude-sonnet-5' AND id IN (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-000000000008'
);

-- Nothing ever read an engine's default model: a teammate's model comes from its template or the hire form.
ALTER TABLE engines DROP COLUMN default_model;
