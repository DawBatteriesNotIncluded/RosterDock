// Token budgets per company, department, project, teammate and goal, enforced
// at dispatch and alerted at 80% and 100% when a run reports usage or a
// manager's own model call (planning) returns. Both count against them.

import { blockerFor } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import type { MutationContext } from "../mutate.js";

/** goal: a goal's token cap, which nobody sets by hand. */
export type BudgetScopeKind = "company" | "department" | "project" | "teammate" | "goal";
/** goal: a lifetime cap, a goal's. */
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

/** What a run or a manager's model call counts under. */
export interface RunScopes {
  companyId: string;
  departmentId: string | null;
  /** Null for a call that served no project (an org proposal). */
  projectId: string | null;
  /** The teammate who ran, or the manager who made the call. */
  teammateId: string;
  /** The goal the run's task serves, or the call planned, if any. */
  goalId: string | null;
}

/**
 * The usage rows that count against a scope ($2), in run_usage and in planning_usage: a goal's are its
 * tasks' runs and the calls that planned it or re-planned its tasks.
 */
const SCOPE_FILTER: Record<BudgetScopeKind, { runs: string; planning: string }> = {
  company: { runs: "company_id = $2", planning: "company_id = $2" },
  department: { runs: "department_id = $2", planning: "department_id = $2" },
  project: { runs: "project_id = $2", planning: "project_id = $2" },
  teammate: { runs: "teammate_id = $2", planning: "teammate_id = $2" },
  goal: { runs: "task_id IN (SELECT id FROM tasks WHERE goal_id = $2)", planning: "goal_id = $2" },
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
    case "goal":
      return scopes.goalId;
  }
}

/** Tokens recorded for a scope since the start of its window: its runs' and its managers' calls. */
export async function usedInWindow(
  db: Queryable,
  companyId: string,
  kind: BudgetScopeKind,
  scopeId: string,
  window: BudgetWindow,
): Promise<number> {
  const since =
    "created_at >= CASE WHEN $3::text = 'goal' THEN '-infinity'::timestamptz ELSE date_trunc($3::text, now()) END";
  const res = await db.query<{ used: number }>(
    `SELECT coalesce(sum(tokens), 0)::bigint AS used FROM (
       SELECT input_tokens + output_tokens + cache_read_tokens + cache_write_tokens AS tokens
       FROM run_usage WHERE company_id = $1 AND ${SCOPE_FILTER[kind].runs} AND ${since}
       UNION ALL
       SELECT input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
       FROM planning_usage WHERE company_id = $1 AND ${SCOPE_FILTER[kind].planning} AND ${since}
     ) u`,
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
    goal: "goals",
  }[kind];
  const column = kind === "goal" ? "title" : "name";
  const res = await db.query<{ name: string }>(`SELECT ${column} AS name FROM ${table} WHERE id = $1`, [
    scopeId,
  ]);
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

/** A threshold a budget crossed: what budget.alert says. */
export interface BudgetCrossing {
  budget: BudgetRow;
  name: string | null;
  threshold: (typeof THRESHOLDS)[number];
  percent: number;
  used: number;
}

/**
 * Every threshold the scopes' budgets crossed with the tokens just added (usage before < threshold <=
 * usage after), the addition already recorded.
 */
export async function budgetCrossings(
  db: Queryable,
  scopes: RunScopes,
  addedTokens: number,
): Promise<BudgetCrossing[]> {
  if (addedTokens <= 0) return [];
  const out: BudgetCrossing[] = [];
  for (const { budget, used } of await applicableBudgets(db, scopes)) {
    if (budget.tokens_limit <= 0) continue;
    const before = used - addedTokens;
    const pctBefore = (before / budget.tokens_limit) * 100;
    const pctAfter = (used / budget.tokens_limit) * 100;
    for (const threshold of THRESHOLDS) {
      if (pctBefore < threshold && pctAfter >= threshold) {
        const name = await scopeName(db, budget.scope_kind, budget.scope_id);
        out.push({ budget, name, threshold, percent: Math.floor(pctAfter), used });
      }
    }
  }
  return out;
}

export async function emitBudgetAlert(ctx: MutationContext, c: BudgetCrossing): Promise<void> {
  await ctx.emit(
    "budget.alert",
    { kind: "budget", id: c.budget.id },
    {
      scopeKind: c.budget.scope_kind,
      scopeId: c.budget.scope_id,
      scopeName: c.name,
      threshold: c.threshold,
      percent: c.percent,
      used: c.used,
      limit: c.budget.tokens_limit,
      window: c.budget.window_kind,
    },
  );
}

/**
 * After a run adds tokens: emit budget.alert for every threshold the scope
 * crossed with this run (usage before < threshold <= usage after).
 */
export async function alertOnBudgets(
  ctx: MutationContext,
  scopes: RunScopes,
  addedTokens: number,
): Promise<void> {
  for (const c of await budgetCrossings(ctx.client, scopes, addedTokens)) await emitBudgetAlert(ctx, c);
}
