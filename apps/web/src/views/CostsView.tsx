// Costs: tokens to money for the company over a window. API billing (the
// per-model price table) next to seat billing (per teammate per month), by
// department, model, teammate and project, with the budget and a forecast.
import { useEffect, useState } from "react";
import type { BudgetWindow, CompanyData, CostReport, MonthlyReport } from "../api/types.ts";
import { Avatar, Empty, Pill, Segs, Topbar } from "../components/ui.tsx";
import { fmtTokens } from "./RunPanel.tsx";

export type CostMode = "api" | "seat";

export function money(minorUnits: number | null, currency: string): string {
  if (minorUnits === null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minorUnits / 100);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currency}`;
  }
}

const WINDOW_LABEL: Record<BudgetWindow, string> = {
  day: "today",
  week: "this week, Monday to today",
  month: "this month",
};
const WINDOW_END: Record<BudgetWindow, string> = { day: "midnight", week: "Sunday", month: "month end" };

function Meter({ percent, tone }: { percent: number; tone?: "ok" | "warn" | "bad" }) {
  const pc = Math.max(0, Math.min(100, percent));
  const color = tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  return (
    <div className="meter" style={{ width: 120 }}>
      <div style={{ width: `${pc.toFixed(0)}%`, background: color }} />
    </div>
  );
}

function budgetTone(percent: number): "ok" | "warn" | "bad" {
  return percent >= 100 ? "bad" : percent >= 80 ? "warn" : "ok";
}

function BudgetPill({ percent }: { percent: number }) {
  const tone = budgetTone(percent);
  return (
    <Pill tone={tone}>{tone === "bad" ? "Over budget" : tone === "warn" ? "80% alert" : "On track"}</Pill>
  );
}

/** YYYY-MM for a date, UTC. */
/**
 * The last 14 days, oldest first, each with its tokens: the report names only the days that had any, so
 * a company that began today drew one bar across the whole card. Days are UTC, as the board groups them.
 */
export function fourteenDays(
  daily: { day: string; tokens: number; costMinorUnits: number | null }[],
  today: Date = new Date(),
): { day: string; tokens: number; costMinorUnits: number | null }[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (13 - i)));
    const day = d.toISOString().slice(0, 10);
    return daily.find((x) => x.day === day) ?? { day, tokens: 0, costMinorUnits: null };
  });
}

export function monthOf(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** The monthly report: the chargeback table first, then the rest of the month, and the CSVs. */
export function MonthlyView(p: {
  month: string;
  report: MonthlyReport | null;
  error: string | null;
  usageCsvUrl: string;
  chargebackCsvUrl: string;
  onOpenProject(id: string): void;
}) {
  const r = p.report;
  if (!r) return <Empty>{p.error ? `Could not load the month: ${p.error}` : "Adding up…"}</Empty>;
  const cur = r.currency;
  const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
  return (
    <div className="company scroll" style={{ gap: 22 }}>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <div className="card flex flex-col gap-1.5 px-[18px] py-4">
          <span className="eyebrow">API spend in {r.month}</span>
          <span className="mono text-[26px] font-bold tracking-[-0.02em]">
            {money(r.totals.costMinorUnits, cur)}
          </span>
          <span className="hint">
            {fmtTokens(r.totals.tokens.total)} tokens · {runs(r.totals.runs)}
          </span>
        </div>
        <div className="card flex flex-col gap-1.5 px-[18px] py-4">
          <span className="eyebrow">Seats for the month</span>
          <span className="mono text-[26px] font-bold tracking-[-0.02em]">
            {money(r.totals.seatMinorUnits, cur)}
          </span>
          <span className="hint">
            {r.totals.teammates} teammate{r.totals.teammates === 1 ? "" : "s"} on the roster
          </span>
        </div>
        <div className="card flex flex-col gap-1.5 px-[18px] py-4">
          <span className="eyebrow">Export</span>
          <a className="btn" href={p.chargebackCsvUrl} download>
            Chargeback CSV
          </a>
          <a className="btn" href={p.usageCsvUrl} download>
            Every run as CSV
          </a>
        </div>
      </div>
      <div className="card overflow-hidden p-0">
        <div className="eyebrow border-b border-[var(--border-soft)] px-[18px] py-3.5">
          Chargeback by project
        </div>
        <table className="costs">
          <thead>
            <tr>
              <th>Project</th>
              <th>Tag</th>
              <th className="text-right">Tokens</th>
              <th className="text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {r.byProject.map((pr) => (
              <tr key={pr.id} className="cursor-pointer" onClick={() => p.onOpenProject(pr.id)}>
                <td>
                  <span className="font-semibold">{pr.name}</span> <span className="hint">· {pr.client}</span>
                  <div className="hint">{runs(pr.runs)}</div>
                </td>
                <td className="mono">{pr.chargebackTag ?? <span className="hint">untagged</span>}</td>
                <td className="mono text-right">{fmtTokens(pr.tokens.total)}</td>
                <td className="mono text-right">{money(pr.costMinorUnits, cur)}</td>
              </tr>
            ))}
            {r.byProject.length === 0 ? (
              <tr>
                <td className="hint" colSpan={4}>
                  No projects yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <div className="card overflow-hidden p-0">
          <div className="eyebrow border-b border-[var(--border-soft)] px-[18px] py-3.5">
            By chargeback tag
          </div>
          <table className="costs">
            <tbody>
              {r.byChargebackTag.map((t) => (
                <tr key={t.tag ?? "-"}>
                  <td>
                    <span className="mono font-semibold">{t.tag ?? "untagged"}</span>
                    <div className="hint">
                      {t.projects} project{t.projects === 1 ? "" : "s"} · {fmtTokens(t.tokens.total)} tokens
                    </div>
                  </td>
                  <td className="mono text-right">{money(t.costMinorUnits, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card overflow-hidden p-0">
          <div className="eyebrow border-b border-[var(--border-soft)] px-[18px] py-3.5">By department</div>
          <table className="costs">
            <tbody>
              {r.byDepartment.map((d) => (
                <tr key={d.id ?? "-"}>
                  <td>
                    <span className="font-semibold">{d.name}</span>
                    <div className="hint">
                      {fmtTokens(d.tokens.total)} tokens · seats {money(d.seatMinorUnits, cur)}
                    </div>
                  </td>
                  <td className="mono text-right">{money(d.costMinorUnits, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card overflow-hidden p-0">
          <div className="eyebrow border-b border-[var(--border-soft)] px-[18px] py-3.5">By teammate</div>
          <table className="costs">
            <tbody>
              {r.byTeammate.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="font-semibold">{t.name}</span> <span className="hint">· {t.model}</span>
                    <div className="hint">
                      {fmtTokens(t.tokens.total)} tokens · {runs(t.runs)}
                    </div>
                  </td>
                  <td className="mono text-right">{money(t.costMinorUnits, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card overflow-hidden p-0">
          <div className="eyebrow border-b border-[var(--border-soft)] px-[18px] py-3.5">By model</div>
          <table className="costs">
            <tbody>
              {r.byModel.map((m) => (
                <tr key={m.model}>
                  <td>
                    <span className="mono font-semibold">{m.model}</span>
                    <div className="hint">{fmtTokens(m.tokens.total)} tokens</div>
                  </td>
                  <td className="mono text-right">{money(m.costMinorUnits, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <span className="hint">
        Priced with the table as it stands now. Seats are the monthly seat price of every teammate on the
        roster, not pro-rated. The chargeback CSV is one line per project; the usage CSV is one line per run.
      </span>
    </div>
  );
}

export interface CostsViewProps {
  data: CompanyData;
  loadCosts(window: BudgetWindow): Promise<CostReport>;
  /** The monthly report for a YYYY-MM (M6). */
  loadMonthly(month: string): Promise<MonthlyReport>;
  usageCsvUrl(window: BudgetWindow): string;
  chargebackCsvUrl(month: string): string;
  /** Server-rendered tests pass the report in; the browser loads it. */
  initial?: CostReport | null;
  initialMonthly?: MonthlyReport | null;
  onOpenTeammate(id: string): void;
  onOpenProject(id: string): void;
  onOpenSettings(): void;
}

export function CostsView(p: CostsViewProps) {
  const [window, setWindow] = useState<BudgetWindow>("week");
  const [mode, setMode] = useState<CostMode>("api");
  const [report, setReport] = useState<CostReport | null>(p.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [monthly, setMonthly] = useState(!!p.initialMonthly);
  const [month, setMonth] = useState(p.initialMonthly?.month ?? monthOf());
  const [monthReport, setMonthReport] = useState<MonthlyReport | null>(p.initialMonthly ?? null);
  const [monthError, setMonthError] = useState<string | null>(null);
  const latestSeq = p.data.events[0]?.seq ?? 0;

  useEffect(() => {
    if (!monthly) return;
    let alive = true;
    p.loadMonthly(month)
      .then((r) => alive && setMonthReport(r))
      .catch((err: Error) => alive && setMonthError(err.message));
    return () => {
      alive = false;
    };
  }, [monthly, month, latestSeq, p.loadMonthly]);

  useEffect(() => {
    let alive = true;
    p.loadCosts(window)
      .then((r) => alive && setReport(r))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
    // A new event (a run finished, a price changed) refreshes the report.
  }, [window, latestSeq, p.loadCosts]);

  const segs = (
    <div className="flex items-center gap-2">
      <Segs<BudgetWindow | "monthly">
        label="Period"
        value={monthly ? "monthly" : window}
        onChange={(v) => {
          if (v === "monthly") return setMonthly(true);
          setMonthly(false);
          setWindow(v);
        }}
        options={[
          { value: "day", label: "Today" },
          { value: "week", label: "This week" },
          { value: "month", label: "This month" },
          { value: "monthly", label: "Monthly report" },
        ]}
      />
      {monthly ? (
        <input
          type="month"
          className="mono"
          value={month}
          max={monthOf()}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          aria-label="Month"
        />
      ) : (
        <a className="btn" href={p.usageCsvUrl(window)} download>
          Export CSV
        </a>
      )}
      <Segs
        label="Billing"
        value={mode}
        onChange={setMode}
        options={[
          { value: "api", label: "API billing" },
          { value: "seat", label: "Seat billing" },
        ]}
      />
    </div>
  );

  if (monthly) {
    return (
      <>
        <Topbar title="Costs" subtitle={`${p.data.company.name} · ${month}`} right={segs} />
        <div className="content">
          <MonthlyView
            month={month}
            report={monthReport?.month === month ? monthReport : null}
            error={monthError}
            usageCsvUrl={`${p.usageCsvUrl("month").split("?")[0]}?month=${month}`}
            chargebackCsvUrl={p.chargebackCsvUrl(month)}
            onOpenProject={p.onOpenProject}
          />
        </div>
      </>
    );
  }

  if (!report) {
    return (
      <>
        <Topbar title="Costs" subtitle={`${p.data.company.name} · ${WINDOW_LABEL[window]}`} right={segs} />
        <div className="content">
          <Empty>{error ? `Could not load costs: ${error}` : "Adding up…"}</Empty>
        </div>
      </>
    );
  }

  const cur = report.currency;
  const val = (line: { costMinorUnits: number | null; seatMinorUnits?: number }) =>
    mode === "api" ? line.costMinorUnits : (line.seatMinorUnits ?? 0);
  const spend = mode === "api" ? report.totals.costMinorUnits : report.totals.seatMinorUnits;
  const otherWay = mode === "api" ? report.totals.seatMinorUnits : report.totals.costMinorUnits;
  const forecast = mode === "api" ? report.forecast.costMinorUnits : report.forecast.seatMinorUnits;
  const budget = report.budget;
  const maxDay = Math.max(1, ...report.daily.map((d) => d.tokens));
  const teammateOf = (id: string) => p.data.teammates.find((t) => t.id === id);

  const card = (label: string, big: string, foot: React.ReactNode, bigStyle?: React.CSSProperties) => (
    <div className="card flex flex-col gap-1.5 px-[18px] py-4">
      <span className="eyebrow">{label}</span>
      <span className="mono text-[26px] font-bold tracking-[-0.02em]" style={bigStyle}>
        {big}
      </span>
      <span className="hint">{foot}</span>
    </div>
  );

  return (
    <>
      <Topbar title="Costs" subtitle={`${p.data.company.name} · ${WINDOW_LABEL[window]}`} right={segs} />
      <div className="content">
        <div className="company scroll" style={{ gap: 22 }}>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            {card(
              "Spend so far",
              money(spend, cur),
              `${fmtTokens(report.totals.tokens.total)} tokens · ${report.totals.runs} run${report.totals.runs === 1 ? "" : "s"} · ${report.byTeammate.length} teammate${report.byTeammate.length === 1 ? "" : "s"}`,
            )}
            {budget
              ? card(
                  `Budget · ${budget.window}`,
                  `${fmtTokens(budget.tokensLimit)} tokens`,
                  <span className="flex items-center gap-2.5">
                    <Meter percent={budget.percent} tone={budgetTone(budget.percent)} />
                    {budget.percent}% used
                  </span>,
                )
              : card("Budget", "None", "Set a company budget in Settings for alerts at 80% and 100%.")}
            {card(
              `Forecast to ${WINDOW_END[window]}`,
              money(forecast, cur),
              mode === "seat"
                ? "Seats cost the same however much they run."
                : forecast === null
                  ? "No per-token prices yet."
                  : `At this pace · ${fmtTokens(report.forecast.tokens)} tokens`,
              forecast !== null && budget && report.forecast.tokens > budget.tokensLimit
                ? { color: "var(--bad)" }
                : undefined,
            )}
            {card(
              "If billed the other way",
              money(otherWay, cur),
              mode === "api" ? "Same work on subscription seats" : "Same work on API tokens",
            )}
          </div>

          {report.daily.length ? (
            <div className="card flex flex-col gap-2 px-[18px] py-3.5">
              <span className="eyebrow">Last 14 days · tokens per day</span>
              <div className="flex items-end gap-1.5" style={{ height: 64 }}>
                {fourteenDays(report.daily).map((d) => (
                  <div
                    key={d.day}
                    title={`${d.day}: ${fmtTokens(d.tokens)} tokens${d.costMinorUnits !== null ? ` · ${money(d.costMinorUnits, cur)}` : ""}`}
                    className="flex-1 rounded-t-sm"
                    style={{
                      height: `${d.tokens ? Math.max(4, (d.tokens / maxDay) * 100) : 2}%`,
                      background: d.tokens ? "var(--accent)" : "var(--border)",
                      minWidth: 6,
                    }}
                  />
                ))}
              </div>
              <div className="flex justify-between text-[11px] text-muted">
                <span>{fourteenDays(report.daily)[0]!.day}</span>
                <span>today</span>
              </div>
            </div>
          ) : null}

          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
            <div className="card overflow-hidden p-0">
              <div className="eyebrow border-b border-[var(--border-soft)] px-[18px] py-3.5">
                By department
              </div>
              <table className="costs">
                <tbody>
                  {report.byDepartment.map((d) => (
                    <tr key={d.id ?? "none"}>
                      <td>
                        <span className="font-semibold">{d.name}</span>
                        <div className="hint">
                          {d.teammates} teammate{d.teammates === 1 ? "" : "s"} · {fmtTokens(d.tokens.total)}{" "}
                          tokens
                        </div>
                      </td>
                      <td>
                        {d.budget ? (
                          <Meter percent={d.budget.percent} tone={budgetTone(d.budget.percent)} />
                        ) : null}
                      </td>
                      <td className="mono text-right">
                        {money(val(d), cur)}
                        {d.budget ? (
                          <div className="hint">of {fmtTokens(d.budget.tokensLimit)} tokens</div>
                        ) : null}
                      </td>
                      <td className="text-right">
                        {d.budget ? <BudgetPill percent={d.budget.percent} /> : null}
                      </td>
                    </tr>
                  ))}
                  {report.byDepartment.length === 0 ? (
                    <tr>
                      <td className="hint">No departments yet</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className="card overflow-hidden p-0">
              <div className="eyebrow border-b border-[var(--border-soft)] px-[18px] py-3.5">
                By {mode === "api" ? "model" : "seat"}
              </div>
              <table className="costs">
                <tbody>
                  {mode === "api"
                    ? report.byModel.map((m) => (
                        <tr key={m.model}>
                          <td>
                            <span className="font-semibold">{m.model}</span>
                            <div className="hint">
                              {m.teammates} teammate{m.teammates === 1 ? "" : "s"} ·{" "}
                              {fmtTokens(m.tokens.total)} tokens · {m.runs} run
                              {m.runs === 1 ? "" : "s"}
                            </div>
                          </td>
                          <td className="mono text-right">{money(m.costMinorUnits, cur)}</td>
                        </tr>
                      ))
                    : report.bySeat.map((s) => (
                        <tr key={s.key}>
                          <td>
                            <span className="font-semibold">{s.key}</span>
                            <div className="hint">
                              {s.teammates} seat{s.teammates === 1 ? "" : "s"}
                            </div>
                          </td>
                          <td className="mono text-right">{money(s.seatMinorUnits, cur)}</td>
                        </tr>
                      ))}
                  <tr>
                    <td className="hint" colSpan={2}>
                      {report.prices
                        ? `${report.prices} price${report.prices === 1 ? "" : "s"} set. `
                        : "No prices set yet: tokens are counted, money is not. "}
                      <a className="text-accent" onClick={p.onOpenSettings}>
                        {report.prices ? "Model prices in Settings" : "Add list prices in Settings"}
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-[var(--border-soft)] px-[18px] py-3.5">
              <span className="eyebrow">By teammate</span>
              <span className="hint">Click a row to open the teammate</span>
            </div>
            <div className="overflow-x-auto">
              <table className="costs" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th>Teammate</th>
                    <th>{mode === "api" ? "Model" : "Engine"}</th>
                    <th className="text-right">Input</th>
                    <th className="text-right">Output</th>
                    <th className="text-right">Cached</th>
                    <th className="text-right">Runs</th>
                    <th className="text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byTeammate.map((m) => {
                    const t = teammateOf(m.id);
                    return (
                      <tr key={m.id} className="cursor-pointer" onClick={() => p.onOpenTeammate(m.id)}>
                        <td>
                          <span className="inline-flex items-center gap-2">
                            <Avatar name={m.name} handle={m.handle} />
                            <span>
                              <b>{m.name}</b>
                              {m.departmentName ? <span className="hint"> · {m.departmentName}</span> : null}
                            </span>
                          </span>
                        </td>
                        <td>{mode === "api" ? m.model : (t?.engine ?? m.engine)}</td>
                        <td className="mono text-right">{fmtTokens(m.tokens.input)}</td>
                        <td className="mono text-right">{fmtTokens(m.tokens.output)}</td>
                        <td className="mono text-right">
                          {fmtTokens(m.tokens.cacheRead + m.tokens.cacheWrite)}
                        </td>
                        <td className="mono text-right">{m.runs}</td>
                        <td className="mono text-right">{money(val(m), cur)}</td>
                      </tr>
                    );
                  })}
                  {report.byTeammate.length === 0 ? (
                    <tr>
                      <td className="hint" colSpan={7}>
                        No teammates yet
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card overflow-hidden p-0">
            <div className="eyebrow border-b border-[var(--border-soft)] px-[18px] py-3.5">By project</div>
            <table className="costs">
              <tbody>
                {report.byProject.map((pr) => (
                  <tr key={pr.id} className="cursor-pointer" onClick={() => p.onOpenProject(pr.id)}>
                    <td>
                      <span className="font-semibold">{pr.name}</span>{" "}
                      <span className="hint">· {pr.client}</span>
                      <div className="hint">
                        {fmtTokens(pr.tokens.total)} tokens · {pr.runs} run{pr.runs === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className="mono text-right">
                      {money(mode === "api" ? pr.costMinorUnits : null, cur)}
                    </td>
                  </tr>
                ))}
                {report.byProject.length === 0 ? (
                  <tr>
                    <td className="hint">No projects yet</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <span className="hint">
            Prices are per million tokens in the company currency; seats are per teammate per month, pro-rated
            to the window. Cost lines show a dash when a model has no per-token price.
          </span>
        </div>
      </div>
    </>
  );
}
