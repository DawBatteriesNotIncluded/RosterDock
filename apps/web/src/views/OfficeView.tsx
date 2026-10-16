// The office: teammates at desks in their departments, drawn from the same
// data as the board, and Peter at reception next to your office, since
// everything goes through him. Pixel mode is a canvas of rooms with furniture,
// where people type, read, stand up when blocked, walk to your desk through
// reception when they need you (and wait on its bench when others are ahead),
// and take a break in the kitchen or the lounge when they have nothing on;
// what they write (posts, review comments, verdicts, decisions, asks) shows in
// speech bubbles over their heads and in the conversation list beside it.
// Map mode is an SVG of who is talking to whom. Both are projections of tasks,
// events and live runs. The one thing stored is where the rooms and desks
// stand (settings.office on the company): the rooms are the departments and
// the desks the teammates, and the editor moves only their places. A company
// may give the office images (settings.officePack, written by the board's
// office image routes): a PNG per sprite mode and a floor per room; whatever
// it has not given is drawn in code.
import { useEffect, useRef, useState } from "react";
import type { CompanyData, Run } from "../api/types.ts";
import { Avatar, Button, Pill, Segs, Topbar } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { dialogueLines, LINE_LABEL, shortAge, type Line } from "./office/dialogue.ts";
import {
  officeLayout,
  officeSettings,
  recolorRoom,
  ROOM_COLORS,
  type OfficeSettings,
} from "./office/layout.ts";
import {
  agentMode,
  officeInteractions,
  officePack,
  pendingApprovals,
  POLICY_LABEL,
  SPRITE_MODES,
  teammateColor,
  type Edge,
  type OfficeImage,
} from "./office/model.ts";
import { PixelOffice, withMentions } from "./office/PixelOffice.tsx";

export {
  cellAt,
  companyManager,
  dropDesk,
  dropRoom,
  findPath,
  inRoom,
  officeLayout,
  officeSettings,
  recolorRoom,
  ROOM_COLORS,
  seatOf,
  walkGrid,
  walkable,
} from "./office/layout.ts";
export type { Layout, OfficeSettings, Room } from "./office/layout.ts";
export {
  agentMode,
  officeInteractions,
  officePack,
  pendingApprovals,
  roomImageName,
  SPRITE_MODES,
  spriteFrame,
  teammateColor,
} from "./office/model.ts";
export type { Edge, EdgeKind, OfficeImage, OfficePack, SpriteMode } from "./office/model.ts";
export { dialogueLines } from "./office/dialogue.ts";

export type OfficeMode = "pixel" | "map";

export interface OfficeViewProps {
  data: CompanyData;
  liveRuns: Run[];
  meName: string;
  onOpenTask(id: string): void;
  onOpenTeammate(id: string): void;
  onOpenDepartmentBoard(id: string): void;
  onGoApprovals(): void;
  /** Owners and admins may move the rooms and desks. */
  canEdit?: boolean;
  /** Saves settings.office on the company (the whole settings object goes, merged by the caller). */
  onSaveOffice?(office: OfficeSettings): Promise<void>;
  /** Puts one image of the pack (a PNG file) to the board, or forgets one. */
  onPutImage?(name: string, file: File): Promise<void>;
  onDeleteImage?(name: string): Promise<void>;
  /** Where the browser fetches a pack image; the hash makes a replaced image a new URL. */
  imageUrl?(name: string, sha256: string): string;
  /** Tests render the map; the canvas needs a browser. */
  initialMode?: OfficeMode;
}

