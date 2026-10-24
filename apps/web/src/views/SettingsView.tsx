// Settings, one tab at a time: prices and budgets, the models the company thinks with (the board's own and
// its providers), connections (with the secrets note and the client policies), notifications, drift,
// templates. Peter's brain is on his page under Teammates, like every teammate's.
// Secrets never appear here; the platform knows them by name only.
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  BudgetInput,
  DriftSettingsInput,
  ModelPriceInput,
  NotifySettingsInput,
} from "@rosterdock/shared";
import type {
  Budget,
  BudgetScopeKind,
  BudgetWindow,
  CompanyData,
  ListPricesResult,
  ModelPrice,
  Project,
  StylePackInfo,
  TemplatesImportReport,
} from "../api/types.ts";
import { Button, Field, Pill, Tip, Topbar } from "../components/ui.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { DEFAULT_MODEL, toMinor } from "../lib/format.ts";
import type { SettingsTab } from "../state/store.tsx";
import { ClientPoliciesPanel } from "./ClientPoliciesPanel.tsx";
import { ConnectionsPanel, type ConnectionsPanelProps } from "./ConnectionsPanel.tsx";
import { ModelsPanel, type ModelsPanelProps } from "./ModelsPanel.tsx";
import { fmtTokens } from "./RunPanel.tsx";
import { money } from "./CostsView.tsx";

export interface SettingsViewProps {
  data: CompanyData;
  canEdit: boolean;
  /** Which tab shows; the app keeps it so the page comes back where it was left. */
  tab: SettingsTab;
  onTab(tab: SettingsTab): void;
  loadPrices(): Promise<ModelPrice[]>;
  savePrice(input: ModelPriceInput): Promise<ModelPrice>;
  deletePrice(id: string): Promise<void>;
  /** Price every model in use that has no price at the API list price. */
  fillListPrices(): Promise<ListPricesResult>;
  loadBudgets(): Promise<Budget[]>;
  saveBudget(input: BudgetInput): Promise<Budget>;
  deleteBudget(id: string): Promise<void>;
  initialPrices?: ModelPrice[];
  initialBudgets?: Budget[];
  /** The board's own models and the company's own model providers (Settings > Models). */
  models: Omit<ModelsPanelProps, "data" | "canEdit">;
  // Governed tools (M5)
  connections: Omit<ConnectionsPanelProps, "connections" | "canEdit">;
  saveClientPolicy(projectId: string, policy: Project["clientPolicy"]): Promise<void>;
  /** The env var NAME this company's webhook lives under; empty for the board's default. */
  saveNotifySettings(notify: NotifySettingsInput): Promise<void>;
  testNotify(): Promise<{ sent: boolean; target: string | null; error: string | null }>;
  /** What counts as drift for this company's teammates; empty fields take the board's defaults. */
  saveDriftSettings(drift: DriftSettingsInput): Promise<void>;
  /** Style packs: other people's published rules for how teammates write, switched per company. */
  loadStyles(): Promise<StylePackInfo[]>;
  setStyle(pack: string, input: { enabled: boolean; level?: string }): Promise<StylePackInfo[]>;
  initialStyles?: StylePackInfo[];
  // Templates as files (M6)
  templatesExportUrl: string;
  importTemplates(file: unknown): Promise<TemplatesImportReport>;
}

