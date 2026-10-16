import type { ToolMode, UpdateTeammateInput } from "@rosterdock/shared";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { CompanyData, Inbox, Teammate } from "../api/types.ts";
import { Avatar, Button, Dot, Empty, Field, Tip, Topbar } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { driftLine, engineChoices, relativeTime, standingDrift, teammateStatus } from "../lib/format.ts";
import { ConnectionGrant } from "./ToolboxEditor.tsx";

export interface TeammatesViewProps {
  data: CompanyData;
  selectedId: string | null;
  onSelect(id: string): void;
  onHire(): void;
  onSave(id: string, input: UpdateTeammateInput): Promise<void>;
  /** The teammate's inbox: what is addressed to them, new since their last run. */
  loadInbox(teammateId: string): Promise<Inbox>;
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

function Editor({
  t,
  data,
  onSave,
  loadInbox,
}: {
  t: Teammate;
  data: CompanyData;
  onSave: TeammatesViewProps["onSave"];
  loadInbox: TeammatesViewProps["loadInbox"];
}) {
  const [form, setForm] = useState({
    name: t.name,
    role: t.role,
    engine: t.engine,
    model: t.model,
    effort: t.effort ?? "",
    personaMd: t.personaMd,
    playbooks: t.playbooks.join("\n\n---\n\n"),
  });
  const [toolbox, setToolbox] = useState<Record<string, ToolMode>>(toolboxMap(t));
  /** Per connection: the tool names picked, or null for every tool. */
  const [picked, setPicked] = useState<Record<string, string[] | null>>(pickedMap(t));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm({
      name: t.name,
      role: t.role,
      engine: t.engine,
      model: t.model,
      effort: t.effort ?? "",
      personaMd: t.personaMd,
      playbooks: t.playbooks.join("\n\n---\n\n"),
    });
    setToolbox(toolboxMap(t));
    setPicked(pickedMap(t));
  }, [t.id, t.updatedAt, t.name, t.role, t.engine, t.model, t.effort, t.personaMd, t.playbooks, t.toolbox]);
  const dirty =
    form.name !== t.name ||
    form.role !== t.role ||
    form.engine !== t.engine ||
    form.model !== t.model ||
    form.effort !== (t.effort ?? "") ||
    form.personaMd !== t.personaMd ||
    form.playbooks !== t.playbooks.join("\n\n---\n\n") ||
    JSON.stringify(toolbox) !== JSON.stringify(toolboxMap(t)) ||
    JSON.stringify(grantedPicks(toolbox, picked)) !==
      JSON.stringify(grantedPicks(toolboxMap(t), pickedMap(t)));
  const st = teammateStatus(t, data.tasks);
  const drift = standingDrift(t, data.events);
  const save = async () => {
    setBusy(true);
    try {
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
        toolbox: Object.entries(toolbox)
          .filter(([, mode]) => mode !== "off")
          .map(([connection, mode]) => ({
            connection,
            mode,
            ...(picked[connection] != null ? { tools: picked[connection] } : {}),
          })),
      });
    } finally {
      setBusy(false);
    }
  };
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
        <Field
          label="Effort"
          hint="How hard the model thinks on each run. Higher is slower and costs more; Default is the engine's own."
        >
          <select value={form.effort} onChange={(e) => setForm({ ...form, effort: e.target.value })}>
            {EFFORT_CHOICES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
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
                onChange={(g) => {
                  setToolbox({ ...toolbox, [c.name]: g.mode });
                  setPicked({ ...picked, [c.name]: g.picked });
                }}
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

function toolboxMap(t: Teammate): Record<string, ToolMode> {
  return Object.fromEntries(t.toolbox.map((e) => [e.connection, e.mode]));
}

function pickedMap(t: Teammate): Record<string, string[] | null> {
  return Object.fromEntries(t.toolbox.map((e) => [e.connection, e.tools ?? null]));
}

/** The picks that matter: only on connections that are granted, in a stable shape for a dirty check. */
function grantedPicks(
  toolbox: Record<string, ToolMode>,
  picked: Record<string, string[] | null>,
): Record<string, string[] | null> {
  return Object.fromEntries(
    Object.entries(toolbox)
      .filter(([, mode]) => mode !== "off")
      .map(([c]) => [c, picked[c] ? [...picked[c]!].sort() : null]),
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
            <Editor key={selected.id} t={selected} data={data} onSave={p.onSave} loadInbox={p.loadInbox} />
          ) : (
            <Empty>Hire a teammate from a template to start.</Empty>
          )}
        </div>
      </div>
    </>
  );
}
