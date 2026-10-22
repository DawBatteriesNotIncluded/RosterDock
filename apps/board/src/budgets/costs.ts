// The cost report: tokens to money for one company over a window, by
// department, project, teammate and model, with a forecast and the company
// budget. API billing is the per-token price table; seat billing is the
// monthly seat price of each teammate's model or engine, pro-rated to the
// window. Both are computed so the page can show "if billed the other way".
// Money is computed from the price table as it stands now, so a price set
// after a run still prices it; the run itself keeps the cost at completion.
// A manager's own model calls (planning) count with the runs: under the
// manager, the model that answered, and the project and department they served.

import type { BudgetWindow, ProviderKind } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { costFor, usageModel, type ModelPrice } from "./cost.js";
import { priceTable } from "./prices.js";
import { USAGE_ROWS } from "./usage.js";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface CostLine {
  tokens: TokenTotals;
  /** Per-token cost in minor units; null when nothing in the line had a price. */
  costMinorUnits: number | null;
  runs: number;
  /** A manager's own model calls in the line (planning a goal, a re-plan note, an org proposal). */
  calls: number;
}

export interface CostReport {
  window: BudgetWindow;
  from: string;
  to: string;
  currency: string;
  /** How far through the window we are, 0..1; the forecast divides by it. */
  elapsedFraction: number;
  totals: CostLine & { seatMinorUnits: number };
  forecast: { costMinorUnits: number | null; seatMinorUnits: number; tokens: number };
  budget: { tokensLimit: number; used: number; percent: number; window: BudgetWindow } | null;
  byDepartment: (CostLine & {
    id: string | null;
    name: string;
    teammates: number;
    seatMinorUnits: number;
    budget: { tokensLimit: number; used: number; percent: number } | null;
  })[];
  byProject: (CostLine & { id: string; name: string; client: string })[];
  byTeammate: (CostLine & {
    id: string;
    name: string;
    handle: string;
    model: string;
    engine: string;
    departmentName: string | null;
    seatMinorUnits: number;
  })[];
  /** By model and the provider it went through: the same id costs what each provider charges. */
  byModel: (CostLine & { model: string; providerId: string | null; provider: string; teammates: number })[];
  /** By provider: a company's own, and the board's own models (id null). */
  byProvider: (CostLine & { id: string | null; name: string; kind: ProviderKind | null })[];
  bySeat: { key: string; teammates: number; seatMinorUnits: number }[];
  daily: { day: string; tokens: number; costMinorUnits: number | null }[];
  prices: number;
}

const WINDOW_DAYS: Record<BudgetWindow, number> = { day: 1, week: 7, month: 30.4 };

