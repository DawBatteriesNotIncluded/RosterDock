// Budgets and the per-model price table, per company.
import { BudgetInputSchema, ModelPriceInputSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import { BUDGET_WINDOWS, type BudgetWindow } from "@rosterdock/shared";
import { costReport } from "../budgets/costs.js";
import { monthBounds, monthlyCsv, monthlyReport, usageCsv, windowBounds } from "../budgets/monthly.js";
import { usedInWindow, type BudgetRow } from "../budgets/service.js";
import type { Db } from "../db/pool.js";
import { notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import { parseBody, uuidParam } from "../validate.js";
import { listPriceFor } from "../budgets/list-prices.js";

interface PriceRow {
  id: string;
  model: string;
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
    currency: r.currency,
    inputPerMillion: r.input_per_million,
    outputPerMillion: r.output_per_million,
    cacheReadPerMillion: r.cache_read_per_million,
    cacheWritePerMillion: r.cache_write_per_million,
    seatPriceMonth: r.seat_price_month,
    updatedAt: r.updated_at.toISOString(),
  };
}

export function registerBudgetRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/companies/:companyId/costs", { config: { action: "company.read" } }, async (req) => {
    const q = (req.query as { window?: string }).window ?? "week";
    const window = (BUDGET_WINDOWS as readonly string[]).includes(q) ? (q as BudgetWindow) : "week";
    return costReport(db, req.companyId, window);
  });

  // Every run's usage as CSV, for a window (day, week, month from now) or a calendar month (YYYY-MM).
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
    const rows = await db.query<PriceRow>("SELECT * FROM model_prices WHERE company_id = $1 ORDER BY model", [
      req.companyId,
    ]);
    return rows.rows.map(priceToJson);
  });

  app.put("/api/companies/:companyId/prices", { config: { action: "company.update" } }, async (req) => {
    const body = parseBody(ModelPriceInputSchema, req.body);
    const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
      const res = await ctx.client.query<PriceRow>(
        `INSERT INTO model_prices (company_id, model, currency, input_per_million, output_per_million, cache_read_per_million, cache_write_per_million, seat_price_month)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id, model) DO UPDATE SET currency = EXCLUDED.currency, input_per_million = EXCLUDED.input_per_million,
           output_per_million = EXCLUDED.output_per_million, cache_read_per_million = EXCLUDED.cache_read_per_million,
           cache_write_per_million = EXCLUDED.cache_write_per_million, seat_price_month = EXCLUDED.seat_price_month, updated_at = now()
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
        ],
      );
      const row = res.rows[0]!;
      await ctx.emit(
        "company.updated",
        { kind: "company", id: req.companyId },
        { changes: ["price"], model: row.model },
      );
      return row;
    });
    return priceToJson(result);
  });

  // Fill the price table with list prices for the models the company uses and has not priced; never
  // over a price a person set. Says which models it priced and which have no list price.
  app.post("/api/companies/:companyId/prices/list", { config: { action: "company.update" } }, async (req) => {
    const used = await db.query<{ model: string }>(
      `SELECT model FROM teammates WHERE company_id = $1
       UNION SELECT model FROM run_usage WHERE company_id = $1
       EXCEPT SELECT model FROM model_prices WHERE company_id = $1
       ORDER BY model`,
      [req.companyId],
    );
    const fill = used.rows.map((r) => listPriceFor(r.model)).filter((p) => p !== null);
    const unknown = used.rows.map((r) => r.model).filter((m) => !listPriceFor(m));
    if (!fill.length) return { added: [], unknown };
    const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
      const added: string[] = [];
      for (const p of fill) {
        // A price set meanwhile is kept.
        const res = await ctx.client.query(
          `INSERT INTO model_prices (company_id, model, currency, input_per_million, output_per_million, cache_read_per_million, cache_write_per_million)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (company_id, model) DO NOTHING`,
          [
            req.companyId,
            p.model,
            p.currency,
            p.inputPerMillion,
            p.outputPerMillion,
            p.cacheReadPerMillion,
            p.cacheWritePerMillion,
          ],
        );
        if (res.rowCount) added.push(p.model);
      }
      await ctx.emit(
        "company.updated",
        { kind: "company", id: req.companyId },
        { changes: ["price"], models: added, from: "list" },
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
