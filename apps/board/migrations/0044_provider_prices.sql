-- Prices and usage by model provider. A price belongs to a provider and a model, or, with no provider, to
-- the board's own models as before: the same model id costs what each provider charges. A run or a call
-- with no price of its provider's takes the company's price for that model on the board's own models.
-- Usage keeps the provider it went through (none: the board's own models), so Costs can say by provider.
-- A seat price is the board's own models' alone: a provider bills per token.

ALTER TABLE model_prices ADD COLUMN provider_id uuid REFERENCES model_providers(id) ON DELETE CASCADE;
-- A price the board filled from another's list (a Bedrock Claude model at Anthropic's price): check it.
ALTER TABLE model_prices ADD COLUMN estimate boolean NOT NULL DEFAULT false;
ALTER TABLE model_prices ADD CONSTRAINT model_prices_seat_board_only
  CHECK (provider_id IS NULL OR seat_price_month IS NULL);
ALTER TABLE model_prices DROP CONSTRAINT model_prices_company_id_model_key;
CREATE UNIQUE INDEX model_prices_scope ON model_prices (company_id, provider_id, model) NULLS NOT DISTINCT;

-- Kept when the provider goes: the history stays, priced at the board's own price for the model.
ALTER TABLE run_usage ADD COLUMN provider_id uuid;
ALTER TABLE planning_usage ADD COLUMN provider_id uuid;
