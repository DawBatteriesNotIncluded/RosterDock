// Tokens to money. Prices are minor units (pence, cents) per million tokens;
// seat-billed models have no per-token price and cost nothing per run.

import type { RunUsage } from "@rosterdock/shared";

export interface ModelPrice {
  model: string;
  currency: string;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  seatPriceMonth: number | null;
}

export function totalTokens(u: Partial<RunUsage>): number {
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}

/** Cost of a run in minor units, or null when the model has no per-token price (seat billing or unknown). */
export function costFor(usage: Partial<RunUsage>, price: ModelPrice | null): number | null {
  if (!price) return null;
  const perToken = [
    [usage.inputTokens ?? 0, price.inputPerMillion],
    [usage.outputTokens ?? 0, price.outputPerMillion],
    [usage.cacheReadTokens ?? 0, price.cacheReadPerMillion ?? price.inputPerMillion],
    [usage.cacheWriteTokens ?? 0, price.cacheWritePerMillion ?? price.inputPerMillion],
  ] as const;
  if (perToken.every(([, p]) => p === null)) return null;
  let minor = 0;
  for (const [tokens, p] of perToken) if (p !== null) minor += (tokens * p) / 1_000_000;
  return Math.round(minor);
}
