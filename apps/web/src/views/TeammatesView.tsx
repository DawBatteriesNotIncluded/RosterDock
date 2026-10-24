import type { PlannerKind, PlannerSettings, ToolMode, UpdateTeammateInput } from "@rosterdock/shared";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { CompanyData, Inbox, PlannerInfo, Teammate, ToolboxEntry } from "../api/types.ts";
import { Avatar, Button, Dot, Empty, Field, Tip, Topbar } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { driftLine, engineChoices, relativeTime, standingDrift, teammateStatus } from "../lib/format.ts";
import { companyManager } from "./office/layout.ts";
import { ConnectionGrant, type Grant } from "./ToolboxEditor.tsx";

export interface TeammatesViewProps {
  data: CompanyData;
  selectedId: string | null;
  onSelect(id: string): void;
  onHire(): void;
  onSave(id: string, input: UpdateTeammateInput): Promise<void>;
  /** The teammate's inbox: what is addressed to them, new since their last run. */
  loadInbox(teammateId: string): Promise<Inbox>;
  /** What Peter can plan with on this board and the company's choice; `refresh` asks the CLIs again. */
  loadPlanner(refresh?: boolean): Promise<PlannerInfo>;
  /** Saves what Peter, and the department leads with him, plan with: the company's choice. */
  savePlanner(choice: PlannerSettings): Promise<void>;
  initialPlanner?: PlannerInfo;
}

