// What the office shows about people, from the board's data: what each
// teammate is doing (from live runs first, the board second), the handoffs in
// flight between them, and the company's office images. Pure.
import type { CompanyData, Run, Task, Teammate } from "../../api/types.ts";
import { avatarTone, isOpenTask } from "../../lib/format.ts";

export type EdgeKind = "task" | "mention" | "review" | "approval" | "blocked";
export type SpriteMode = "typing" | "reading" | "blocked" | "waiting" | "idle";

export interface Edge {
  from: string; // teammate id or "you"
  to: string;
  kind: EdgeKind;
  label: string;
  taskId: string | null;
}

export const POLICY_LABEL: Record<string, string> = {
  readonly: "Read only",
  drafts: "Drafts auto, live writes ask",
  ask: "Every write asks",
};
const TONE_COLORS: Record<string, string> = {
  p: "#4f6bd8",
  r: "#1f7a5c",
  b: "#b0632a",
  a: "#7a4fa8",
  c: "#c98a1c",
  v: "#5c5f6b",
  rp: "#2a8c8c",
};
export const KIND_COLOR: Record<EdgeKind, string> = {
  task: "#1f7a5c",
  approval: "#c98a1c",
  blocked: "#b3261e",
  mention: "#4f6bd8",
  review: "#4f6bd8",
};
export const teammateColor = (t: Pick<Teammate, "handle">) => TONE_COLORS[avatarTone(t.handle)] ?? "#888";

/** Writes waiting for a person: approval rows, not blockers (a task may carry several, or none while one waits). */
export function pendingApprovals(data: Pick<CompanyData, "approvals">): number {
  return (data.approvals ?? []).filter((a) => a.status === "pending").length;
}

/** What a teammate is doing right now, from live runs first and the board second. */
export function agentMode(t: Teammate, tasks: Task[], live: Run[]): { mode: SpriteMode; task: Task | null } {
  const mine = tasks.filter(
    (x) => x.assignee?.kind === "teammate" && x.assignee.id === t.id && isOpenTask(x.status),
  );
  const byId = (id: string) => tasks.find((x) => x.id === id) ?? null;
  const waiting = mine.find((x) => x.blocker?.code === "approval_required");
  if (waiting) return { mode: "waiting", task: waiting };
  const running = live.find((r) => r.teammateId === t.id && r.status === "running");
  if (running) {
    if (running.kind === "turn" || running.kind === "review")
      return { mode: "reading", task: byId(running.taskId) };
    return { mode: /review/i.test(t.role) ? "reading" : "typing", task: byId(running.taskId) };
  }
  const doing = mine.find((x) => x.status === "doing");
  if (doing) return { mode: /review/i.test(t.role) ? "reading" : "typing", task: doing };
  const blocked = mine.find((x) => x.status === "blocked");
  if (blocked) return { mode: "blocked", task: blocked };
  const review = mine.find((x) => x.status === "review");
  if (review) return { mode: "reading", task: review };
  return { mode: "idle", task: mine[0] ?? null };
}

