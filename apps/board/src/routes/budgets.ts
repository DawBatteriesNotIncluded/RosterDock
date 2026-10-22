// Budgets and the per-model price table, per company.
import { BudgetInputSchema, ListPricesInputSchema, ModelPriceInputSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import { BUDGET_WINDOWS, type BudgetWindow } from "@rosterdock/shared";
import { STUB_MODEL } from "../budgets/cost.js";
import { costReport } from "../budgets/costs.js";
import { monthBounds, monthlyCsv, monthlyReport, usageCsv, windowBounds } from "../budgets/monthly.js";
import { usedInWindow, type BudgetRow } from "../budgets/service.js";
import { bedrockListModel } from "../budgets/prices.js";
import type { Db, Queryable } from "../db/pool.js";
import { conflict, HttpError, notFound } from "../http-error.js";
import { loadProvider } from "../providers/providers.js";
import { mutate } from "../mutate.js";
import { parseBody, uuidParam } from "../validate.js";
import { listPriceFor } from "../budgets/list-prices.js";

interface PriceRow {
  id: string;
  model: string;
  provider_id: string | null;
  estimate: boolean;
  currency: string;
  input_per_million: number | null;
  output_per_million: number | null;
  cache_read_per_million: number | null;
  cache_write_per_million: number | null;
  seat_price_month: number | null;
  updated_at: Date;
}

function priceToJson(r: PriceRow) {
  return {
    id: r.id,
    model: r.model,
    /** The company provider whose price it is; null: the board's own models. */
    providerId: r.provider_id,
    /** Filled from another's list (Anthropic's, for a Bedrock Claude model): check it against your own bill. */
    estimate: r.estimate,
    currency: r.currency,
    inputPerMillion: r.input_per_million,
    outputPerMillion: r.output_per_million,
    cacheReadPerMillion: r.cache_read_per_million,
    cacheWritePerMillion: r.cache_write_per_million,
    seatPriceMonth: r.seat_price_month,
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * The company's other currency, when a price in this one cannot join its prices, or null. A company keeps one
 * currency: Costs adds every price up, so a second would add pence to cents. The price being replaced does
 * not count.
 */
async function otherCurrency(
  db: Queryable,
  companyId: string,
  currency: string,
  replacing: { providerId: string | null; model: string } | null,
): Promise<string | null> {
  const res = await db.query<{ currency: string }>(
    `SELECT currency FROM model_prices
      WHERE company_id = $1 AND currency <> $2
        AND NOT (provider_id IS NOT DISTINCT FROM $3::uuid AND model = $4)
      LIMIT 1`,
    [companyId, currency, replacing?.providerId ?? null, replacing?.model ?? ""],
  );
  return res.rows[0]?.currency ?? null;
}

export function registerBudgetRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/companies/:companyId/costs", { config: { action: "company.read" } }, async (req) => {
    const q = (req.query as { window?: string }).window ?? "week";
    const window = (BUDGET_WINDOWS as readonly string[]).includes(q) ? (q as BudgetWindow) : "week";
    return costReport(db, req.companyId, window);
  });

  // Every run's usage, and every manager's planning call, as CSV, for a window (day, week, month from now)
  // or a calendar month (YYYY-MM).
  app.get(
    "/api/companies/:companyId/costs/export.csv",
    { config: { action: "company.read" } },
    async (req, reply) => {
      const q = req.query as { window?: string; month?: string };
      const bounds = q.month
        ? await monthBounds(db, q.month)
        : await windowBounds(
            db,
            (BUDGET_WINDOWS as readonly string[]).includes(q.window ?? "")
              ? (q.window as BudgetWindow)
              : "month",
          );
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="rosterdock-usage-${bounds.label}.csv"`);
      return usageCsv(db, req.companyId, bounds);
    },
  );

  // The monthly cost report: by project with chargeback tags, by tag, department, teammate and model.
  app.get("/api/companies/:companyId/costs/monthly", { config: { action: "company.read" } }, async (req) => {
    const q = req.query as { month?: string };
    return monthlyReport(db, req.companyId, q.month);
  });

  app.get(
    "/api/companies/:companyId/costs/monthly.csv",
    { config: { action: "company.read" } },
    async (req, reply) => {
      const q = req.query as { month?: string };
      const report = await monthlyReport(db, req.companyId, q.month);
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="rosterdock-chargeback-${report.month}.csv"`);
      return monthlyCsv(report);
    },
  );

  app.get("/api/companies/:companyId/budgets", { config: { action: "company.read" } }, async (req) => {
    const rows = await db.query<BudgetRow>(
      "SELECT * FROM budgets WHERE company_id = $1 ORDER BY scope_kind, created_at",
      [req.companyId],
    );
    const out = [];
    for (const b of rows.rows) {
      const used = await usedInWindow(db, req.companyId, b.scope_kind, b.scope_id, b.window_kind);
      out.push({
        id: b.id,
        scopeKind: b.scope_kind,
        scopeId: b.scope_id,
        tokensLimit: Number(b.tokens_limit),
        window: b.window_kind,
        used,
        percent: b.tokens_limit > 0 ? Math.floor((used / Number(b.tokens_limit)) * 100) : 0,
        updatedAt: b.updated_at.toISOString(),
      });
    }
    return out;
  });

  app.put("/api/companies/:companyId/budgets", { config: { action: "company.update" } }, async (req) => {
    const body = parseBody(BudgetInputSchema, req.body);
    const scopeId = body.scopeKind === "company" ? req.companyId : body.scopeId;
    if (!scopeId) throw notFound("scope");
    const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
      const res = await ctx.client.query<BudgetRow>(
        `INSERT INTO budgets (company_id, scope_kind, scope_id, tokens_limit, window_kind) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, scope_kind, scope_id) DO UPDATE SET tokens_limit = EXCLUDED.tokens_limit, window_kind = EXCLUDED.window_kind, updated_at = now()
         RETURNING *`,
        [req.companyId, body.scopeKind, scopeId, body.tokensLimit, body.window],
      );
      const row = res.rows[0]!;
      await ctx.emit(
        "company.updated",
        { kind: "budget", id: row.id },
        {
          changes: ["budget"],
          scopeKind: row.scope_kind,
          scopeId: row.scope_id,
          tokensLimit: Number(row.tokens_limit),
          window: row.window_kind,
        },
      );
      return row;
    });
    return {
      id: result.id,
      scopeKind: result.scope_kind,
      scopeId: result.scope_id,
      tokensLimit: Number(result.tokens_limit),
      window: result.window_kind,
    };
  });

  app.delete(
    "/api/companies/:companyId/budgets/:budgetId",
    { config: { action: "company.update" } },
    async (req) => {
      const id = uuidParam((req.params as { budgetId: string }).budgetId, "budgetId");
      await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const res = await ctx.client.query("DELETE FROM budgets WHERE id = $1 AND company_id = $2", [
          id,
          req.companyId,
        ]);
        if (!res.rowCount) throw notFound("budget");
        await ctx.emit("company.updated", { kind: "budget", id }, { changes: ["budget.removed"] });
      });
      return { ok: true };
    },
  );

  app.get("/api/companies/:companyId/prices", { config: { action: "company.read" } }, async (req) => {
    const rows = await db.query<PriceRow>(
      "SELECT * FROM model_prices WHERE company_id = $1 ORDER BY provider_id NULLS FIRST, model",
      [req.companyId],
    );
    return rows.rows.map(priceToJson);
  });

  app.put("/api/companies/:companyId/prices", { config: { action: "company.update" } }, async (req) => {
    const body = parseBody(ModelPriceInputSchema, req.body);
    const providerId = body.providerId ?? null;
    const provider = providerId ? await loadProvider(db, req.companyId, providerId) : null;
    if (provider && body.seatPriceMonth != null)
      throw new HttpError(400, "a provider bills per token: give its prices per million tokens, not a seat");
    const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
      const theirs = await otherCurrency(ctx.client, req.companyId, body.currency, {
        providerId,
        model: body.model,
      });
      if (theirs)
        throw conflict(
          `this company's prices are in ${theirs}, and a company keeps one currency; give this price in ${theirs}`,
        );
      // A price a person types is theirs: never an estimate, whatever it replaces.
      const res = await ctx.client.query<PriceRow>(
        `INSERT INTO model_prices (company_id, model, currency, input_per_million, output_per_million, cache_read_per_million, cache_write_per_million, seat_price_month, provider_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (company_id, provider_id, model) DO UPDATE SET currency = EXCLUDED.currency, input_per_million = EXCLUDED.input_per_million,
           output_per_million = EXCLUDED.output_per_million, cache_read_per_million = EXCLUDED.cache_read_per_million,
           cache_write_per_million = EXCLUDED.cache_write_per_million, seat_price_month = EXCLUDED.seat_price_month,
           estimate = false, updated_at = now()
         RETURNING *`,
        [
          req.companyId,
          body.model,
          body.currency,
          body.inputPerMillion ?? null,
          body.outputPerMillion ?? null,
          body.cacheReadPerMillion ?? null,
          body.cacheWritePerMillion ?? null,
          body.seatPriceMonth ?? null,
          providerId,
        ],
      );
      const row = res.rows[0]!;
      await ctx.emit(
        "company.updated",
        { kind: "company", id: req.companyId },
        { changes: ["price"], model: row.model, ...(provider ? { provider: provider.name } : {}) },
      );
      return row;
    });
    return priceToJson(result);
  });

  // Fill the price table with list prices, never over a price a person set, and say which models it priced
  // and which have no list price: for the models the company uses on the board's own models, or for one
  // provider's models (an Anthropic provider's at the list price; a Bedrock provider's Claude models at it
  // too, marked an estimate, since AWS prices them itself).
  app.post("/api/companies/:companyId/prices/list", { config: { action: "company.update" } }, async (req) => {
    const body = parseBody(ListPricesInputSchema, req.body);
    const provider = body.providerId ? await loadProvider(db, req.companyId, body.providerId) : null;
    let wanted: { model: string; listedAs: string; estimate: boolean }[];
    if (provider) {
      const priced = new Set(
        (
          await db.query<{ model: string }>(
            "SELECT model FROM model_prices WHERE company_id = $1 AND provider_id = $2",
            [req.companyId, provider.id],
          )
        ).rows.map((r) => r.model),
      );
      const claude = provider.models.filter((m) => m.family === "claude" && !priced.has(m.id));
      wanted =
        provider.kind === "anthropic"
          ? claude.map((m) => ({ model: m.id, listedAs: m.id, estimate: false }))
          : provider.kind === "bedrock"
            ? claude.map((m) => ({ model: m.id, listedAs: bedrockListModel(m.id), estimate: true }))
            : [];
    } else {
      const used = await db.query<{ model: string }>(
        `SELECT model FROM teammates WHERE company_id = $1
         UNION SELECT model FROM run_usage WHERE company_id = $1 AND provider_id IS NULL
         EXCEPT SELECT model FROM model_prices WHERE company_id = $1 AND provider_id IS NULL
         ORDER BY model`,
        [req.companyId],
      );
      wanted = used.rows.map((r) => ({ model: r.model, listedAs: r.model, estimate: false }));
    }
    const fill = wanted.flatMap((w) => {
      const p = listPriceFor(w.listedAs);
      return p ? [{ ...p, model: w.model, estimate: w.estimate }] : [];
    });
    // The stub calls no model, so it has no price to look up or to ask a person for.
    const unknown = wanted
      .filter((w) => w.model !== STUB_MODEL && !listPriceFor(w.listedAs))
      .map((w) => w.model);
    if (!fill.length) return { added: [], unknown };
    const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
      const theirs = await otherCurrency(ctx.client, req.companyId, fill[0]!.currency, null);
      if (theirs)
        throw conflict(
          `list prices are in ${fill[0]!.currency}, and this company's prices are in ${theirs}; a company keeps one currency, so type these prices in ${theirs}`,
        );
      const added: string[] = [];
      for (const p of fill) {
        // A price set meanwhile is kept.
        const res = await ctx.client.query(
          `INSERT INTO model_prices (company_id, model, currency, input_per_million, output_per_million, cache_read_per_million, cache_write_per_million, provider_id, estimate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (company_id, provider_id, model) DO NOTHING`,
          [
            req.companyId,
            p.model,
            p.currency,
            p.inputPerMillion,
            p.outputPerMillion,
            p.cacheReadPerMillion,
            p.cacheWritePerMillion,
            provider?.id ?? null,
            p.estimate,
          ],
        );
        if (res.rowCount) added.push(p.model);
      }
      await ctx.emit(
        "company.updated",
        { kind: "company", id: req.companyId },
        { changes: ["price"], models: added, from: "list", ...(provider ? { provider: provider.name } : {}) },
      );
      return added;
    });
    return { added: result, unknown };
  });

  app.delete(
    "/api/companies/:companyId/prices/:priceId",
    { config: { action: "company.update" } },
    async (req) => {
      const id = uuidParam((req.params as { priceId: string }).priceId, "priceId");
      await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const res = await ctx.client.query("DELETE FROM model_prices WHERE id = $1 AND company_id = $2", [
          id,
          req.companyId,
        ]);
        if (!res.rowCount) throw notFound("price");
        await ctx.emit(
          "company.updated",
          { kind: "company", id: req.companyId },
          { changes: ["price.removed"] },
        );
      });
      return { ok: true };
    },
  );
}
