// Token budgets per company, department, project and teammate, enforced at
// dispatch and alerted at 80% and 100% when a run reports usage.

import { blockerFor } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import type { MutationContext } from "../mutate.js";
import type { ModelPrice } from "./cost.js";

export type BudgetScopeKind = "company" | "department" | "project" | "teammate";
/** goal: a lifetime cap Peter sets on a goal's project. */
export type BudgetWindow = "day" | "week" | "month" | "goal";

export interface BudgetRow {
  id: string;
  company_id: string;
  scope_kind: BudgetScopeKind;
  scope_id: string;
  tokens_limit: number;
  window_kind: BudgetWindow;
  created_at: Date;
  updated_at: Date;
}

export interface RunScopes {
  companyId: string;
  departmentId: string | null;
  projectId: string;
  teammateId: string;
}

const SCOPE_COLUMN: Record<BudgetScopeKind, string> = {
  company: "company_id",
  department: "department_id",
  project: "project_id",
  teammate: "teammate_id",
};

export function scopeIdFor(kind: BudgetScopeKind, scopes: RunScopes): string | null {
  switch (kind) {
    case "company":
      return scopes.companyId;
    case "department":
      return scopes.departmentId;
    case "project":
      return scopes.projectId;
    case "teammate":
      return scopes.teammateId;
  }
}

/** Tokens recorded for a scope since the start of its window. */
export async function usedInWindow(
  db: Queryable,
  companyId: string,
  kind: BudgetScopeKind,
  scopeId: string,
  window: BudgetWindow,
): Promise<number> {
  const res = await db.query<{ used: number }>(
    `SELECT coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::bigint AS used
     FROM run_usage WHERE company_id = $1 AND ${SCOPE_COLUMN[kind]} = $2
       AND created_at >= CASE WHEN $3 = 'goal' THEN '-infinity'::timestamptz ELSE date_trunc($3, now()) END`,
    [companyId, scopeId, window],
  );
  return Number(res.rows[0]?.used ?? 0);
}

/** Budgets that apply to a run, with what they have used so far. */
export async function applicableBudgets(
  db: Queryable,
  scopes: RunScopes,
): Promise<{ budget: BudgetRow; used: number }[]> {
  const rows = await db.query<BudgetRow>("SELECT * FROM budgets WHERE company_id = $1", [scopes.companyId]);
  const out: { budget: BudgetRow; used: number }[] = [];
  for (const budget of rows.rows) {
    if (scopeIdFor(budget.scope_kind, scopes) !== budget.scope_id) continue;
    out.push({
      budget,
      used: await usedInWindow(db, scopes.companyId, budget.scope_kind, budget.scope_id, budget.window_kind),
    });
  }
  return out;
}

export async function scopeName(
  db: Queryable,
  kind: BudgetScopeKind,
  scopeId: string,
): Promise<string | null> {
  const table = {
    company: "companies",
    department: "departments",
    project: "projects",
    teammate: "teammates",
  }[kind];
  const res = await db.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [scopeId]);
  return res.rows[0]?.name ?? null;
}

/** Refuse a dispatch when any applicable budget is already spent. */
export async function assertWithinBudgets(db: Queryable, scopes: RunScopes): Promise<void> {
  for (const { budget, used } of await applicableBudgets(db, scopes)) {
    if (used >= budget.tokens_limit) {
      const name = await scopeName(db, budget.scope_kind, budget.scope_id);
      throw new HttpError(
        409,
        `the ${budget.scope_kind} budget${name ? ` for ${name}` : ""} is spent: ${used.toLocaleString()} of ${budget.tokens_limit.toLocaleString()} tokens this ${budget.window_kind}`,
        {
          blocker: blockerFor("token_budget_exhausted", {
            what: `The ${budget.scope_kind} token budget${name ? ` for ${name}` : ""} is spent for this ${budget.window_kind}.`,
          }),
          budgetId: budget.id,
        },
      );
    }
  }
}

const THRESHOLDS = [80, 100] as const;

/**
 * After a run adds tokens: emit budget.alert for every threshold the scope
 * crossed with this run (usage before < threshold <= usage after).
 */
export async function alertOnBudgets(
  ctx: MutationContext,
  scopes: RunScopes,
  addedTokens: number,
): Promise<void> {
  if (addedTokens <= 0) return;
  for (const { budget, used } of await applicableBudgets(ctx.client, scopes)) {
    if (budget.tokens_limit <= 0) continue;
    const before = used - addedTokens;
    const pctBefore = (before / budget.tokens_limit) * 100;
    const pctAfter = (used / budget.tokens_limit) * 100;
    for (const threshold of THRESHOLDS) {
      if (pctBefore < threshold && pctAfter >= threshold) {
        const name = await scopeName(ctx.client, budget.scope_kind, budget.scope_id);
        await ctx.emit(
          "budget.alert",
          { kind: "budget", id: budget.id },
          {
            scopeKind: budget.scope_kind,
            scopeId: budget.scope_id,
            scopeName: name,
            threshold,
            percent: Math.floor(pctAfter),
            used,
            limit: budget.tokens_limit,
            window: budget.window_kind,
          },
        );
      }
    }
  }
}

export async function priceFor(db: Queryable, companyId: string, model: string): Promise<ModelPrice | null> {
  const res = await db.query<{
    model: string;
    currency: string;
    input_per_million: number | null;
    output_per_million: number | null;
    cache_read_per_million: number | null;
    cache_write_per_million: number | null;
    seat_price_month: number | null;
  }>("SELECT * FROM model_prices WHERE company_id = $1 AND model = $2", [companyId, model]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    model: r.model,
    currency: r.currency,
    inputPerMillion: r.input_per_million,
    outputPerMillion: r.output_per_million,
    cacheReadPerMillion: r.cache_read_per_million,
    cacheWritePerMillion: r.cache_write_per_million,
    seatPriceMonth: r.seat_price_month,
  };
}