export const SETTINGS_TABS: { value: SettingsTab; label: string }[] = [
  { value: "prices", label: "Prices and budgets" },
  { value: "models", label: "Models" },
  { value: "style", label: "Style" },
  { value: "connections", label: "Connections" },
  { value: "notifications", label: "Notifications" },
  { value: "drift", label: "Drift" },
  { value: "templates", label: "Templates" },
];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One sentence about what an import did. */
export function importSummary(r: TemplatesImportReport): string {
  const parts = [
    r.created.departments.length ? plural(r.created.departments.length, "department") : "",
    r.created.teammates.length ? plural(r.created.teammates.length, "teammate") : "",
    r.created.teammateTemplates.length ? plural(r.created.teammateTemplates.length, "template") : "",
    r.created.connections?.length ? plural(r.created.connections.length, "connection") : "",
  ].filter(Boolean);
  const head = parts.length ? `Created ${parts.join(", ")}.` : "Nothing to create.";
  const policies = r.clientPolicies?.length
    ? ` ${plural(r.clientPolicies.length, "client policy").replace("policys", "policies")} set.`
    : "";
  const skipped = r.skipped.length ? ` Already here: ${r.skipped.length}.` : "";
  const notes = r.notes.length ? ` ${plural(r.notes.length, "note")}.` : "";
  return head + policies + skipped + notes;
}

function TemplatesCard(p: {
  canEdit: boolean;
  exportUrl: string;
  onImport(file: unknown): Promise<TemplatesImportReport>;
}) {
  const [report, setReport] = useState<TemplatesImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const parsed = JSON.parse(await f.text()) as unknown;
      setReport(await p.onImport(parsed));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">Templates</span>
        <span className="hint">
          The company's shape as one file: its teammates and their personas, its departments with leads and
          members, its own teammate templates, its connections and the client policies of its projects,
          everything by name. Import a file into any company: what is already there is left alone, what is
          missing is created. Files carry env var names, never credential values.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a className="btn" href={p.exportUrl} download>
          Export as a file
        </a>
        {p.canEdit ? (
          <label className="btn primary">
            {busy ? "Importing…" : "Import a file"}
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              disabled={busy}
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </label>
        ) : null}
      </div>
      {report ? (
        <div className="note">
          <span>{importSummary(report)}</span>
          {report.notes.map((n) => (
            <span key={n} className="hint">
              {n}
            </span>
          ))}
        </div>
      ) : null}
      {error ? <span className="hint">{error}</span> : null}
    </div>
  );
}

/** The company's webhook env var NAME from its settings, or "". */
export function notifyEnvName(settings: Record<string, unknown>): string {
  const n = (settings.notify as { webhookEnvName?: unknown } | undefined)?.webhookEnvName;
  return typeof n === "string" ? n : "";
}

export interface NotifyForm {
  webhookEnvName: string;
  smtpUrlEnvName: string;
  /** Comma-separated. */
  to: string;
  from: string;
}

/** The notification settings as the form shows them. */
export function notifyForm(settings: Record<string, unknown>): NotifyForm {
  const email = (
    settings.notify as { email?: { smtpUrlEnvName?: string; to?: string[]; from?: string } | null }
  )?.email;
  return {
    webhookEnvName: notifyEnvName(settings),
    smtpUrlEnvName: email?.smtpUrlEnvName ?? "",
    to: (email?.to ?? []).join(", "),
    from: email?.from ?? "",
  };
}

/** The form back to settings: names only; email only when a NAME and a recipient are given. */
export function notifyFromForm(form: NotifyForm): NotifySettingsInput {
  const to = form.to
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: NotifySettingsInput = { webhookEnvName: form.webhookEnvName.trim() || null };
  if (form.smtpUrlEnvName.trim() && to.length)
    out.email = {
      smtpUrlEnvName: form.smtpUrlEnvName.trim(),
      to,
      ...(form.from.trim() ? { from: form.from.trim() } : {}),
    };
  else out.email = null;
  return out;
}

/**
 * A form that mirrors a saved value: it follows the saved value when that changes (a save landed, or
 * another browser changed it) and keeps what is being typed otherwise. The board refreshes the company
 * on every event, so keying on the object would wipe the form mid-edit.
 */
function useMirroredForm<T>(saved: T): [T, (next: T) => void, boolean] {
  const savedKey = JSON.stringify(saved);
  const [form, setForm] = useState<T>(saved);
  useEffect(() => setForm(JSON.parse(savedKey) as T), [savedKey]);
  return [form, setForm, JSON.stringify(form) !== savedKey];
}