interface UsageRow {
  teammate_id: string;
  /** Null for a call that served no project (an org proposal). */
  project_id: string | null;
  department_id: string | null;
  /** The company provider it went through; null: the board's own models. */
  provider_id: string | null;
  model: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  runs: string;
  calls: string;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addUsage(line: CostLine, r: UsageRow, price: ModelPrice | null): void {
  const i = Number(r.input_tokens);
  const o = Number(r.output_tokens);
  const cr = Number(r.cache_read_tokens);
  const cw = Number(r.cache_write_tokens);
  line.tokens.input += i;
  line.tokens.output += o;
  line.tokens.cacheRead += cr;
  line.tokens.cacheWrite += cw;
  line.tokens.total += i + o + cr + cw;
  const cost = costFor({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw }, price);
  if (cost !== null) line.costMinorUnits = (line.costMinorUnits ?? 0) + cost;
  line.runs += Number(r.runs);
  line.calls += Number(r.calls);
}

function line<T>(extra: T): CostLine & T {
  return { tokens: emptyTotals(), costMinorUnits: null, runs: 0, calls: 0, ...extra };
}

export async function costReport(
  db: Queryable,
  companyId: string,
  window: BudgetWindow,
): Promise<CostReport> {
  const bounds = (
    await db.query<{ from: Date; to: Date; now: Date }>(
      "SELECT date_trunc($1, now()) AS from, date_trunc($1, now()) + ('1 ' || $1)::interval AS to, now() AS now",
      [window],
    )
  ).rows[0]!;
  const elapsedFraction = Math.max(
    0.001,
    Math.min(
      1,
      (bounds.now.getTime() - bounds.from.getTime()) / (bounds.to.getTime() - bounds.from.getTime()),
    ),
  );

  const usage = await db.query<UsageRow>(
    `SELECT teammate_id, project_id, department_id, provider_id, model,
            sum(input_tokens)::text AS input_tokens, sum(output_tokens)::text AS output_tokens,
            sum(cache_read_tokens)::text AS cache_read_tokens, sum(cache_write_tokens)::text AS cache_write_tokens,
            sum(runs)::text AS runs, sum(calls)::text AS calls
     FROM ${USAGE_ROWS} u WHERE company_id = $1 AND created_at >= $2 AND created_at < $3
     GROUP BY teammate_id, project_id, department_id, provider_id, model`,
    [companyId, bounds.from, bounds.to],
  );
  const teammates = await db.query<{
    id: string;
    name: string;
    handle: string;
    model: string;
    engine: string;
  }>("SELECT id, name, handle, model, engine FROM teammates WHERE company_id = $1 ORDER BY name", [
    companyId,
  ]);
  const departments = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM departments WHERE company_id = $1 ORDER BY name",
    [companyId],
  );
  const memberships = await db.query<{ department_id: string; teammate_id: string }>(
    "SELECT department_id, teammate_id FROM department_members WHERE company_id = $1",
    [companyId],
  );
  const projects = await db.query<{ id: string; name: string; client: string }>(
    "SELECT id, name, client FROM projects WHERE company_id = $1 ORDER BY name",
    [companyId],
  );
  const prices = await priceTable(db, companyId);
  const budgets = await db.query<{
    scope_kind: string;
    scope_id: string;
    tokens_limit: string;
    window_kind: BudgetWindow;
  }>("SELECT scope_kind, scope_id, tokens_limit, window_kind FROM budgets WHERE company_id = $1", [
    companyId,
  ]);
  const dailyRows = await db.query<UsageRow & { day: string }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, provider_id, model,
            '' AS teammate_id, '' AS project_id, NULL AS department_id,
            sum(input_tokens)::text AS input_tokens, sum(output_tokens)::text AS output_tokens,
            sum(cache_read_tokens)::text AS cache_read_tokens, sum(cache_write_tokens)::text AS cache_write_tokens,
            sum(runs)::text AS runs, sum(calls)::text AS calls
     FROM ${USAGE_ROWS} u WHERE company_id = $1 AND created_at >= now() - interval '14 days'
     GROUP BY 1, 2, 3 ORDER BY 1`,
    [companyId],
  );

  const currency = prices.currency;
  const seatFor = prices.seatFor;
  const priceOf = (r: Pick<UsageRow, "provider_id" | "model">): ModelPrice | null =>
    prices.priceOf(r.provider_id, r.model);
  const modelKey = (model: string, providerId: string | null) => `${model}\u0000${providerId ?? ""}`;
  const seatForWindow = (month: number) => Math.round((month * WINDOW_DAYS[window]) / 30.4);
  const usedFor = (kind: string, id: string) => {
    let used = 0;
    for (const r of usage.rows) {
      const key =
        kind === "department"
          ? r.department_id
          : kind === "project"
            ? r.project_id
            : kind === "teammate"
              ? r.teammate_id
              : companyId;
      if (key === id) {
        used +=
          Number(r.input_tokens) +
          Number(r.output_tokens) +
          Number(r.cache_read_tokens) +
          Number(r.cache_write_tokens);
      }
    }
    return used;
  };
  const budgetFor = (kind: string, id: string) => {
    const b = budgets.rows.find(
      (x) => x.scope_kind === kind && x.scope_id === id && x.window_kind === window,
    );
    if (!b) return null;
    const limit = Number(b.tokens_limit);
    const used = usedFor(kind, id);
    return { tokensLimit: limit, used, percent: limit > 0 ? Math.floor((used / limit) * 100) : 0 };
  };

  const totals = line({ seatMinorUnits: 0 });
  const byTeammate = new Map<string, CostReport["byTeammate"][number]>();
  for (const t of teammates.rows) {
    const dept = memberships.rows.find((m) => m.teammate_id === t.id);
    const seat = seatFor(t.model, t.engine);
    byTeammate.set(
      t.id,
      line({
        id: t.id,
        name: t.name,
        handle: t.handle,
        model: usageModel(t.engine, t.model),
        engine: t.engine,
        departmentName: dept
          ? (departments.rows.find((d) => d.id === dept.department_id)?.name ?? null)
          : null,
        seatMinorUnits: seat ? seatForWindow(seat.month) : 0,
      }),
    );
  }
  const byDepartment = new Map<string | null, CostReport["byDepartment"][number]>();
  for (const d of departments.rows) {
    byDepartment.set(
      d.id,
      line({
        id: d.id,
        name: d.name,
        teammates: 0,
        seatMinorUnits: 0,
        budget: budgetFor("department", d.id),
      }),
    );
  }
  const byProject = new Map<string, CostReport["byProject"][number]>();
  for (const p of projects.rows) byProject.set(p.id, line({ id: p.id, name: p.name, client: p.client }));
  const byModel = new Map<string, CostReport["byModel"][number]>();
  const byProvider = new Map<string | null, CostReport["byProvider"][number]>();
  const bySeat = new Map<string, CostReport["bySeat"][number]>();

  for (const r of usage.rows) {
    const price = priceOf(r);
    addUsage(totals, r, price);
    const mate = byTeammate.get(r.teammate_id);
    if (mate) addUsage(mate, r, price);
    const dept = byDepartment.get(r.department_id) ?? byDepartment.get(null);
    if (dept) addUsage(dept, r, price);
    else if (r.department_id === null) {
      const none = line({ id: null, name: "No department", teammates: 0, seatMinorUnits: 0, budget: null });
      addUsage(none, r, price);
      byDepartment.set(null, none);
    }
    const project = r.project_id ? byProject.get(r.project_id) : undefined;
    if (project) addUsage(project, r, price);
    let model = byModel.get(modelKey(r.model, r.provider_id));
    if (!model) {
      model = line({
        model: r.model,
        providerId: r.provider_id,
        provider: prices.providerLabel(r.provider_id),
        teammates: 0,
      });
      byModel.set(modelKey(r.model, r.provider_id), model);
    }
    addUsage(model, r, price);
    let provider = byProvider.get(r.provider_id);
    if (!provider) {
      provider = line({
        id: r.provider_id,
        name: prices.providerLabel(r.provider_id),
        kind: r.provider_id ? (prices.providers.get(r.provider_id)?.kind ?? null) : null,
      });
      byProvider.set(r.provider_id, provider);
    }
    addUsage(provider, r, price);
  }
  const daily = new Map<string, { day: string; tokens: number; costMinorUnits: number | null }>();
  for (const r of dailyRows.rows) {
    const d = daily.get(r.day) ?? { day: r.day, tokens: 0, costMinorUnits: null };
    const l = line({});
    addUsage(l, r, priceOf(r));
    d.tokens += l.tokens.total;
    if (l.costMinorUnits !== null) d.costMinorUnits = (d.costMinorUnits ?? 0) + l.costMinorUnits;
    daily.set(r.day, d);
  }
  // Seats and head counts come from the roster, not from usage: a seat costs the same idle.
  for (const t of teammates.rows) {
    const mate = byTeammate.get(t.id);
    if (!mate) continue;
    totals.seatMinorUnits += mate.seatMinorUnits;
    const dept = memberships.rows.find((m) => m.teammate_id === t.id);
    const d = dept ? byDepartment.get(dept.department_id) : undefined;
    if (d) {
      d.teammates += 1;
      d.seatMinorUnits += mate.seatMinorUnits;
    }
    const m = byModel.get(modelKey(usageModel(t.engine, t.model), null));
    if (m) m.teammates += 1;
    const seat = seatFor(t.model, t.engine);
    const key = seat?.key ?? `${t.engine} (no seat price)`;
    const s = bySeat.get(key) ?? { key, teammates: 0, seatMinorUnits: 0 };
    s.teammates += 1;
    s.seatMinorUnits += mate.seatMinorUnits;
    bySeat.set(key, s);
  }

  const companyBudget = budgetFor("company", companyId);
  return {
    window,
    from: bounds.from.toISOString(),
    to: bounds.to.toISOString(),
    currency,
    elapsedFraction,
    totals,
    forecast: {
      costMinorUnits:
        totals.costMinorUnits === null ? null : Math.round(totals.costMinorUnits / elapsedFraction),
      seatMinorUnits: totals.seatMinorUnits,
      tokens: Math.round(totals.tokens.total / elapsedFraction),
    },
    budget: companyBudget ? { ...companyBudget, window } : null,
    byDepartment: [...byDepartment.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    byProject: [...byProject.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    byTeammate: [...byTeammate.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    byModel: [...byModel.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    byProvider: [...byProvider.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    bySeat: [...bySeat.values()].sort((a, b) => b.seatMinorUnits - a.seatMinorUnits),
    daily: [...daily.values()],
    prices: prices.rows,
  };
}