/** Handoffs in flight: tasks filed for someone, mentions, blocks, and asks for you. */
export function officeInteractions(data: CompanyData, live: Run[]): Edge[] {
  const edges: Edge[] = [];
  const name = (id: string) =>
    id === "you" ? "You" : (data.teammates.find((t) => t.id === id)?.name ?? "a teammate");
  const seen = new Set<string>();
  const push = (e: Edge) => {
    const key = `${e.kind}:${e.from}:${e.to}:${e.taskId}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };
  for (const t of data.tasks) {
    if (!isOpenTask(t.status)) continue;
    const to = t.assignee?.kind === "teammate" ? t.assignee.id : null;
    if (to && t.createdBy.kind === "teammate" && t.createdBy.id !== to) {
      push({
        from: t.createdBy.id,
        to,
        kind: "task",
        label: `#${t.number} handed to ${name(to)}`,
        taskId: t.id,
      });
    }
    const w = t.blocker?.waitingOn;
    if (t.status === "blocked" && to && w?.kind === "teammate") {
      const target = data.teammates.find((m) => m.id === w.id || m.handle === w.name || m.handle === w.id);
      if (target && target.id !== to)
        push({
          from: to,
          to: target.id,
          kind: "blocked",
          label: `${name(to)} blocked on ${target.name} · #${t.number}`,
          taskId: t.id,
        });
    }
    if (t.blocker?.code === "approval_required" && to) {
      push({
        from: to,
        to: "you",
        kind: "approval",
        label: `${name(to)} waiting on you · #${t.number}`,
        taskId: t.id,
      });
    }
  }
  // Mentions come from the event stream (newest first); the last few are what is in flight.
  let mentions = 0;
  for (const ev of data.events) {
    if (ev.type !== "message.posted" || mentions >= 12) continue;
    const p = ev.payload as { mentions?: { id: string; name: string }[]; number?: number };
    const from = ev.actor?.kind === "teammate" ? ev.actor.id : "you";
    for (const m of p.mentions ?? []) {
      if (m.id === from) continue;
      mentions += 1;
      push({
        from,
        to: m.id,
        kind: "mention",
        label: `${name(from)} asked ${m.name} on #${p.number ?? "?"}`,
        taskId: (ev.subject?.kind === "task" ? ev.subject.id : null) ?? null,
      });
    }
  }
  for (const r of data.reviews ?? []) {
    if (r.status === "approved" || !r.reviewer || r.reviewer.kind !== "teammate") continue;
    if (r.author.kind === "teammate" && r.author.id === r.reviewer.id) continue;
    push({
      from: r.author.kind === "teammate" ? r.author.id : "you",
      to: r.reviewer.id,
      kind: "review",
      label: `${name(r.reviewer.id)} reviewing ${r.author.name ?? name(r.author.id)} · #${r.taskNumber ?? "?"}`,
      taskId: r.taskId,
    });
  }
  for (const r of live) {
    if (r.kind !== "turn") continue;
    const t = data.tasks.find((x) => x.id === r.taskId);
    const from = t?.assignee?.kind === "teammate" ? t.assignee.id : "you";
    if (from !== r.teammateId)
      push({
        from,
        to: r.teammateId,
        kind: "mention",
        label: `${name(r.teammateId)} answering on #${t?.number ?? "?"}`,
        taskId: r.taskId,
      });
  }
  return edges;
}

/** What the company settings say about one image of the pack. */
export interface OfficeImage {
  sha256: string;
  width: number;
  height: number;
  bytes: number;
}
export type OfficePack = Record<string, OfficeImage>;
export const SPRITE_MODES: SpriteMode[] = ["typing", "reading", "blocked", "waiting", "idle"];

/** The company's office images when they are well formed; anything else is ignored. */
export function officePack(settings: Record<string, unknown> | null | undefined): OfficePack {
  const p = settings?.officePack;
  if (!p || typeof p !== "object") return {};
  const out: OfficePack = {};
  for (const [name, v] of Object.entries(p as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const { sha256, width, height, bytes } = v as Record<string, unknown>;
    if (
      typeof sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(sha256) &&
      typeof width === "number" &&
      typeof height === "number" &&
      typeof bytes === "number" &&
      width > 0 &&
      height > 0
    )
      out[name] = { sha256, width, height, bytes };
  }
  return out;
}

/** A sprite image is three frames side by side: standing, then two walking. Which one shows, and where it is. */
export function spriteFrame(
  width: number,
  height: number,
  walking: boolean,
  t: number,
): { sx: number; w: number; h: number } {
  const w = Math.floor(width / 3) || width;
  const frame = walking && w < width ? 1 + (Math.floor(t / 8) % 2) : 0;
  return { sx: frame * w, w, h: height };
}

/** The floor image for a room: the department's own, else the one for any room, else none. */
export function roomImageName(pack: OfficePack, departmentId: string): string | null {
  if (pack[`room.${departmentId}`]) return `room.${departmentId}`;
  if (pack["room.default"]) return "room.default";
  return null;
}
