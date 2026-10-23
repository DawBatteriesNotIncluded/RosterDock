// The monthly cost report and the CSV exports: projections of the usage, the
// runs' and the managers' own model calls (planning), for one company over a
// calendar month (or a budget window), priced with the table as it stands now,
// grouped by project and its chargeback tag, department, teammate and model.
// Seats are the monthly seat price of every teammate on a seat-priced model or
// engine, not pro-rated: a seat costs the same idle.

import type { BudgetWindow } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import { costFor, usageModel } from "./cost.js";
import type { CostLine, TokenTotals } from "./costs.js";
import { BOARD_OWN_MODELS, priceTable, type PriceTable } from "./prices.js";
import { USAGE_ROWS, type PlanningPurpose } from "./usage.js";

export interface Bounds {
  from: Date;
  to: Date;
  /** YYYY-MM for a month, the window name otherwise. */
  label: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The calendar month, UTC. Default: the current one. */
export async function monthBounds(db: Queryable, month: string | undefined): Promise<Bounds> {
  if (month !== undefined && !MONTH_RE.test(month)) throw new HttpError(400, "month must be YYYY-MM");
  const res = await db.query<{ from: Date; to: Date }>(
    month
      ? "SELECT ($1 || '-01')::timestamptz AS from, (($1 || '-01')::timestamptz + interval '1 month') AS to"
      : "SELECT date_trunc('month', now()) AS from, date_trunc('month', now()) + interval '1 month' AS to",
    month ? [month] : [],
  );
  const b = res.rows[0]!;
  return { from: b.from, to: b.to, label: month ?? b.from.toISOString().slice(0, 7) };
}

/** The same bounds the cost report uses for a window (day, week, month from now). */
export async function windowBounds(db: Queryable, window: BudgetWindow): Promise<Bounds> {
  const res = await db.query<{ from: Date; to: Date }>(
    "SELECT date_trunc($1, now()) AS from, date_trunc($1, now()) + ('1 ' || $1)::interval AS to",
    [window],
  );
  const b = res.rows[0]!;
  return { from: b.from, to: b.to, label: window };
}

export interface UsageLine {
  createdAt: string;
  /** A teammate's run, or what a manager's own model call was for. */
  kind: "run" | PlanningPurpose;
  /** The run; null for a manager's call. */
  runId: string | null;
  /** The run's task, or the task a call re-planned. */
  taskNumber: number | null;
  taskTitle: string | null;
  /** The goal the run's task serves, or the goal a call planned. */
  goalTitle: string | null;
  /** A manager's calls on the line: one, or what a goal spent before they were counted one by one. */
  calls: number;
  teammateId: string;
  teammateName: string;
  departmentId: string | null;
  departmentName: string | null;
  /** Null for a call that served no project (an org proposal). */
  projectId: string | null;
  projectName: string;
  client: string;
  chargebackTag: string | null;
  /** The company provider it went through, and what people call it; null: the board's own models. */
  providerId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Priced with the table as it stands now; null when the model has no per-token price. */
  costMinorUnits: number | null;
}

/** Every run's and manager's call's usage in the bounds, one line per run and model or per call, with names. */
export async function usageLines(
  db: Queryable,
  companyId: string,
  bounds: Bounds,
  /** The table to price with, when the caller reads its currency after; else one of its own. */
  table?: PriceTable,
): Promise<UsageLine[]> {
  const prices = table ?? (await priceTable(db, companyId));
  const rows = await db.query<{
    created_at: Date;
    kind: UsageLine["kind"];
    run_id: string | null;
    calls: number;
    number: number | null;
    title: string | null;
    goal_title: string | null;
    teammate_id: string;
    teammate_name: string | null;
    department_id: string | null;
    department_name: string | null;
    project_id: string | null;
    project_name: string | null;
    client: string | null;
    chargeback_tag: string | null;
    provider_id: string | null;
    model: string;
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    cache_write_tokens: string;
  }>(
    `SELECT u.created_at, u.kind, u.run_id, u.calls, t.number, t.title, g.title AS goal_title,
            u.teammate_id, m.name AS teammate_name,
            u.department_id, d.name AS department_name, u.project_id, p.name AS project_name, p.client,
            p.chargeback_tag, u.provider_id, u.model, u.input_tokens::text, u.output_tokens::text,
            u.cache_read_tokens::text, u.cache_write_tokens::text
     FROM ${USAGE_ROWS} u
     LEFT JOIN tasks t ON t.id = u.task_id
     LEFT JOIN goals g ON g.id = coalesce(u.goal_id, t.goal_id)
     LEFT JOIN teammates m ON m.id = u.teammate_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN projects p ON p.id = u.project_id
     WHERE u.company_id = $1 AND u.created_at >= $2 AND u.created_at < $3
     ORDER BY u.created_at, u.run_id`,
    [companyId, bounds.from, bounds.to],
  );
  return rows.rows.map((r) => {
    const usage = {
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
    };
    return {
      createdAt: r.created_at.toISOString(),
      kind: r.kind,
      runId: r.run_id,
      taskNumber: r.number,
      taskTitle: r.title,
      goalTitle: r.goal_title,
      calls: r.calls,
      teammateId: r.teammate_id,
      teammateName: r.teammate_name ?? "(removed)",
      departmentId: r.department_id,
      departmentName: r.department_name,
      projectId: r.project_id,
      projectName: r.project_id ? (r.project_name ?? "(removed)") : "",
      client: r.client ?? "",
      chargebackTag: r.chargeback_tag,
      providerId: r.provider_id,
      provider: prices.providerLabel(r.provider_id),
      model: r.model,
      ...usage,
      totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      costMinorUnits: costFor(usage, prices.priceOf(r.provider_id, r.model)),
    };
  });
}

// --- CSV ---------------------------------------------------------------------------------

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const money = (minor: number | null) => (minor === null ? "" : (minor / 100).toFixed(2));

/** The CSV's word for what a line is. */
const KIND_LABEL: Record<UsageLine["kind"], string> = {
  run: "run",
  plan: "plan",
  replan: "re-plan",
  org: "org proposal",
};

/**
 * One line per run and model, and per manager's call: who, what, for whom, how many tokens, what it cost.
 * kind, goal and provider close the line, so the columns before them stay where they were.
 */
export async function usageCsv(db: Queryable, companyId: string, bounds: Bounds): Promise<string> {
  const prices = await priceTable(db, companyId);
  const lines = await usageLines(db, companyId, bounds, prices);
  const currency = prices.displayCurrency();
  return toCsv(
    [
      "date",
      "run_id",
      "task",
      "task_title",
      "teammate",
      "department",
      "project",
      "client",
      "chargeback_tag",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "total_tokens",
      "cost",
      "currency",
      "kind",
      "goal",
      "provider",
    ],
    lines.map((l) => [
      l.createdAt,
      l.runId ?? "",
      l.taskNumber === null ? "" : `#${l.taskNumber}`,
      l.taskTitle ?? "",
      l.teammateName,
      l.departmentName ?? "",
      l.projectName,
      l.client,
      l.chargebackTag ?? "",
      l.model,
      l.inputTokens,
      l.outputTokens,
      l.cacheReadTokens,
      l.cacheWriteTokens,
      l.totalTokens,
      money(l.costMinorUnits),
      currency,
      KIND_LABEL[l.kind],
      l.goalTitle ?? "",
      l.provider,
    ]),
  );
}

// --- The monthly report --------------------------------------------------------------------

export interface MonthlyReport {
  month: string;
  from: string;
  to: string;
  currency: string;
  totals: CostLine & { seatMinorUnits: number; teammates: number };
  byProject: (CostLine & { id: string; name: string; client: string; chargebackTag: string | null })[];
  /** Projects rolled up by their chargeback tag; untagged projects under tag null. */
  byChargebackTag: (CostLine & { tag: string | null; projects: number })[];
  byDepartment: (CostLine & { id: string | null; name: string; seatMinorUnits: number })[];
  byTeammate: (CostLine & {
    id: string;
    name: string;
    handle: string;
    model: string;
    engine: string;
    seatMinorUnits: number;
  })[];
  /** By model and the provider it went through. */
  byModel: (CostLine & { model: string; providerId: string | null; provider: string })[];
  byProvider: (CostLine & { id: string | null; name: string })[];
  /** Each project's spend by provider, for the chargeback CSV; a project with none is on the board's own. */
  byProjectProvider: (CostLine & {
    projectId: string;
    name: string;
    client: string;
    chargebackTag: string | null;
    providerId: string | null;
    provider: string;
  })[];
  daily: { day: string; tokens: number; costMinorUnits: number | null }[];
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function line<T>(extra: T): CostLine & T {
  return { tokens: emptyTotals(), costMinorUnits: null, runs: 0, calls: 0, ...extra };
}

function add(target: CostLine, l: UsageLine): void {
  target.tokens.input += l.inputTokens;
  target.tokens.output += l.outputTokens;
  target.tokens.cacheRead += l.cacheReadTokens;
  target.tokens.cacheWrite += l.cacheWriteTokens;
  target.tokens.total += l.totalTokens;
  if (l.costMinorUnits !== null) target.costMinorUnits = (target.costMinorUnits ?? 0) + l.costMinorUnits;
  if (l.kind === "run") target.runs += 1;
  else target.calls += l.calls;
}

export async function monthlyReport(
  db: Queryable,
  companyId: string,
  month?: string,
): Promise<MonthlyReport> {
  const bounds = await monthBounds(db, month);
  const prices = await priceTable(db, companyId);
  const seatFor = (model: string, engine: string) => prices.seatFor(model, engine)?.month ?? 0;
  const lines = await usageLines(db, companyId, bounds, prices);
  const currency = prices.displayCurrency();
  const teammates = (
    await db.query<{ id: string; name: string; handle: string; model: string; engine: string }>(
      "SELECT id, name, handle, model, engine FROM teammates WHERE company_id = $1 ORDER BY name",
      [companyId],
    )
  ).rows;
  const memberships = (
    await db.query<{ department_id: string; teammate_id: string }>(
      "SELECT department_id, teammate_id FROM department_members WHERE company_id = $1",
      [companyId],
    )
  ).rows;
  const departments = (
    await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM departments WHERE company_id = $1 ORDER BY name",
      [companyId],
    )
  ).rows;
  const projects = (
    await db.query<{ id: string; name: string; client: string; chargeback_tag: string | null }>(
      "SELECT id, name, client, chargeback_tag FROM projects WHERE company_id = $1 ORDER BY name",
      [companyId],
    )
  ).rows;

