// Prices and usage by model provider: a price belongs to a provider and a model, or to the board's own models;
// a call through a provider takes its provider's price, else the company's for the model on the board's own
// models, else (an Anthropic provider, in the list's currency) the list price, else none. A company keeps one
// currency. Costs, the monthly report and both CSVs say which provider the tokens went through. Usage through a
// provider is recorded the way a manager's call records it; no model, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bedrockListModel, BOARD_OWN_MODELS, priceFor, priceTable } from "../src/budgets/prices.js";
import { recordPlanningUsage } from "../src/budgets/usage.js";
import { seatedPeter, seedCompany, startTestBoard, type Api, type TestBoard } from "./helpers.js";

let board: TestBoard;
beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

async function providers(api: Api, base: string) {
  const anthropic = (
    await api.post(`${base}/model-providers`, {
      kind: "anthropic",
      name: "acme",
      label: "Acme Anthropic",
      credentials: { apiKey: "MODELS_ACME_KEY" },
      models: [
        { id: "claude-opus-5-5", family: "claude" },
        { id: "claude-sonnet-5-5", family: "claude" },
        { id: "claude-preview-x", family: "claude" },
      ],
    })
  ).body;
  const bedrock = (
    await api.post(`${base}/model-providers`, {
      kind: "bedrock",
      name: "acme-bedrock",
      label: "Acme Bedrock",
      region: "us-east-1",
      credentials: { bearerToken: "MODELS_ACME_BEDROCK_KEY" },
      models: [
        { id: "us.anthropic.claude-sonnet-5-5-v1:0", family: "claude" },
        { id: "global.openai.example-model", family: "openai" },
      ],
    })
  ).body;
  const openai = (
    await api.post(`${base}/model-providers`, {
      kind: "openai",
      name: "acme-openai",
      label: "Acme OpenAI",
      credentials: { apiKey: "MODELS_ACME_OPENAI_KEY" },
      models: [{ id: "gpt-x", family: "openai" }],
    })
  ).body;
  return { anthropic, bedrock, openai };
}

const companyOf = (base: string) => base.split("/").pop()!;