function InteractionMap({
  data,
  liveRuns,
  scope,
  edges,
  meName,
  onOpenTask,
  onOpenTeammate,
  onGoApprovals,
}: {
  data: CompanyData;
  liveRuns: Run[];
  scope: string;
  edges: Edge[];
  meName: string;
} & Pick<OfficeViewProps, "onOpenTask" | "onOpenTeammate" | "onGoApprovals">) {
  const depts: { id: string; name: string; policy: string; people: string[]; lead: string | null }[] =
    data.departments
      .filter((d) => scope === "all" || d.id === scope)
      .map((d) => ({
        id: d.id,
        name: d.name,
        policy: POLICY_LABEL[d.writePolicy] ?? d.writePolicy,
        lead: d.leadTeammateId,
        people: [
          ...(d.leadTeammateId ? [d.leadTeammateId] : []),
          ...d.members.filter((m) => !m.isLead).map((m) => m.teammateId),
        ],
      }));
  const inDept = new Set(data.departments.flatMap((d) => d.members.map((m) => m.teammateId)));
  const loose = data.teammates.filter((t) => !inDept.has(t.id)).map((t) => t.id);
  if (loose.length && (scope === "all" || scope === "none"))
    depts.push({ id: "none", name: "No department", policy: "", lead: null, people: loose });
  const inScope = new Set(depts.flatMap((d) => d.people));
  const external = [
    ...new Set(edges.flatMap((e) => [e.from, e.to]).filter((id) => id !== "you" && !inScope.has(id))),
  ];
  const W = 960;
  const cols = depts.length + (external.length ? 1 : 0);
  const colW = Math.floor((W - 40) / Math.max(1, cols));
  const nodes: Record<string, { x: number; y: number; dept: string | null; lead: boolean; ghost: boolean }> =
    {};
  let maxRows = 1;
  depts.forEach((d, i) => {
    maxRows = Math.max(maxRows, d.people.length);
    d.people.forEach((id, k) => {
      nodes[id] = {
        x: 20 + i * colW + colW / 2,
        y: 130 + k * 64,
        dept: d.name,
        lead: d.lead === id,
        ghost: false,
      };
    });
  });
  external.forEach((id, k) => {
    const home = data.departments.find((d) => d.members.some((m) => m.teammateId === id));
    nodes[id] = {
      x: 20 + depts.length * colW + colW / 2,
      y: 130 + k * 64,
      dept: home?.name ?? null,
      lead: false,
      ghost: true,
    };
    maxRows = Math.max(maxRows, k + 1);
  });
  const H = 130 + maxRows * 64 + 10;
  nodes.you = { x: W / 2, y: 40, dept: null, lead: false, ghost: false };
  const ring = (id: string) => {
    const mate = data.teammates.find((m) => m.id === id);
    const m = mate ? agentMode(mate, data.tasks, liveRuns).mode : "idle";
    return m === "typing"
      ? "var(--accent)"
      : m === "reading"
        ? "var(--info)"
        : m === "blocked"
          ? "var(--bad)"
          : m === "waiting"
            ? "var(--warn)"
            : "var(--border)";
  };
  const path = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    `M${a.x},${a.y} Q${(a.x + b.x) / 2},${Math.min(a.y, b.y) - 40} ${b.x},${b.y}`;
  const roomRect = (i: number, label: string, sub: string, ghost: boolean) => (
    <g key={`room-${i}`}>
      <rect
        className="room"
        x={24 + i * colW}
        y={88}
        width={colW - 8}
        height={H - 96}
        rx={12}
        {...(ghost ? { strokeDasharray: "6 4", fill: "transparent" } : {})}
      />
      <text className="roomlabel" x={24 + i * colW + 14} y={108}>
        {label.toUpperCase()}
      </text>
      <text
        className="roomlabel"
        x={24 + i * colW + 14}
        y={122}
        style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}
      >
        {sub}
      </text>
    </g>
  );
  return (
    <div className="office-stage" style={{ aspectRatio: (W / H).toFixed(3), minHeight: 320 }}>
      <svg
        className="map"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Interaction map"
      >
        <defs>
          <marker
            id="arr"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
          </marker>
        </defs>
        {depts.map((d, i) => roomRect(i, d.name, d.policy, false))}
        {external.length
          ? roomRect(depts.length, "Other departments", "handoffs crossing the boundary", true)
          : null}
        {edges.map((e, i) => {
          const a = nodes[e.from];
          const b = nodes[e.to];
          if (!a || !b) return null;
          return (
            <path key={i} className={cn("edge", e.kind)} d={path(a, b)} markerEnd="url(#arr)">
              <title>{e.label}</title>
            </path>
          );
        })}
        {Object.entries(nodes).map(([id, n]) => {
          const mate = data.teammates.find((m) => m.id === id);
          const st = mate ? agentMode(mate, data.tasks, liveRuns) : null;
          const go = () => {
            if (id === "you") onGoApprovals();
            else if (st?.task) onOpenTask(st.task.id);
            else onOpenTeammate(id);
          };
          return (
            <g key={id} className="node" opacity={n.ghost ? 0.55 : 1} onClick={go}>
              <circle
                className="status-ring"
                cx={n.x}
                cy={n.y}
                r={22}
                stroke={id === "you" ? "var(--warn)" : ring(id)}
              />
              <circle
                cx={n.x}
                cy={n.y}
                r={17}
                fill={id === "you" ? "#1c1b19" : mate ? teammateColor(mate) : "#888"}
                stroke="var(--surface)"
              />
              <text x={n.x} y={n.y} fill="#fff">
                {id === "you" ? meName.slice(0, 1).toUpperCase() : (mate?.name.slice(0, 1) ?? "?")}
              </text>
              <text className="nlabel" x={n.x} y={n.y + 36}>
                {id === "you"
                  ? `${meName} · ${pendingApprovals(data) ? `${pendingApprovals(data)} to approve` : "approvals"}`
                  : `${mate?.name ?? "?"}${n.lead ? " · lead" : ""}`}
              </text>
              <text className="nlabel" x={n.x} y={n.y + 48} style={{ fill: "var(--muted)", fontSize: 10 }}>
                {id === "you" ? "" : n.ghost ? (n.dept ?? "Unassigned") : (mate?.role ?? "")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** One image of the pack in the editor: what is there, a file to put, and the way to forget it. */
function ImageRow({
  label,
  name,
  image,
  onPut,
  onDelete,
}: {
  label: string;
  name: string;
  image: OfficeImage | undefined;
  onPut(name: string, file: File): Promise<void>;
  onDelete?(name: string): Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const go = async (work: Promise<void>) => {
    setBusy(true);
    try {
      await work;
    } catch {
      // The caller has said what went wrong.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="image-row">
      <span className="name">{label}</span>
      <span className="mono">{image ? `${image.width}×${image.height}` : "drawn in code"}</span>
      <input
        ref={input}
        type="file"
        accept="image/png"
        hidden
        aria-label={`${label}: file`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void go(onPut(name, file));
        }}
      />
      <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {image ? "Replace" : "Upload"}
      </Button>
      {image && onDelete ? (
        <Button size="sm" disabled={busy} onClick={() => void go(onDelete(name))}>
          Remove
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}

export function OfficeView(p: OfficeViewProps) {
  const [mode, setMode] = useState<OfficeMode>(p.initialMode ?? "pixel");
  const [scope, setScope] = useState<string>("all");
  const [isDark, setDark] = useState(false);
  const [editing, setEditing] = useState(false);
  // What the editor moved, shown at once; the board's copy replaces it when the save lands.
  const [draft, setDraft] = useState<OfficeSettings | null>(null);
  const saved = officeSettings(p.data.company.settings);
  const savedKey = JSON.stringify(saved);
  useEffect(() => setDraft(null), [savedKey]);
  const office = draft ?? saved;
  const pack = officePack(p.data.company.settings);
  const putImage = p.onPutImage;
  const edit = (next: OfficeSettings) => {
    setDraft(next);
    void p.onSaveOffice?.(next);
  };
  const customised = Object.keys(office.rooms ?? {}).length + Object.keys(office.desks ?? {}).length > 0;
  useEffect(() => {
    const root = document.documentElement;
    const read = () =>
      setDark(
        root.getAttribute("data-theme") === "dark" ||
          (!root.getAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches),
      );
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  const edges = officeInteractions(p.data, p.liveRuns);
  const [speaking, setSpeaking] = useState<string[]>([]);
  const lines = scopedLines(p.data, scope);
  const scopeName =
    scope === "all"
      ? p.data.company.name
      : (p.data.departments.find((d) => d.id === scope)?.name ?? "No department");
  const nameOf = (id: string) =>
    id === "you" ? p.meName : (p.data.teammates.find((t) => t.id === id)?.name ?? "?");
  const handleOf = (id: string) =>
    id === "you" ? undefined : p.data.teammates.find((t) => t.id === id)?.handle;
  const segs = (
    <Segs
      label="View"
      value={mode}
      onChange={setMode}
      options={[
        { value: "pixel", label: "Pixel office" },
        { value: "map", label: "Interaction map" },
      ]}
    />
  );
  const scopes = (
    <Segs
      label="Scope"
      value={scope}
      onChange={setScope}
      options={[
        { value: "all", label: "Whole company" },
        ...p.data.departments.map((d) => ({ value: d.id, label: d.name })),
      ]}
    />
  );
  return (
    <>
      <Topbar
        title="Office"
        subtitle={`${scopeName} · live`}
        left={scopes}
        right={
          <div className="flex items-center gap-2">
            {segs}
            {p.canEdit && mode === "pixel" ? (
              <Button size="sm" variant={editing ? "primary" : "ghost"} onClick={() => setEditing(!editing)}>
                {editing ? "Done" : "Edit layout"}
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="content">
        <div className="office scroll">
          <div className="office-main">
            {mode === "pixel" ? (
              <PixelOffice
                data={p.data}
                liveRuns={p.liveRuns}
                scope={scope}
                edges={edges}
                lines={lines}
                onSpeaking={setSpeaking}
                meName={p.meName}
                isDark={isDark}
                office={office}
                pack={pack}
                imageUrl={p.imageUrl}
                editing={editing}
                onEdit={edit}
                onScope={setScope}
                onOpenTask={p.onOpenTask}
                onOpenTeammate={p.onOpenTeammate}
                onOpenDepartmentBoard={p.onOpenDepartmentBoard}
                onGoApprovals={p.onGoApprovals}
              />
            ) : (
              <InteractionMap
                data={p.data}
                liveRuns={p.liveRuns}
                scope={scope}
                edges={edges}
                meName={p.meName}
                onOpenTask={p.onOpenTask}
                onOpenTeammate={p.onOpenTeammate}
                onGoApprovals={p.onGoApprovals}
              />
            )}
            <Conversations
              lines={lines}
              speaking={mode === "pixel" ? speaking : []}
              data={p.data}
              onOpenTask={p.onOpenTask}
              onOpenTeammate={p.onOpenTeammate}
            />
          </div>
          {editing && mode === "pixel" ? (
            <div className="office-edit">
              <span className="hint">
                Drag a desk to another spot in its room; drag a room onto another to swap them. Rooms are
                departments and desks are teammates: only their places are yours to move. Peter keeps
                reception.
              </span>
              <div className="rooms">
                {officeLayout(p.data, scope, office).rooms.map((r) => (
                  <div key={r.d.id} className="room-row">
                    <span className="name">{r.d.name}</span>
                    {ROOM_COLORS.map((c, i) => (
                      <button
                        key={c}
                        type="button"
                        className={cn("swatch", r.color === c && "active")}
                        style={{ background: c }}
                        aria-label={`${r.d.name}: colour ${i + 1}`}
                        onClick={() => edit(recolorRoom(office, r.d.id, c))}
                      />
                    ))}
                  </div>
                ))}
              </div>
              {putImage ? (
                <>
                  <span className="hint">
                    Images: a PNG per sprite mode (three frames side by side: standing, then two walking; the
                    feet on the bottom edge) and a floor per room (tiled). What you leave out is drawn in
                    code.
                  </span>
                  <div className="images">
                    {SPRITE_MODES.map((m) => (
                      <ImageRow
                        key={m}
                        label={`Sprite, ${m}`}
                        name={`sprite.${m}`}
                        image={pack[`sprite.${m}`]}
                        onPut={putImage}
                        onDelete={p.onDeleteImage}
                      />
                    ))}
                    <ImageRow
                      label="Floor, any room"
                      name="room.default"
                      image={pack["room.default"]}
                      onPut={putImage}
                      onDelete={p.onDeleteImage}
                    />
                    {officeLayout(p.data, scope, office).rooms.map((r) => (
                      <ImageRow
                        key={r.d.id}
                        label={`Floor, ${r.d.name}`}
                        name={`room.${r.d.id}`}
                        image={pack[`room.${r.d.id}`]}
                        onPut={putImage}
                        onDelete={p.onDeleteImage}
                      />
                    ))}
                  </div>
                </>
              ) : null}
              <div>
                <Button size="sm" disabled={!customised} onClick={() => edit({})}>
                  Reset layout
                </Button>
              </div>
            </div>
          ) : null}
          <div className="legend">
            {mode === "pixel" ? (
              <>
                <span>
                  <span className="sw" style={{ background: "#1b2130" }} />
                  code on the screen = building
                </span>
                <span>
                  <span className="sw" style={{ background: "#eef2f7", border: "1px solid var(--border)" }} />
                  a page on the screen = reading, answering or reviewing
                </span>
                <span>
                  <span className="sw" style={{ background: "var(--bad)" }} />! = blocked, standing by the
                  desk
                </span>
                <span>
                  <span className="sw" style={{ background: "var(--warn)" }} />? = waiting on you: in front of
                  your desk, then on the reception bench
                </span>
                <span>
                  Speech bubbles are what teammates wrote, as they write it (the last few replay while it is
                  quiet); nothing on means a break in the kitchen or the lounge. Envelopes are handoffs:{" "}
                  <b style={{ color: "var(--accent)" }}>task</b>,{" "}
                  <b style={{ color: "var(--info)" }}>mention</b>,{" "}
                  <b style={{ color: "var(--warn)" }}>approval</b>,{" "}
                  <b style={{ color: "var(--bad)" }}>blocked</b>. Click a room to zoom to that department, a
                  teammate or a bubble to open the task, your desk for approvals.
                </span>
              </>
            ) : (
              <>
                <span>
                  <span className="sw" style={{ background: "var(--accent)" }} />
                  created a task for
                </span>
                <span>
                  <span className="sw" style={{ background: "var(--info)" }} />
                  mentioned or answering
                </span>
                <span>
                  <span className="sw" style={{ background: "var(--warn)" }} />
                  waiting on you
                </span>
                <span>
                  <span className="sw" style={{ background: "var(--bad)" }} />
                  blocked on
                </span>
                <span>
                  Ring colour is what they are doing right now. Faded nodes are teammates in other
                  departments.
                </span>
              </>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Handoffs in flight · {edges.length}</span>
            <div className="ticker">
              {edges.map((e, i) => (
                <button
                  key={i}
                  className="tick"
                  onClick={() =>
                    e.taskId
                      ? p.onOpenTask(e.taskId)
                      : e.to === "you"
                        ? p.onGoApprovals()
                        : p.onOpenTeammate(e.to)
                  }
                >
                  <Avatar name={nameOf(e.from)} handle={handleOf(e.from)} you={e.from === "you"} />
                  <span className="text-muted">→</span>
                  <Avatar name={nameOf(e.to)} handle={handleOf(e.to)} you={e.to === "you"} />
                  <span className="grow text-left">{e.label}</span>
                  <Pill
                    tone={
                      e.kind === "task"
                        ? "ok"
                        : e.kind === "approval"
                          ? "warn"
                          : e.kind === "blocked"
                            ? "bad"
                            : "info"
                    }
                  >
                    {e.kind}
                  </Pill>
                </button>
              ))}
              {edges.length === 0 ? (
                <div className="text-[13px] text-muted">Nothing moving between teammates right now.</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** The lines that concern the scope: said by someone in it, or to someone in it. */
function scopedLines(data: CompanyData, scope: string): Line[] {
  const all = dialogueLines(data);
  if (scope === "all") return all;
  const inDept = new Set(data.departments.flatMap((d) => d.members.map((m) => m.teammateId)));
  const members = new Set(
    scope === "none"
      ? data.teammates.filter((t) => !inDept.has(t.id)).map((t) => t.id)
      : (data.departments.find((d) => d.id === scope)?.members.map((m) => m.teammateId) ?? []),
  );
  return all.filter((l) => members.has(l.speaker) || l.to.some((t) => members.has(t.id)));
}

const LINE_TONE: Partial<Record<Line["kind"], "ok" | "warn" | "info" | "bad" | "muted">> = {
  comment: "info",
  changes: "info",
  approved: "info",
  decision: "muted",
  ask: "warn",
  question: "warn",
};

/** What was said, as a chat: oldest at the top, the lines over heads right now marked. */
function Conversations({
  lines,
  speaking,
  data,
  onOpenTask,
  onOpenTeammate,
}: {
  lines: Line[];
  speaking: string[];
  data: CompanyData;
  onOpenTask(id: string): void;
  onOpenTeammate(id: string): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const last = lines[lines.length - 1]?.key;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);
  const handleOf = (id: string) => data.teammates.find((t) => t.id === id)?.handle;
  const now = Date.now();
  return (
    <aside className="office-talk" aria-label="Conversations">
      <div className="head">
        <span className="eyebrow">Conversations</span>
        <span className="mono text-[11px] text-muted">{lines.length}</span>
      </div>
      <div className="lines" ref={list} role="log">
        {lines.map((l) => {
          const mate = data.teammates.find((t) => t.id === l.speaker);
          return (
            <button
              key={l.key}
              type="button"
              className={cn("line", l.kind, speaking.includes(l.key) && "speaking")}
              style={{ "--speaker": mate ? teammateColor(mate) : "var(--ink)" } as React.CSSProperties}
              onClick={() =>
                l.taskId ? onOpenTask(l.taskId) : l.speaker !== "you" && onOpenTeammate(l.speaker)
              }
            >
              <Avatar name={l.speakerName} handle={handleOf(l.speaker)} you={l.speaker === "you"} size="s" />
              <span className="body">
                <span className="who">
                  <b>{l.speakerName}</b>
                  {l.to.length ? <span className="to">→ {l.to.map((t) => t.name).join(", ")}</span> : null}
                  <span className="when">
                    {l.number ? `#${l.number} · ` : ""}
                    {shortAge(l.at, now)}
                  </span>
                </span>
                {LINE_TONE[l.kind] ? (
                  <span className="kind">
                    <Pill tone={LINE_TONE[l.kind]!}>{LINE_LABEL[l.kind]}</Pill>
                    {l.where ? <span className="mono">{l.where}</span> : null}
                  </span>
                ) : null}
                <span className="text">{withMentions(l.text)}</span>
              </span>
            </button>
          );
        })}
        {lines.length === 0 ? (
          <div className="empty">
            Nobody has said anything here yet. When teammates post on a task, ask each other, review or
            decide, their words show over their heads and here.
          </div>
        ) : null}
      </div>
    </aside>
  );
}
