// What teammates say in the office: lines taken from the event stream (a post
// on a task, a review comment, a verdict, a decision, an ask for approval,
// Peter's questions), and the pacing that puts them over heads one after
// another. Pure: the canvas asks what should be showing and draws it.
import type { CompanyData } from "../../api/types.ts";

export type LineKind =
  "message" | "mention" | "comment" | "changes" | "approved" | "decision" | "ask" | "question";

export interface Line {
  /** The event's id. */
  key: string;
  seq: number;
  at: string;
  /** A teammate id, or "you" for a person. */
  speaker: string;
  speakerName: string;
  /** Who it is said to: teammate ids, or "you". */
  to: { id: string; name: string }[];
  kind: LineKind;
  text: string;
  taskId: string | null;
  number: number | null;
  /** Where on the change a review comment sits. */
  where: string | null;
}

/** Plain words from a post: no code fences, emphasis or heading marks, one line. */
export function plainText(s: string): string {
  return s
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/`/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/^\s*(#{1,6}|>)\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

type Ev = CompanyData["events"][number];

/** The lines in the stream, oldest first, at most `limit` of them. */
export function dialogueLines(
  data: Pick<CompanyData, "events" | "teammates" | "reviews">,
  limit = 40,
): Line[] {
  const byId = new Map(data.teammates.map((t) => [t.id, t]));
  const nameOf = (id: string) => (id === "you" ? "You" : (byId.get(id)?.name ?? "A teammate"));
  const speakerOf = (ev: Ev, fallbackId?: unknown): string | null => {
    if (typeof fallbackId === "string" && byId.has(fallbackId)) return fallbackId;
    if (ev.actor?.kind === "teammate") return byId.has(ev.actor.id) ? ev.actor.id : null;
    if (ev.actor?.kind === "user") return "you";
    return null;
  };
  const target = (id: unknown): { id: string; name: string }[] =>
    typeof id === "string" && byId.has(id) ? [{ id, name: nameOf(id) }] : [];
  const out: Line[] = [];
  for (const ev of data.events) {
    const p = ev.payload as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : null;
    const taskFromSubject = ev.subject?.kind === "task" ? ev.subject.id : null;
    const taskId = typeof p.taskId === "string" ? p.taskId : taskFromSubject;
    const base = (speaker: string, name: unknown) => ({
      key: ev.id,
      seq: ev.seq,
      at: ev.createdAt,
      speaker,
      speakerName: speaker === "you" && typeof name === "string" && name ? name : nameOf(speaker),
      taskId,
      number,
      where: null as string | null,
    });
    switch (ev.type) {
      case "message.posted": {
        const speaker = speakerOf(ev);
        const text = plainText(String(p.preview ?? ""));
        if (!speaker || !text) break;
        const mentions = (Array.isArray(p.mentions) ? p.mentions : []) as { id?: string; name?: string }[];
        const to = mentions
          .filter((m) => typeof m.id === "string" && m.id !== speaker)
          .map((m) => ({ id: m.id!, name: m.name ?? nameOf(m.id!) }));
        out.push({ ...base(speaker, p.authorName), to, kind: to.length ? "mention" : "message", text });
        break;
      }
      case "review.commented": {
        if (p.action === "resolved") break;
        const speaker = speakerOf(ev);
        const text = plainText(String(p.preview ?? ""));
        if (!speaker || !text) break;
        const review = (data.reviews ?? []).find((r) => r.id === ev.subject?.id);
        const author = review?.author.kind === "teammate" ? review.author.id : null;
        const where =
          typeof p.file === "string" ? `${p.file}${typeof p.line === "number" ? `:${p.line}` : ""}` : null;
        out.push({
          ...base(speaker, p.authorName),
          to: author && author !== speaker ? target(author) : [],
          kind: "comment",
          text,
          where,
        });
        break;
      }
      case "review.changes_requested":
      case "review.approved": {
        const speaker = speakerOf(ev);
        if (!speaker) break;
        const summary = plainText(String(p.summary ?? ""));
        const changes = ev.type === "review.changes_requested";
        const open = typeof p.openComments === "number" && p.openComments > 0 ? p.openComments : 0;
        const text =
          summary ||
          (changes
            ? `Changes requested on #${number ?? "?"}${open ? `, ${open} comment${open === 1 ? "" : "s"} open` : ""}`
            : `Approved #${number ?? "?"}`);
        out.push({
          ...base(speaker, changes ? p.reviewerName : p.approverName),
          to: p.authorId !== speaker ? target(p.authorId) : [],
          kind: changes ? "changes" : "approved",
          text,
        });
        break;
      }
      case "decision.logged": {
        const speaker = speakerOf(ev);
        const text = plainText(String(p.decision ?? ""));
        if (!speaker || speaker === "you" || !text) break;
        out.push({ ...base(speaker, null), to: [], kind: "decision", text });
        break;
      }
      case "approval.proposed": {
        const speaker = speakerOf(ev, p.teammateId);
        const text = plainText(String(p.title ?? ""));
        if (!speaker || speaker === "you" || !text) break;
        out.push({ ...base(speaker, p.teammateName), to: [{ id: "you", name: "You" }], kind: "ask", text });
        break;
      }
      case "goal.questions": {
        const manager =
          ev.actor?.kind === "teammate"
            ? ev.actor.id
            : data.teammates.find((t) => t.name === p.managerName)?.id;
        const qs = (Array.isArray(p.questions) ? p.questions : []).map((q) =>
          plainText(typeof q === "string" ? q : String((q as { text?: unknown })?.text ?? "")),
        );
        if (!manager || !byId.has(manager) || !qs[0]) break;
        const more = qs.length > 1 ? ` (+${qs.length - 1} more)` : "";
        out.push({
          ...base(manager, null),
          taskId: null,
          to: [{ id: "you", name: "You" }],
          kind: "question",
          text: `${qs[0]}${more}`,
        });
        break;
      }
    }
  }
  // The stream arrives newest first.
  out.sort((a, b) => a.seq - b.seq);
  return out.slice(-limit);
}

