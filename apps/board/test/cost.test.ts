import { describe, expect, it } from "vitest";
import { costFor, totalTokens, type ModelPrice } from "../src/budgets/cost.js";

const sonnet: ModelPrice = {
  model: "claude-sonnet-5",
  currency: "GBP",
  inputPerMillion: 240, // £2.40 per million
  outputPerMillion: 1200,
  cacheReadPerMillion: 24,
  cacheWritePerMillion: 300,
  seatPriceMonth: null,
};

describe("costFor", () => {
  it("prices each token class and rounds to minor units", () => {
    const cost = costFor(
      { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 },
      sonnet,
    );
    // 240 + 120 + 48 = 408 pence
    expect(cost).toBe(408);
  });

  it("falls back to the input price for cache classes when they are not priced", () => {
    const cost = costFor({ cacheReadTokens: 1_000_000 }, { ...sonnet, cacheReadPerMillion: null });
    expect(cost).toBe(240);
  });

  it("is null for seat-billed or unknown models", () => {
    expect(costFor({ inputTokens: 5 }, null)).toBeNull();
    expect(
      costFor(
        { inputTokens: 5 },
        {
          ...sonnet,
          inputPerMillion: null,
          outputPerMillion: null,
          cacheReadPerMillion: null,
          cacheWritePerMillion: null,
          seatPriceMonth: 10_000,
        },
      ),
    ).toBeNull();
  });

  it("sums total tokens", () => {
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(
      10,
    );
    expect(totalTokens({})).toBe(0);
  });
});