/** The effort levels a person picks from; "" is the engine's own default. */
export const EFFORT_CHOICES: [string, string][] = [
  ["", "Default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
];

/** Peter's brains by name, for his picker before the board has said which work here. */
const PLANNER_LABEL: Record<PlannerKind, string> = {
  claude_cli: "Claude Code CLI",
  codex_cli: "Codex CLI",
  api: "Anthropic API",
};

/**
 * Peter's engine picker: Automatic, every brain the board offers him (one that does not work here says so), and
 * no model. Peter plans on the board, not on a worker, so his engines are what the board itself can reach.
 */
export function plannerChoices(
  info: Pick<PlannerInfo, "options"> | null,
  current: PlannerSettings["via"],
): [PlannerSettings["via"], string][] {
  const options = info?.options ?? [];
  // Before the board answers, the saved choice is still offered, so the picker shows it.
  const saved =
    current !== "auto" && current !== "none" && !options.some((o) => o.kind === current)
      ? [[current, PLANNER_LABEL[current]] as [PlannerKind, string]]
      : [];
  return [
    ["auto", "Automatic"],
    ...options.map((o): [PlannerKind, string] => [
      o.kind,
      o.available ? o.label : `${o.label} (not available here)`,
    ]),
    ...saved,
    ["none", "No model (plans by role)"],
  ];
}

/** What the chosen engine comes to, under Peter's picker. */
export function plannerHint(info: Pick<PlannerInfo, "options"> | null, via: PlannerSettings["via"]): string {
  if (via === "auto")
    return "The first that works here: the Claude Code CLI, then the Codex CLI, then an API key.";
  if (via === "none")
    return "Peter splits every goal by role (research, requirements, build) and asks no questions.";
  return info?.options.find((o) => o.kind === via)?.detail ?? "Asking the board whether it works here…";
}

/** What Peter plans with right now, in a sentence. */
export function plannerLine(info: Pick<PlannerInfo, "effective" | "options" | "choice">): string {
  const label = info.options.find((o) => o.kind === info.effective)?.label;
  if (label)
    return `Peter plans with the ${label}${info.choice.via === "auto" ? ", chosen automatically" : ""}.`;
  if (info.choice.via === "none") return "Peter plans by role, without a model.";
  if (info.choice.via === "auto") return "Nothing works on this board yet, so Peter plans by role.";
  const chosen = info.options.find((o) => o.kind === info.choice.via)?.label ?? info.choice.via;
  return `The ${chosen} does not work on this board, so Peter plans by role until it does.`;
}

/** Peter's choice as Save sends it: a model only with the Codex CLI, the one brain that takes it from here. */
export function plannerChoice(p: PlannerSettings): PlannerSettings {
  const model = p.model?.trim();
  return { via: p.via, ...(p.via === "codex_cli" && model ? { model } : {}) };
}

const PLANNER_VIAS: readonly string[] = ["auto", "claude_cli", "codex_cli", "api", "none"];

/**
 * The company's choice of Peter's brain from its settings (`settings.planner`), as the board reads it:
 * Automatic when there is none. At hand with the company, before the board has asked its CLIs anything.
 */
export function plannerOf(settings: Record<string, unknown>): PlannerSettings {
  const p = (settings.planner ?? {}) as { via?: unknown; model?: unknown };
  const via = typeof p.via === "string" && PLANNER_VIAS.includes(p.via) ? p.via : "auto";
  return plannerChoice({
    via: via as PlannerSettings["via"],
    ...(typeof p.model === "string" ? { model: p.model } : {}),
  });
}

function InboxPanel({ t, load }: { t: Teammate; load: TeammatesViewProps["loadInbox"] }) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  useEffect(() => {
    let alive = true;
    void load(t.id).then((i) => alive && setInbox(i));
    return () => {
      alive = false;
    };
  }, [t.id, t.updatedAt, load]);
  if (!inbox) return null;
  return (
    <>
      <span className="eyebrow">Inbox{inbox.unread ? ` · ${inbox.unread} new since the last run` : ""}</span>
      {inbox.items.length ? (
        <div className="flex flex-col gap-1">
          {inbox.items.slice(0, 12).map((i) => (
            <div key={i.id} className="flex items-center gap-2 text-[13px]">
              <Dot tone={i.unread ? "info" : "idle"} />
              <span className={cn(!i.unread && "text-muted")}>{i.text}</span>
              <span className="text-muted text-[12px] ml-auto">{relativeTime(i.at)}</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="text-muted text-[13px]">Nothing addressed to {t.name} yet.</span>
      )}
    </>
  );
}

/** What the editor edits: the teammate's fields as the form shows them, and its toolbox by connection. */
export interface TeammateDraft {
  form: {
    name: string;
    role: string;
    engine: string;
    model: string;
    effort: string;
    personaMd: string;
    playbooks: string;
  };
  /** The mode on each connection; one set to off is not saved. */
  toolbox: Record<string, ToolMode>;
  /** Per connection: the tool names picked, or null for every tool. */
  picked: Record<string, string[] | null>;
}

export function draftOf(t: Teammate): TeammateDraft {
  return {
    form: {
      name: t.name,
      role: t.role,
      engine: t.engine,
      model: t.model,
      effort: t.effort ?? "",
      personaMd: t.personaMd,
      playbooks: t.playbooks.join("\n\n---\n\n"),
    },
    toolbox: Object.fromEntries(t.toolbox.map((e) => [e.connection, e.mode])),
    picked: Object.fromEntries(t.toolbox.map((e) => [e.connection, e.tools ?? null])),
  };
}

/** One connection's grant changed, tool by tool or for a whole group. */
export function withGrant(d: TeammateDraft, connection: string, g: Grant): TeammateDraft {
  return {
    ...d,
    toolbox: { ...d.toolbox, [connection]: g.mode },
    picked: { ...d.picked, [connection]: g.picked },
  };
}

/** The toolbox Save sends: a line per connection granted, naming its tools when not every one is. */
export function toolboxLines(d: Pick<TeammateDraft, "toolbox" | "picked">): ToolboxEntry[] {
  return Object.entries(d.toolbox)
    .filter(([, mode]) => mode !== "off")
    .map(([connection, mode]) => ({
      connection,
      mode,
      ...(d.picked[connection] != null ? { tools: d.picked[connection] } : {}),
    }));
}

/** A draft as one string: two drafts that save the same thing read the same, whatever the order. */
function draftKey(d: TeammateDraft): string {
  const lines = toolboxLines(d)
    .map((l) => (l.tools ? { ...l, tools: [...l.tools].sort() } : l))
    .sort((a, b) => a.connection.localeCompare(b.connection));
  return JSON.stringify([d.form, lines]);
}

/** The editor: the teammate as saved (which version, and what it holds) and the person's draft of it. */
export interface EditorState {
  savedAt: string;
  saved: string;
  draft: TeammateDraft;
}

export function editorState(t: Teammate): EditorState {
  const draft = draftOf(t);
  return { savedAt: `${t.id} ${t.updatedAt}`, saved: draftKey(draft), draft };
}

/** Whether Save has something to send: any field, a connection's mode, or one tool picked or dropped. */
export function draftDirty(s: EditorState): boolean {
  return draftKey(s.draft) !== s.saved;
}

/**
 * The editor after the company's data is fetched again, which every event in the company does. The draft
 * stays unless the teammate as saved changed (a save here, or someone else's): a refresh that brings the
 * same teammate back must not drop a grant nobody has saved yet.
 */
export function refreshed(s: EditorState, t: Teammate): EditorState {
  const now = editorState(t);
  return now.savedAt === s.savedAt && now.saved === s.saved ? s : now;
}

/** Peter's brain, for his editor alone: what the board offers him and the company's choice. */
interface PlannerAccess {
  load: TeammatesViewProps["loadPlanner"];
  save: TeammatesViewProps["savePlanner"];
  initial?: PlannerInfo;
}

function Editor({
  t,
  data,
  onSave,
  loadInbox,
  planner,
}: {
  t: Teammate;
  data: CompanyData;
  onSave: TeammatesViewProps["onSave"];
  loadInbox: TeammatesViewProps["loadInbox"];
  /** Only for the company's project manager: he plans on the board, so his engine is the company's choice. */
  planner: PlannerAccess | null;
}) {
  const [state, setState] = useState(() => editorState(t));
  useEffect(() => setState((s) => refreshed(s, t)), [t]);
  const { form, toolbox, picked } = state.draft;
  const setForm = (next: TeammateDraft["form"]) =>
    setState((s) => ({ ...s, draft: { ...s.draft, form: next } }));
  // Peter's engine as the company saved it and as picked. The draft follows a save landing, here or in another
  // browser, and keeps a Codex model typed while another engine is picked; Save sends it only with the Codex
  // CLI. What each engine comes to here (signed in or not) waits on the board asking its CLIs.
  const savedPlan = JSON.stringify(plannerOf(data.company.settings));
  const [plan, setPlan] = useState<PlannerSettings>(() => JSON.parse(savedPlan) as PlannerSettings);
  useEffect(() => setPlan(JSON.parse(savedPlan) as PlannerSettings), [savedPlan]);
  const [info, setInfo] = useState<PlannerInfo | null>(planner?.initial ?? null);
  const [unasked, setUnasked] = useState(false);
  const ask = () =>
    planner?.load().then(
      (next) => {
        setInfo(next);
        setUnasked(false);
      },
      () => setUnasked(true),
    );
  useEffect(() => {
    if (planner && !planner.initial) void ask();
  }, []);
  const planDirty = !!planner && JSON.stringify(plannerChoice(plan)) !== savedPlan;
  const [busy, setBusy] = useState(false);
  const dirty = draftDirty(state) || planDirty;
  const st = teammateStatus(t, data.tasks);
  const drift = standingDrift(t, data.events);
  const save = async () => {
    setBusy(true);
    try {
      // What he plans with now follows from the board once the choice is saved.
      if (planner && planDirty) await planner.save(plannerChoice(plan)).then(ask);
      if (draftDirty(state))
        await onSave(t.id, {
          name: form.name,
          role: form.role,
          engine: form.engine as UpdateTeammateInput["engine"],
          model: form.model,
          effort: (form.effort || null) as UpdateTeammateInput["effort"],
          personaMd: form.personaMd,
          playbooks: form.playbooks
            .split(/\n\s*---\s*\n/)
            .map((s) => s.trim())
            .filter(Boolean),
          toolbox: toolboxLines(state.draft),
        });
    } finally {
      setBusy(false);
    }
  };
  const effortField = (on: string) => (
    <Field
      label="Effort"
      hint={`How hard the model thinks on each ${on}. Higher is slower and costs more; Default is the engine's own.`}
    >
      <select value={form.effort} onChange={(e) => setForm({ ...form, effort: e.target.value })}>
        {EFFORT_CHOICES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="editor">
      <div className="row">
        <div className="flex items-center gap-3">
          <Avatar name={t.name} handle={t.handle} size="xl" />
          <div className="flex flex-col">
            <span className="text-[18px] font-semibold">{t.name}</span>
            <span className={cn("status", st.tone === "bad" && "bad", st.tone === "info" && "info")}>
              <Dot tone={st.tone} />
              {st.text}
            </span>
            {drift.map((e) => (
              <Tip key={e.id} text="Against this teammate's own recent history">
                <span className="status">
                  <Dot tone="warn" />
                  {driftLine(e.payload as Record<string, unknown>)}
                </span>
              </Tip>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
      <div className="grid2">
        <Field label="Name" hint={`Handle: @${t.handle}`}>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Role">
          <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
        </Field>
      </div>
      <InboxPanel t={t} load={loadInbox} />
      <span className="eyebrow">Brain</span>
      {planner ? (
        <>
          <div className="grid2">
            <Field label="Engine" hint={plannerHint(info, plan.via)}>
              <select
                value={plan.via}
                onChange={(e) => setPlan({ ...plan, via: e.target.value as PlannerSettings["via"] })}
              >
                {plannerChoices(info, plan.via).map(([via, label]) => (
                  <option key={via} value={via}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {plan.via === "codex_cli" ? (
              <Field label="Model" hint="Empty takes Codex's own default.">
                <input
                  value={plan.model ?? ""}
                  placeholder="Codex's default"
                  onChange={(e) => setPlan({ ...plan, model: e.target.value })}
                  className="mono"
                />
              </Field>
            ) : (
              <Field
                label="Model"
                hint={
                  plan.via === "none"
                    ? "Kept for when he plans with a model again."
                    : "The Claude model he plans with."
                }
              >
                <input
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  className="mono"
                />
              </Field>
            )}
            {effortField("plan")}
          </div>
          <span className="hint">
            {info
              ? plannerLine(info)
              : unasked
                ? "The board did not say what it has; reload to ask again."
                : "Asking the board what it has…"}{" "}
            Peter plans on the board, not on a worker: with a model CLI signed in where the board runs, on its
            own plan, or the Anthropic API with the board&apos;s key. The department leads plan with the same
            engine.
          </span>
        </>
      ) : (
        <div className="grid2">
          <Field label="Engine">
            <select value={form.engine} onChange={(e) => setForm({ ...form, engine: e.target.value })}>
              {engineChoices(form.engine).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Model"
            hint="Set per teammate. A reasoning-heavy profile on a trivial task burns tokens."
          >
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className="mono"
            />
          </Field>
          {effortField("run")}
        </div>
      )}
      <span className="eyebrow">Persona</span>
      <Field label="Job description" hint="Names only: never paste credential values here.">
        <textarea value={form.personaMd} onChange={(e) => setForm({ ...form, personaMd: e.target.value })} />
      </Field>
      <Field label="Playbooks" hint="Separate playbooks with a line containing only ---">
        <textarea
          value={form.playbooks}
          onChange={(e) => setForm({ ...form, playbooks: e.target.value })}
          style={{ minHeight: 90 }}
        />
      </Field>
      <span className="eyebrow">Departments</span>
      <div className="chips">
        {t.departments.map((d) => (
          <span key={d.id} className="chipmate" style={{ padding: "3px 8px" }}>
            {d.name}
            {d.isLead ? " · lead" : ""}
          </span>
        ))}
        {t.departments.length === 0 ? (
          <span className="text-[12px] text-muted">Not in a department yet. Seat them in Departments.</span>
        ) : null}
      </div>
      <span className="eyebrow">Toolbox</span>
      <div className="card mcp">
        {data.connections.length === 0 ? (
          <span className="text-[13px] text-muted">
            No connections yet. Add one in Settings; then grant it here with a mode.
          </span>
        ) : (
          <div className="flex flex-col gap-2">
            {data.connections.map((c) => (
              <ConnectionGrant
                key={c.id}
                connection={c}
                grant={{ mode: toolbox[c.name] ?? "off", picked: picked[c.name] ?? null }}
                onChange={(g) => setState((s) => ({ ...s, draft: withGrant(s.draft, c.name, g) }))}
              />
            ))}
            <span className="text-[12px] text-muted">
              This is the ceiling. Reads you allow run; writes you allow wait for you in Approvals; anything
              set to never is not listed to the teammate and refused if called. A read-only department caps a
              connection at read for its tasks; a project's client policy caps it again. Nothing widens it.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function TeammatesView(p: TeammatesViewProps) {
  const { data } = p;
  const selected = data.teammates.find((t) => t.id === p.selectedId) ?? data.teammates[0];
  const grouped = data.departments.map((d) => ({
    d,
    mates: d.members
      .map((m) => data.teammates.find((t) => t.id === m.teammateId))
      .filter((t): t is Teammate => !!t),
  }));
  const seated = new Set(grouped.flatMap((g) => g.mates.map((m) => m.id)));
  const unseated = data.teammates.filter((t) => !seated.has(t.id));
  const managerId = companyManager(data.teammates);
  const row = (t: Teammate) => (
    <button
      key={t.id}
      className={cn("rmate", selected?.id === t.id && "active")}
      onClick={() => p.onSelect(t.id)}
    >
      <Avatar name={t.name} handle={t.handle} size="m" />
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-semibold">{t.name}</span>
        <span className="truncate text-[12px] text-muted">{t.role}</span>
      </span>
    </button>
  );
  return (
    <>
      <Topbar
        title="Teammates"
        subtitle={`${data.teammates.length} in ${data.company.name}`}
        right={
          <Button variant="primary" onClick={p.onHire}>
            <Plus size={16} />
            <span>Hire from template</span>
          </Button>
        }
      />
      <div className="content">
        <div className="team">
          <div className="roster">
            {grouped.map(({ d, mates }) => (
              <div key={d.id} className="flex flex-col gap-1">
                <span className="eyebrow">{d.name}</span>
                {mates.map(row)}
              </div>
            ))}
            {unseated.length ? (
              <div className="flex flex-col gap-1">
                <span className="eyebrow">Not seated</span>
                {unseated.map(row)}
              </div>
            ) : null}
            {data.teammates.length === 0 ? <Empty>No teammates yet.</Empty> : null}
          </div>
          {selected ? (
            <Editor
              key={selected.id}
              t={selected}
              data={data}
              onSave={p.onSave}
              loadInbox={p.loadInbox}
              planner={
                selected.id === managerId
                  ? {
                      load: p.loadPlanner,
                      save: p.savePlanner,
                      ...(p.initialPlanner ? { initial: p.initialPlanner } : {}),
                    }
                  : null
              }
            />
          ) : (
            <Empty>Hire a teammate from a template to start.</Empty>
          )}
        </div>
      </div>
    </>
  );
}