  const totals = line({ seatMinorUnits: 0, teammates: teammates.length });
  const byProject = new Map(
    projects.map((p) => [
      p.id,
      line({ id: p.id, name: p.name, client: p.client, chargebackTag: p.chargeback_tag }),
    ]),
  );
  const byDepartment = new Map<string | null, MonthlyReport["byDepartment"][number]>(
    departments.map((d) => [d.id, line({ id: d.id, name: d.name, seatMinorUnits: 0 })]),
  );
  const byTeammate = new Map(
    teammates.map((t) => [
      t.id,
      line({
        id: t.id,
        name: t.name,
        handle: t.handle,
        model: usageModel(t.engine, t.model),
        engine: t.engine,
        seatMinorUnits: seatFor(t.model, t.engine),
      }),
    ]),
  );
  const byModel = new Map<string, MonthlyReport["byModel"][number]>();
  const byProvider = new Map<string | null, MonthlyReport["byProvider"][number]>();
  const byProjectProvider = new Map<string, MonthlyReport["byProjectProvider"][number]>();
  const key = (a: string, b: string | null) => `${a}\u0000${b ?? ""}`;
  const daily = new Map<string, { day: string; tokens: number; costMinorUnits: number | null }>();

  for (const l of lines) {
    add(totals, l);
    const project = l.projectId ? byProject.get(l.projectId) : undefined;
    if (project) add(project, l);
    let dept = byDepartment.get(l.departmentId);
    if (!dept) {
      dept = line({ id: null, name: "No department", seatMinorUnits: 0 });
      byDepartment.set(null, dept);
    }
    add(dept, l);
    const mate = byTeammate.get(l.teammateId);
    if (mate) add(mate, l);
    let model = byModel.get(key(l.model, l.providerId));
    if (!model) {
      model = line({ model: l.model, providerId: l.providerId, provider: l.provider });
      byModel.set(key(l.model, l.providerId), model);
    }
    add(model, l);
    let provider = byProvider.get(l.providerId);
    if (!provider) {
      provider = line({ id: l.providerId, name: l.provider });
      byProvider.set(l.providerId, provider);
    }
    add(provider, l);
    if (project) {
      let pp = byProjectProvider.get(key(project.id, l.providerId));
      if (!pp) {
        pp = line({
          projectId: project.id,
          name: project.name,
          client: project.client,
          chargebackTag: project.chargebackTag,
          providerId: l.providerId,
          provider: l.provider,
        });
        byProjectProvider.set(key(project.id, l.providerId), pp);
      }
      add(pp, l);
    }
    const day = l.createdAt.slice(0, 10);
    const d = daily.get(day) ?? { day, tokens: 0, costMinorUnits: null };
    d.tokens += l.totalTokens;
    if (l.costMinorUnits !== null) d.costMinorUnits = (d.costMinorUnits ?? 0) + l.costMinorUnits;
    daily.set(day, d);
  }
  // Seats: the month's price per teammate, on the roster as it stands.
  for (const t of teammates) {
    const mate = byTeammate.get(t.id)!;
    totals.seatMinorUnits += mate.seatMinorUnits;
    const m = memberships.find((x) => x.teammate_id === t.id);
    const dept = m ? byDepartment.get(m.department_id) : undefined;
    if (dept) dept.seatMinorUnits += mate.seatMinorUnits;
  }
  const byTag = new Map<string | null, MonthlyReport["byChargebackTag"][number]>();
  for (const p of byProject.values()) {
    const tag = p.chargebackTag?.trim() || null;
    let t = byTag.get(tag);
    if (!t) {
      t = line({ tag, projects: 0 });
      byTag.set(tag, t);
    }
    t.projects += 1;
    t.tokens.input += p.tokens.input;
    t.tokens.output += p.tokens.output;
    t.tokens.cacheRead += p.tokens.cacheRead;
    t.tokens.cacheWrite += p.tokens.cacheWrite;
    t.tokens.total += p.tokens.total;
    if (p.costMinorUnits !== null) t.costMinorUnits = (t.costMinorUnits ?? 0) + p.costMinorUnits;
    t.runs += p.runs;
    t.calls += p.calls;
  }
  const byTokens = <T extends CostLine>(a: T, b: T) => b.tokens.total - a.tokens.total;
  return {
    month: bounds.label,
    from: bounds.from.toISOString(),
    to: bounds.to.toISOString(),
    currency,
    totals,
    byProject: [...byProject.values()].sort(byTokens),
    byChargebackTag: [...byTag.values()].sort((a, b) => {
      if (a.tag === null) return 1;
      if (b.tag === null) return -1;
      return byTokens(a, b);
    }),
    byDepartment: [...byDepartment.values()].sort(byTokens),
    byTeammate: [...byTeammate.values()].sort(byTokens),
    byModel: [...byModel.values()].sort(byTokens),
    byProvider: [...byProvider.values()].sort(byTokens),
    // In the projects' order; a project nothing ran on keeps its line, on the board's own models.
    byProjectProvider: [...byProject.values()].sort(byTokens).flatMap((p) => {
      const mine = [...byProjectProvider.values()].filter((x) => x.projectId === p.id).sort(byTokens);
      return mine.length
        ? mine
        : [
            line({
              projectId: p.id,
              name: p.name,
              client: p.client,
              chargebackTag: p.chargebackTag,
              providerId: null,
              provider: BOARD_OWN_MODELS,
            }),
          ];
    }),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/**
 * The chargeback table: one line per project and the provider its work went through, with its tag, ready for
 * an invoice or a spreadsheet. provider closes the line, so the columns before it stay where they were.
 */
export function monthlyCsv(r: MonthlyReport): string {
  return toCsv(
    ["month", "project", "client", "chargeback_tag", "runs", "total_tokens", "cost", "currency", "provider"],
    r.byProjectProvider.map((p) => [
      r.month,
      p.name,
      p.client,
      p.chargebackTag ?? "",
      p.runs,
      p.tokens.total,
      money(p.costMinorUnits),
      r.currency,
      p.provider,
    ]),
  );
}
