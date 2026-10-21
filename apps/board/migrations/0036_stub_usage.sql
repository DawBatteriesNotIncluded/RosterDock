-- A run on the stub engine calls no model, but its usage was filed under the model its teammate names, so
-- Costs listed stub runs as, say, claude-sonnet-5-5, and priced them at that model's price. New runs count
-- under the stub (usageModel in src/budgets/cost.ts); the runs already recorded move there too, without the
-- cost the teammate's model gave them.

UPDATE run_usage u SET model = 'stub', cost_minor_units = NULL
FROM runs r
WHERE r.id = u.run_id AND r.engine = 'stub' AND u.model <> 'stub';

UPDATE runs SET cost_minor_units = NULL WHERE engine = 'stub' AND cost_minor_units IS NOT NULL;