/** How a line reads above a head: who to whom, and a word for what it is. */
export const LINE_LABEL: Record<LineKind, string> = {
  message: "wrote",
  mention: "to",
  comment: "review comment",
  changes: "changes requested",
  approved: "approved",
  decision: "decided",
  ask: "asks you to approve",
  question: "asks you",
};

/** How long a line stays up: long enough to read. */
export function lineDuration(text: string): number {
  return Math.min(9000, Math.max(3600, 2400 + text.length * 50));
}

export interface Playing {
  key: string;
  speaker: string;
  start: number;
  until: number;
  /** Replayed from before you opened the office, or said just now. */
  replay: boolean;
}

/** What is being said and what comes next. */
export interface Stage {
  playing: Playing[];
  /** New lines not yet said, oldest first. */
  live: string[];
  /** The highest sequence already taken in. */
  seen: number;
  /** The next of the recent lines to replay while nothing new is said. */
  cursor: number;
  /** No line starts before this. */
  nextAt: number;
}

export const STAGE_MAX = 3;
/** How many recent lines are replayed, and the pause before they start again. */
export const REPLAY = 10;
export const REPLAY_PAUSE = 14000;

export function newStage(lines: Line[], now: number): Stage {
  return {
    playing: [],
    live: [],
    seen: lines.reduce((m, l) => Math.max(m, l.seq), 0),
    cursor: 0,
    nextAt: now + 600,
  };
}

/**
 * One step: lines that have had their time go, new lines are taken in, and
 * the next line starts when its speaker is free and the room is not too busy.
 * New lines go first; with none, the last few are replayed in order, then a
 * pause. A line whose speaker is not in the room is passed over.
 */
export function stepStage(
  s: Stage,
  lines: Line[],
  now: number,
  present: (speaker: string) => boolean,
  replay = true,
): Stage {
  const byKey = new Map(lines.map((l) => [l.key, l]));
  let playing = s.playing.filter((p) => p.until > now);
  const fresh = lines.filter((l) => l.seq > s.seen).map((l) => l.key);
  let live = [...s.live.filter((k) => byKey.has(k)), ...fresh];
  const seen = lines.reduce((m, l) => Math.max(m, l.seq), s.seen);
  let { cursor, nextAt } = s;
  const recent = lines.slice(-REPLAY);
  const start = (l: Line, isReplay: boolean) => {
    const d = lineDuration(l.text);
    playing = [...playing, { key: l.key, speaker: l.speaker, start: now, until: now + d, replay: isReplay }];
    nextAt = now + Math.max(1600, d * 0.55);
  };
  const busy = (sp: string) => playing.some((p) => p.speaker === sp);
  if (now >= nextAt && playing.length < STAGE_MAX) {
    // Pass over what cannot be shown; wait for a busy speaker rather than skip them.
    while (live.length && !present(byKey.get(live[0]!)!.speaker)) live = live.slice(1);
    if (live.length) {
      const l = byKey.get(live[0]!)!;
      if (!busy(l.speaker)) {
        start(l, false);
        live = live.slice(1);
      }
    } else if (replay && recent.length) {
      if (cursor >= recent.length) {
        cursor = 0;
        nextAt = now + REPLAY_PAUSE;
      } else {
        const l = recent[cursor]!;
        if (!present(l.speaker)) cursor += 1;
        else if (!busy(l.speaker)) {
          start(l, true);
          cursor += 1;
        }
      }
    }
  }
  return { playing, live, seen, cursor, nextAt };
}

/** A line's age, short: now, 4m, 2h, 3d. */
export function shortAge(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