const DRIFT_FIELDS: { key: keyof DriftSettingsInput; label: string; hint: string; fallback: number }[] = [
  {
    key: "ratioFloor",
    label: "Times the usual",
    hint: "A run must cost or last at least this many times the teammate's median",
    fallback: 1.5,
  },
  {
    key: "madFactor",
    label: "Spread (MADs)",
    hint: "And be beyond this many median absolute deviations",
    fallback: 3,
  },
  {
    key: "rejectionRateFloor",
    label: "Sent back, rate",
    hint: "Rejections over the last ten decisions at or above this share",
    fallback: 0.5,
  },
  {
    key: "rejectionRateDelta",
    label: "Sent back, rise",
    hint: "And this much above the rate before",
    fallback: 0.3,
  },
];

/** The company's drift thresholds from its settings, as the form shows them ("" for the default). */
export function driftForm(settings: Record<string, unknown>): Record<keyof DriftSettingsInput, string> {
  const d = (settings.drift ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    DRIFT_FIELDS.map((f) => [f.key, typeof d[f.key] === "number" ? String(d[f.key]) : ""]),
  ) as Record<keyof DriftSettingsInput, string>;
}

function DriftCard(p: {
  settings: Record<string, unknown>;
  canEdit: boolean;
  onSave(drift: DriftSettingsInput): Promise<void>;
}) {
  const [form, setForm, dirty] = useMirroredForm(driftForm(p.settings));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const drift: DriftSettingsInput = {};
      for (const f of DRIFT_FIELDS) {
        const v = form[f.key].trim();
        if (v !== "" && Number.isFinite(Number(v))) drift[f.key] = Number(v);
      }
      await p.onSave(drift);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">Drift</span>
        <span className="hint">
          A teammate is compared with their own recent history, never with a fixed number or another teammate.
          These say how far from their usual counts as a departure worth a line in Activity. Empty takes the
          default.
        </span>
      </div>
      <div className="fields">
        {DRIFT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <input
              type="number"
              step="0.1"
              min={0}
              value={form[f.key]}
              placeholder={String(f.fallback)}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              disabled={!p.canEdit}
              className="mono"
              style={{ width: 200 }}
            />
          </Field>
        ))}
        {p.canEdit ? (
          <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
            Save thresholds
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Where a pack's file came from, in a line. */
export function styleSource(s: Pick<StylePackInfo, "source" | "fetchedAt" | "bundled">): string {
  const at = `${s.source.repo} at ${s.source.commit.slice(0, 7)}, ${s.source.license} licence`;
  if (s.bundled) return `From ${at}; comes with this board.`;
  return s.fetchedAt
    ? `From ${at}; downloaded ${new Date(s.fetchedAt).toLocaleDateString()}.`
    : `From ${at}; downloaded from GitHub when first turned on.`;
}

function StyleCard(p: {
  canEdit: boolean;
  load(): Promise<StylePackInfo[]>;
  onSet(pack: string, input: { enabled: boolean; level?: string }): Promise<StylePackInfo[]>;
  initial?: StylePackInfo[];
}) {
  const [packs, setPacks] = useState<StylePackInfo[] | null>(p.initial ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!p.initial) void p.load().then(setPacks);
  }, []);
  const set = async (pack: string, input: { enabled: boolean; level?: string }) => {
    setBusy(pack);
    try {
      setPacks(await p.onSet(pack, input));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">House style</span>
        <span className="hint">
          Other people's published rules for how AI writes, switched on for every teammate here. Each is
          pinned to one version of its file and used only if it is exactly that file. RosterDock's own rules
          (tools, approvals, outputs, secrets, reviews) always come first.
        </span>
      </div>
      {packs === null ? <span className="hint">Loading…</span> : null}
      {(packs ?? []).map((s) => (
        <div key={s.id} className="flex flex-col gap-1.5 border-t border-[var(--border-soft)] pt-3">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{s.label}</span>
            <Pill tone="muted">{s.enabled ? "On" : "Off"}</Pill>
          </div>
          <span>{s.what}</span>
          <span className="hint">
            {s.applies === "replies"
              ? "Applies to what teammates say: messages, handovers and review comments. Delivered files and code are written normally."
              : "Applies to the code teammates write."}
          </span>
          <span className="hint">
            {styleSource(s)}{" "}
            <a className="text-accent" href={s.source.home} target="_blank" rel="noreferrer">
              About it
            </a>
          </span>
          {p.canEdit ? (
            <div className="flex items-center gap-2">
              {s.levels ? (
                <select
                  aria-label={`${s.label} level`}
                  value={s.level ?? s.levels[0]}
                  disabled={busy !== null}
                  onChange={(e) => void set(s.id, { enabled: s.enabled, level: e.target.value })}
                >
                  {s.levels.map((l) => (
                    <option key={l} value={l}>
                      {l[0]!.toUpperCase() + l.slice(1)}
                    </option>
                  ))}
                </select>
              ) : null}
              <Button
                {...(s.enabled ? {} : { variant: "primary" as const })}
                disabled={busy !== null}
                onClick={() =>
                  void set(s.id, { enabled: !s.enabled, ...(s.level ? { level: s.level } : {}) })
                }
              >
                {s.enabled ? "Turn off" : "Turn on"}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function NotificationsCard(p: {
  settings: Record<string, unknown>;
  canEdit: boolean;
  onSave(notify: NotifySettingsInput): Promise<void>;
  onTest(): Promise<{ sent: boolean; target: string | null; error: string | null }>;
}) {
  const [form, setForm, dirty] = useMirroredForm(notifyForm(p.settings));
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof NotifyForm) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card flex flex-col gap-3 px-[18px] py-4">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">Notifications</span>
        <span className="hint">
          Everything that needs you (a proposed write, a goal that turned amber, a pull request to merge) is
          posted to a webhook as one sentence (a Slack incoming webhook works as is) and, when set, sent by
          email. Name the env vars that hold this company's webhook URL and SMTP URL (its secrets under
          Connections, or names the board shares), or leave them empty for the board's defaults. The SMTP URL
          carries its own credentials.
        </span>
      </div>
      <div className="fields">
        <Field label="Webhook env var NAME" hint="A name, never the URL">
          <input
            value={form.webhookEnvName}
            onChange={set("webhookEnvName")}
            placeholder="GTM_SLACK_WEBHOOK"
            className="mono"
            disabled={!p.canEdit}
            style={{ width: 220 }}
          />
        </Field>
        <Field label="SMTP URL env var NAME" hint="smtp:// or smtps://, by name">
          <input
            value={form.smtpUrlEnvName}
            onChange={set("smtpUrlEnvName")}
            placeholder="GTM_SMTP_URL"
            className="mono"
            disabled={!p.canEdit}
            style={{ width: 200 }}
          />
        </Field>
        <Field label="Email to" hint="Comma-separated">
          <input
            value={form.to}
            onChange={set("to")}
            placeholder="ops@example.com"
            disabled={!p.canEdit}
            style={{ width: 220 }}
          />
        </Field>
        <Field label="Email from" hint="Optional">
          <input
            value={form.from}
            onChange={set("from")}
            placeholder="rosterdock@example.com"
            disabled={!p.canEdit}
            style={{ width: 180 }}
          />
        </Field>
        {p.canEdit ? (
          <>
            <Button
              variant="primary"
              disabled={busy || !dirty}
              onClick={() => void act(() => p.onSave(notifyFromForm(form)))}
            >
              Save
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await p.onTest();
                  setResult(
                    r.sent
                      ? `Sent through ${r.target}.`
                      : `Not sent: ${r.error ?? "unknown"}${r.target ? ` (${r.target})` : ""}.`,
                  );
                })
              }
            >
              Send a test
            </Button>
          </>
        ) : null}
      </div>
      {result ? (
        <div>
          <Pill tone={result.startsWith("Sent") ? "ok" : "bad"}>{result}</Pill>
        </div>
      ) : null}
    </div>
  );
}

export { toMinor } from "../lib/format.ts";

const SCOPE_LABEL: Record<BudgetScopeKind, string> = {
  company: "Company",
  department: "Department",
  project: "Project",
  teammate: "Teammate",
};
/** What a listed budget is on: a goal's cap is listed here too, though it is set from the goal. */
const LISTED_SCOPE_LABEL: Record<Budget["scopeKind"], string> = { ...SCOPE_LABEL, goal: "Goal" };

/** A budget's window as a person reads it; "goal" is a goal's lifetime cap. */
const WINDOW_PHRASE: Record<Budget["window"], string> = {
  day: "a day",
  week: "a week",
  month: "a month",
  goal: "for the goal",
};

/** "1.69M of 3.00M a week", "0 of 500.0k for the goal". */
export function budgetLine(b: Pick<Budget, "used" | "tokensLimit" | "window">): string {
  return `${fmtTokens(b.used)} of ${fmtTokens(b.tokensLimit)} ${WINDOW_PHRASE[b.window] ?? b.window}`;
}

export function scopeName(data: CompanyData, b: Pick<Budget, "scopeKind" | "scopeId">): string {
  switch (b.scopeKind) {
    case "company":
      return data.company.name;
    case "department":
      return data.departments.find((d) => d.id === b.scopeId)?.name ?? "a department";
    case "project":
      return data.projects.find((p) => p.id === b.scopeId)?.name ?? "a project";
    case "teammate":
      return data.teammates.find((t) => t.id === b.scopeId)?.name ?? "a teammate";
    case "goal":
      return data.goals.find((g) => g.id === b.scopeId)?.title ?? "a goal";
  }
}

function PriceForm({
  currency: theirs,
  onSave,
}: {
  /** The company's one currency; null before its first price, which chooses it. */
  currency: string | null;
  /** Resolves true when the price was saved; the form then clears. */
  onSave(input: ModelPriceInput): Promise<boolean>;
}) {
  const [typed, setTyped] = useState("GBP");
  const currency = theirs ?? typed;
  const [model, setModel] = useState("");
  const [kind, setKind] = useState<"api" | "seat">("api");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [cacheRead, setCacheRead] = useState("");
  const [cacheWrite, setCacheWrite] = useState("");
  const [seat, setSeat] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model.trim()) return;
    setBusy(true);
    try {
      const saved = await onSave(
        kind === "api"
          ? {
              model: model.trim(),
              currency,
              inputPerMillion: toMinor(input),
              outputPerMillion: toMinor(output),
              cacheReadPerMillion: toMinor(cacheRead),
              cacheWritePerMillion: toMinor(cacheWrite),
              seatPriceMonth: null,
            }
          : { model: model.trim(), currency, seatPriceMonth: toMinor(seat) },
      );
      if (!saved) return;
      setModel("");
      setInput("");
      setOutput("");
      setCacheRead("");
      setCacheWrite("");
      setSeat("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="fields" onSubmit={submit}>
      <Field label={kind === "api" ? "Model" : "Model or engine"}>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={kind === "api" ? DEFAULT_MODEL : "claude_code"}
          style={{ width: 180 }}
        />
      </Field>
      <Field label="Billing">
        <select value={kind} onChange={(e) => setKind(e.target.value as "api" | "seat")}>
          <option value="api">API · per 1M tokens</option>
          <option value="seat">Seat · per month</option>
        </select>
      </Field>
      {theirs === null ? (
        <Field
          label="Currency"
          hint="The first price sets the company's one currency. Anthropic's list prices are in USD."
        >
          <input
            aria-label="Currency"
            className="mono"
            value={typed}
            maxLength={3}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            style={{ width: 60 }}
          />
        </Field>
      ) : null}
      {kind === "api" ? (
        <>
          <Field label={`Input (${currency})`}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="2.40"
              style={{ width: 90 }}
            />
          </Field>
          <Field label="Output">
            <input
              value={output}
              onChange={(e) => setOutput(e.target.value)}
              placeholder="12.00"
              style={{ width: 90 }}
            />
          </Field>
          <Field label="Cache read">
            <input
              value={cacheRead}
              onChange={(e) => setCacheRead(e.target.value)}
              placeholder="0.24"
              style={{ width: 90 }}
            />
          </Field>
          <Field label="Cache write">
            <input
              value={cacheWrite}
              onChange={(e) => setCacheWrite(e.target.value)}
              placeholder="3.00"
              style={{ width: 90 }}
            />
          </Field>
        </>
      ) : (
        <Field label={`Per seat per month (${currency})`}>
          <input
            value={seat}
            onChange={(e) => setSeat(e.target.value)}
            placeholder="200"
            style={{ width: 120 }}
          />
        </Field>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={busy || !model.trim() || !/^[A-Z]{3}$/.test(currency)}
      >
        Save price
      </Button>
    </form>
  );
}

function BudgetForm({
  data,
  onSave,
}: {
  data: CompanyData;
  /** Resolves true when the budget was set; the form then clears. */
  onSave(input: BudgetInput): Promise<boolean>;
}) {
  const [kind, setKind] = useState<BudgetScopeKind>("company");
  const [scopeId, setScopeId] = useState("");
  const [limit, setLimit] = useState("");
  const [window, setWindow] = useState<BudgetWindow>("week");
  const [busy, setBusy] = useState(false);
  const options =
    kind === "department"
      ? data.departments.map((d) => ({ id: d.id, name: d.name }))
      : kind === "project"
        ? data.projects.map((p) => ({ id: p.id, name: p.name }))
        : kind === "teammate"
          ? data.teammates.map((t) => ({ id: t.id, name: t.name }))
          : [];
  const chosen = kind === "company" ? "company" : scopeId || options[0]?.id || "";
  const tokens = Math.round(Number(limit.replace(/[,_\s]/g, "")) || 0);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen || tokens <= 0) return;
    setBusy(true);
    try {
      const saved = await onSave({
        scopeKind: kind,
        ...(kind === "company" ? {} : { scopeId: chosen }),
        tokensLimit: tokens,
        window,
      });
      if (saved) setLimit("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="fields" onSubmit={submit}>
      <Field label="Scope">
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as BudgetScopeKind);
            setScopeId("");
          }}
        >
          {(Object.keys(SCOPE_LABEL) as BudgetScopeKind[]).map((k) => (
            <option key={k} value={k}>
              {SCOPE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      {kind !== "company" ? (
        <Field label={SCOPE_LABEL[kind]}>
          <select value={chosen} onChange={(e) => setScopeId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label="Tokens">
        <input
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder="3000000"
          style={{ width: 130 }}
        />
      </Field>
      <Field label="Per">
        <select value={window} onChange={(e) => setWindow(e.target.value as BudgetWindow)}>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
      </Field>
      <Button type="submit" variant="primary" disabled={busy || !chosen || tokens <= 0}>
        Set budget
      </Button>
    </form>
  );
}

/** What a fill with list prices did, in a sentence. */
export function listPricesLine(r: ListPricesResult): string {
  const parts: string[] = [];
  if (r.added.length) parts.push(`Priced ${r.added.join(", ")} at the API list price.`);
  else parts.push("Every model in use with a list price already has a price.");
  if (r.unknown.length)
    parts.push(
      `No list price for ${r.unknown.join(", ")}: add ${r.unknown.length === 1 ? "it" : "them"} by hand.`,
    );
  return parts.join(" ");
}

function PricesTab(p: SettingsViewProps) {
  const [prices, setPrices] = useState<ModelPrice[]>(p.initialPrices ?? []);
  const [budgets, setBudgets] = useState<Budget[]>(p.initialBudgets ?? []);
  const [error, setError] = useState<string | null>(null);
  const [filled, setFilled] = useState<string | null>(null);
  const latestSeq = p.data.events[0]?.seq ?? 0;
  const reload = async () => {
    try {
      const [pr, bu] = await Promise.all([p.loadPrices(), p.loadBudgets()]);
      setPrices(pr);
      setBudgets(bu);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // A new event (a run finished, a price changed elsewhere) refreshes what a budget has used.
  useEffect(() => {
    void reload();
  }, [p.data.company.id, latestSeq]);
  // The company's one currency is its prices'; before it has any, its first price chooses it.
  const currency = prices[0]?.currency ?? null;
  // A provider's prices are on its card under Models.
  const ownPrices = prices.filter((pr) => !pr.providerId);
  /** Run a write and reload; true when it went through. */
  const wrap = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  const columns = p.canEdit ? 7 : 6;
  return (
    <>
      {error ? <Pill tone="bad">{error}</Pill> : null}

      <div className="card flex flex-col gap-3 px-[18px] py-4">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold">Model prices</span>
          <span className="hint">
            Per million tokens for API billing, or per seat per month for subscription engines. A seat row is
            keyed by the model, or by the engine (claude_code, codex) for every teammate on it. Costs on the
            Costs page use these; nothing here touches how teammates run. These are the board's own models'; a
            provider's prices are on its card under Models.
          </span>
        </div>
        {p.canEdit ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Button onClick={wrap(async () => setFilled(listPricesLine(await p.fillListPrices())))}>
                Add list prices
              </Button>
              <span className="hint">
                Prices every Claude model the company uses and has not priced, in USD, unless the company
                prices in another currency. Prices you set stay.
              </span>
            </div>
            <span className="hint">
              List prices are what the same tokens cost on the Anthropic API. On a subscription (the CLI's
              sign-in), the plan is what you pay: add a seat price for claude_code to see that instead.
            </span>
            {filled ? <span>{filled}</span> : null}
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="costs">
            <thead>
              <tr>
                <th className="whitespace-nowrap">Model or engine</th>
                <th className="text-right">Input</th>
                <th className="text-right">Output</th>
                <th className="text-right whitespace-nowrap">Cache read</th>
                <th className="text-right whitespace-nowrap">Cache write</th>
                <th className="text-right whitespace-nowrap">Seat / month</th>
                {p.canEdit ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {ownPrices.map((pr) => (
                <tr key={pr.id}>
                  <td className="font-semibold">{pr.model}</td>
                  <td className="mono text-right">{money(pr.inputPerMillion, pr.currency)}</td>
                  <td className="mono text-right">{money(pr.outputPerMillion, pr.currency)}</td>
                  <td className="mono text-right">{money(pr.cacheReadPerMillion, pr.currency)}</td>
                  <td className="mono text-right">{money(pr.cacheWritePerMillion, pr.currency)}</td>
                  <td className="mono text-right">{money(pr.seatPriceMonth, pr.currency)}</td>
                  {p.canEdit ? (
                    <td className="text-right">
                      <Tip text="Remove price">
                        <Button
                          size="sm"
                          aria-label="Remove price"
                          onClick={wrap(() => p.deletePrice(pr.id))}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </Tip>
                    </td>
                  ) : null}
                </tr>
              ))}
              {ownPrices.length === 0 ? (
                <tr>
                  <td className="hint" colSpan={columns}>
                    No prices yet. Runs count tokens either way; money needs a price.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {p.canEdit ? <PriceForm currency={currency} onSave={(i) => wrap(() => p.savePrice(i))()} /> : null}
      </div>

      <div className="card flex flex-col gap-3 px-[18px] py-4">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold">Budgets</span>
          <span className="hint">
            Token budgets per scope and window. Activity gets an alert at 80% and 100%; a run that would start
            over a spent budget waits on the board instead. A goal's own cap, set by Peter, shows here too.
          </span>
        </div>
        <table className="costs">
          <tbody>
            {budgets.map((b) => (
              <tr key={b.id}>
                <td>
                  <span className="font-semibold">{scopeName(p.data, b)}</span>
                  <span className="hint"> · {LISTED_SCOPE_LABEL[b.scopeKind]}</span>
                </td>
                <td className="mono text-right whitespace-nowrap">{budgetLine(b)}</td>
                <td className="text-right">
                  <Pill tone={b.percent >= 100 ? "bad" : b.percent >= 80 ? "warn" : "ok"}>{b.percent}%</Pill>
                </td>
                {p.canEdit ? (
                  <td className="text-right">
                    <Tip text="Remove budget">
                      <Button size="sm" aria-label="Remove budget" onClick={wrap(() => p.deleteBudget(b.id))}>
                        <Trash2 size={14} />
                      </Button>
                    </Tip>
                  </td>
                ) : null}
              </tr>
            ))}
            {budgets.length === 0 ? (
              <tr>
                <td className="hint" colSpan={p.canEdit ? 4 : 3}>
                  No budgets yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {p.canEdit ? <BudgetForm data={p.data} onSave={(i) => wrap(() => p.saveBudget(i))()} /> : null}
      </div>
    </>
  );
}

export function SettingsView(p: SettingsViewProps) {
  return (
    <>
      <Topbar title="Settings" subtitle={p.data.company.name} />
      <Tabs className="contents" value={p.tab} onValueChange={(v) => p.onTab(v as SettingsTab)}>
        <TabsList className="settings-tabs">
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={p.tab}>
          <div className="content">
            <div className="company scroll" style={{ gap: 16 }}>
              {p.tab === "prices" ? <PricesTab {...p} /> : null}
              {p.tab === "models" ? <ModelsPanel {...p.models} data={p.data} canEdit={p.canEdit} /> : null}
              {p.tab === "style" ? (
                <StyleCard
                  canEdit={p.canEdit}
                  load={p.loadStyles}
                  onSet={p.setStyle}
                  {...(p.initialStyles ? { initial: p.initialStyles } : {})}
                />
              ) : null}
              {p.tab === "connections" ? (
                <>
                  <div className="card flex flex-col gap-1 px-[18px] py-4">
                    <span className="font-semibold">Secrets</span>
                    <span className="hint">
                      Names only. Teammates refer to credentials by name; values live in the cluster secret
                      store and are handed to a run's engine process by the worker. Nothing here or anywhere
                      on the board holds a value.
                    </span>
                  </div>
                  <ConnectionsPanel
                    {...p.connections}
                    connections={p.data.connections}
                    canEdit={p.canEdit}
                    companyId={p.data.company.id}
                  />
                  <ClientPoliciesPanel
                    data={p.data}
                    canEdit={p.canEdit}
                    saveClientPolicy={p.saveClientPolicy}
                  />
                </>
              ) : null}
              {p.tab === "notifications" ? (
                <NotificationsCard
                  settings={p.data.company.settings}
                  canEdit={p.canEdit}
                  onSave={p.saveNotifySettings}
                  onTest={p.testNotify}
                />
              ) : null}
              {p.tab === "drift" ? (
                <DriftCard
                  settings={p.data.company.settings}
                  canEdit={p.canEdit}
                  onSave={p.saveDriftSettings}
                />
              ) : null}
              {p.tab === "templates" ? (
                <TemplatesCard
                  canEdit={p.canEdit}
                  exportUrl={p.templatesExportUrl}
                  onImport={p.importTemplates}
                />
              ) : null}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
