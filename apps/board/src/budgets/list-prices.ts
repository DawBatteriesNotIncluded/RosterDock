// Published list prices for the models teammates and Peter run on, so a
// company can fill its price table in one step instead of typing each row.
// What the same tokens cost on the Anthropic API, in US cents per million
// tokens, as the Claude API reference lists them on 2026-10-06: input,
// output, cache reads (the per-model rate where one is listed, 0.1x input
// otherwise) and cache writes (the 5-minute write, 1.25x input). On a
// subscription the plan is what is paid; these say what the work would cost
// on the API. Haiku 5.5's row is its price for prompts up to 100K tokens; a
// longer prompt costs five times as much, which one flat row cannot say.
// Models with no published price here (Codex's) are left to the person.

export interface ListPrice {
  model: string;
  currency: "USD";
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

const usd = (input: number, output: number, cacheRead: number): Omit<ListPrice, "model"> => ({
  currency: "USD",
  inputPerMillion: input,
  outputPerMillion: output,
  cacheReadPerMillion: cacheRead,
  cacheWritePerMillion: Math.round(input * 1.25),
});

export const LIST_PRICES: Record<string, Omit<ListPrice, "model">> = {
  "claude-fable-5-1": usd(1000, 5000, 25),
  "claude-opus-5-5": usd(400, 2000, 20),
  "claude-opus-5": usd(500, 2500, 50),
  "claude-sonnet-5-5": usd(200, 1000, 20),
  "claude-sonnet-5": usd(200, 1000, 20),
  "claude-haiku-5-5": usd(10, 50, 1),
  "claude-haiku-4-5": usd(100, 500, 10),
};

export function listPriceFor(model: string): ListPrice | null {
  const p = LIST_PRICES[model];
  return p ? { model, ...p } : null;
}