describe("prices by provider", () => {
  it("prices the same model apart per provider, and falls back to the board's own price", async () => {
    const { api, base } = await seedCompany(board, "pp1@example.com");
    const { anthropic, bedrock } = await providers(api, base);
    const own = await api.put(`${base}/prices`, {
      model: "claude-sonnet-5-5",
      currency: "USD",
      inputPerMillion: 300,
      outputPerMillion: 1500,
    });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ providerId: null, estimate: false });
    const theirs = await api.put(`${base}/prices`, {
      model: "claude-sonnet-5-5",
      providerId: anthropic.id,
      currency: "USD",
      inputPerMillion: 200,
      outputPerMillion: 1000,
    });
    expect(theirs.status).toBe(200);
    expect(theirs.body.providerId).toBe(anthropic.id);
    // Both rows stand: the same id, two providers.
    expect((await api.get(`${base}/prices`)).body.map((p: any) => [p.model, p.providerId])).toEqual([
      ["claude-sonnet-5-5", null],
      ["claude-sonnet-5-5", anthropic.id],
    ]);

    const companyId = companyOf(base);
    const price = (providerId: string | null, model: string) =>
      priceFor(board.db, companyId, providerId, model);
    expect((await price(anthropic.id, "claude-sonnet-5-5"))?.inputPerMillion).toBe(200);
    expect((await price(null, "claude-sonnet-5-5"))?.inputPerMillion).toBe(300);
    // No price of Bedrock's own: the board's own price for the same id.
    expect((await price(bedrock.id, "claude-sonnet-5-5"))?.inputPerMillion).toBe(300);
    // No price anywhere, but an Anthropic provider bills at the list price, in the list's currency.
    expect((await price(anthropic.id, "claude-opus-5-5"))?.inputPerMillion).toBe(400);
    expect(await price(null, "claude-opus-5-5")).toBeNull();
    expect(await price(bedrock.id, "claude-opus-5-5")).toBeNull();
    expect(await price(anthropic.id, "claude-preview-x")).toBeNull();
    // The table every report reads gives the same answers.
    const table = await priceTable(board.db, companyId);
    expect(table.priceOf(anthropic.id, "claude-sonnet-5-5")?.inputPerMillion).toBe(200);
    expect(table.priceOf(bedrock.id, "claude-sonnet-5-5")?.inputPerMillion).toBe(300);
    expect(table.priceOf(anthropic.id, "claude-opus-5-5")?.inputPerMillion).toBe(400);
    expect(table.providerLabel(null)).toBe(BOARD_OWN_MODELS);
    expect(table.providerLabel(anthropic.id)).toBe("Acme Anthropic");

    // A provider bills per token, never a seat; and a provider must be the company's.
    expect(
      (await api.put(`${base}/prices`, { model: "gpt-x", providerId: anthropic.id, seatPriceMonth: 2000 }))
        .status,
    ).toBe(400);
    const other = await seedCompany(board, "pp1-other@example.com");
    expect(
      (
        await other.api.put(`${other.base}/prices`, {
          model: "claude-sonnet-5-5",
          providerId: anthropic.id,
          currency: "USD",
          inputPerMillion: 1,
        })
      ).status,
    ).toBe(404);

    // Removing a provider removes its prices; the board's own stay.
    expect((await api.del(`${base}/model-providers/${anthropic.id}`)).status).toBe(200);
    expect((await api.get(`${base}/prices`)).body.map((p: any) => p.providerId)).toEqual([null]);
    expect((await priceTable(board.db, companyId)).providerLabel(anthropic.id)).toBe("A removed provider");
  });

  it("keeps one currency per company, and no list price in another one", async () => {
    const { api, base } = await seedCompany(board, "pp2@example.com");
    const { anthropic } = await providers(api, base);
    expect(
      (await api.put(`${base}/prices`, { model: "claude-opus-5-5", currency: "GBP", inputPerMillion: 320 }))
        .status,
    ).toBe(200);
    const usd = await api.put(`${base}/prices`, {
      model: "claude-opus-5-5",
      providerId: anthropic.id,
      currency: "USD",
      inputPerMillion: 400,
    });
    expect(usd.status).toBe(409);
    expect(usd.body.error).toBe(
      "this company's prices are in GBP, and a company keeps one currency; give this price in GBP",
    );
    // Replacing the one price in another currency is not a second currency.
    expect(
      (await api.put(`${base}/prices`, { model: "claude-opus-5-5", currency: "EUR", inputPerMillion: 370 }))
        .status,
    ).toBe(200);
    // An Anthropic provider's list price is in USD: a EUR company has none, so no price, never a mixed one.
    expect(await priceFor(board.db, companyOf(base), anthropic.id, "claude-sonnet-5-5")).toBeNull();
    const fill = await api.post(`${base}/prices/list`, { providerId: anthropic.id });
    expect(fill.status).toBe(409);
    expect(fill.body.error).toContain("list prices are in USD, and this company's prices are in EUR");
  });

  it("fills list prices for a provider's Claude models: Anthropic's at the list, Bedrock's as an estimate", async () => {
    const { api, base } = await seedCompany(board, "pp3@example.com");
    const { anthropic, bedrock, openai } = await providers(api, base);
    const a = await api.post(`${base}/prices/list`, { providerId: anthropic.id });
    expect(a.body).toEqual({
      added: ["claude-opus-5-5", "claude-sonnet-5-5"],
      unknown: ["claude-preview-x"],
    });
    const b = await api.post(`${base}/prices/list`, { providerId: bedrock.id });
    expect(b.body).toEqual({ added: ["us.anthropic.claude-sonnet-5-5-v1:0"], unknown: [] });
    const rows = (await api.get(`${base}/prices`)).body as any[];
    expect(rows.find((p) => p.providerId === bedrock.id)).toMatchObject({
      model: "us.anthropic.claude-sonnet-5-5-v1:0",
      estimate: true,
      currency: "USD",
      inputPerMillion: 200,
    });
    expect(rows.filter((p) => p.providerId === anthropic.id).every((p) => !p.estimate)).toBe(true);
    // OpenAI publishes no list here: nothing to fill, nothing refused.
    expect((await api.post(`${base}/prices/list`, { providerId: openai.id })).body).toEqual({
      added: [],
      unknown: [],
    });
    // A price a person types over an estimate is theirs.
    const typed = await api.put(`${base}/prices`, {
      model: "us.anthropic.claude-sonnet-5-5-v1:0",
      providerId: bedrock.id,
      currency: "USD",
      inputPerMillion: 220,
    });
    expect(typed.body).toMatchObject({ estimate: false, inputPerMillion: 220 });
    // A provider's model id is kept as the provider takes it, never put Claude Code's way.
    const compatible = (
      await api.post(`${base}/model-providers`, {
        kind: "openai_compatible",
        name: "router",
        label: "Router",
        endpoint: "https://router.example.test/v1",
        models: [{ id: "claude-3.7-sonnet", family: "claude" }],
      })
    ).body;
    const kept = await api.put(`${base}/prices`, {
      model: "claude-3.7-sonnet",
      providerId: compatible.id,
      currency: "USD",
      inputPerMillion: 1,
    });
    expect(kept.body.model).toBe("claude-3.7-sonnet");
    expect(bedrockListModel("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5");
    expect(bedrockListModel("anthropic.claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("reports costs by provider, each model with its provider, and says the provider in both CSVs", async () => {
    const { api, base } = await seedCompany(board, "pp4@example.com");
    const { anthropic } = await providers(api, base);
    const companyId = companyOf(base);
    const peter = await seatedPeter(api, base);
    await api.put(`${base}/prices`, {
      model: "claude-opus-5-5",
      currency: "USD",
      inputPerMillion: 500,
      outputPerMillion: 2500,
    });
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // Peter plans twice on the same model: once on the board's own, once through the company's Anthropic.
    await recordPlanningUsage(board.db, {
      companyId,
      teammateId: peter.id,
      purpose: "org",
      model: "claude-opus-5-5",
      usage,
    });
    await recordPlanningUsage(board.db, {
      companyId,
      teammateId: peter.id,
      purpose: "org",
      providerId: anthropic.id,
      model: "claude-opus-5-5",
      usage,
    });

    const r = (await api.get(`${base}/costs?window=week`)).body;
    // Through Acme it is priced at the board's own price for the model, as nothing of Acme's is set.
    const byName = (a: any, b: any) => String(a[1]).localeCompare(String(b[1]));
    expect(
      r.byProvider.map((p: any) => [p.id, p.name, p.kind, p.calls, p.costMinorUnits]).sort(byName),
    ).toEqual([
      [anthropic.id, "Acme Anthropic", "anthropic", 1, 750],
      [null, BOARD_OWN_MODELS, null, 1, 750],
    ]);
    expect(r.byModel.map((m: any) => [m.model, m.provider, m.calls]).sort(byName)).toEqual([
      ["claude-opus-5-5", "Acme Anthropic", 1],
      ["claude-opus-5-5", BOARD_OWN_MODELS, 1],
    ]);
    // Acme's own price, once set, is what Acme's tokens cost.
    await api.put(`${base}/prices`, {
      model: "claude-opus-5-5",
      providerId: anthropic.id,
      currency: "USD",
      inputPerMillion: 400,
      outputPerMillion: 2000,
    });
    const again = (await api.get(`${base}/costs?window=week`)).body;
    expect(again.byProvider.find((p: any) => p.id === anthropic.id).costMinorUnits).toBe(600);
    expect(again.totals.costMinorUnits).toBe(750 + 600);

    const month = (await api.get(`${base}/costs/monthly`)).body;
    expect(month.byProvider.map((p: any) => [p.costMinorUnits, p.name]).sort(byName)).toEqual([
      [600, "Acme Anthropic"],
      [750, BOARD_OWN_MODELS],
    ]);
    const csv = await board.app.inject({
      method: "GET",
      url: `${base}/costs/export.csv?window=week`,
      headers: { authorization: `Bearer ${(await board.login("pp4@example.com")).token}` },
    });
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]!.split(",").at(-1)).toBe("provider");
    expect(
      lines
        .slice(1)
        .map((l) => l.split(",").at(-1))
        .sort(),
    ).toEqual(["Acme Anthropic", "This board's own models"]);
  });
});
