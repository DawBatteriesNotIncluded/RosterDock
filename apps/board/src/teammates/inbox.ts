// A teammate's inbox: the events addressed to them, as one sentence each, in
// manager language. A projection of the events table, nothing stored: a
// mention, a chase, a task handed to them, a review to do or a decision on
// their work, the outcome of a write they proposed, a drift notice. "New" is
// anything since their last run started, because that is when they last read.

import type { EventRecord } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { rowToEvent } from "../events/store.js";
import { driftSentence } from "../notify/notify.js";

export const INBOX_LIMIT = 50;

export interface InboxItem {
  id: string;
  seq: number;
  type: EventRecord["type"];
  at: string;
  text: string;
  unread: boolean;
  taskId: string | null;
  reviewId: string | null;
}

export interface Inbox {
  /** When the teammate's latest run started: everything after it is unread. Null: they never ran. */
  since: string | null;
  unread: number;
  items: InboxItem[];
}

type EventRow = Parameters<typeof rowToEvent>[0];

const INBOX_WHERE = `
  company_id = $1
  AND NOT (actor_kind = 'teammate' AND actor_id = $2)
  AND (
    (type = 'teammate.drift' AND subject_kind = 'teammate' AND subject_id = $2)
    OR (type = 'message.posted' AND payload->'mentions' @> $3::jsonb)
    OR (type = 'task.chased' AND payload->>'teammateId' = $2::text)
    OR (type IN ('task.created', 'task.assigned') AND payload->'assignee'->>'id' = $2::text)
    OR (type IN ('review.opened', 'review.reassigned') AND payload->'reviewer'->>'id' = $2::text)
    OR (type IN ('review.changes_requested', 'review.approved', 'review.vetoed') AND payload->>'authorId' = $2::text)
    OR (type IN ('approval.approved', 'approval.rejected', 'approval.executed', 'approval.failed') AND payload->>'teammateId' = $2::text)
  )`;

/** When the teammate's most recent started run began, leaving one run out (the one being packed). */
export async function lastRunStart(
  db: Queryable,
  teammateId: string,
  excludeRunId: string | null = null,
): Promise<Date | null> {
  const res = await db.query<{ started_at: Date }>(
    `SELECT started_at FROM runs WHERE teammate_id = $1 AND started_at IS NOT NULL AND ($2::uuid IS NULL OR id <> $2)
     ORDER BY started_at DESC LIMIT 1`,
    [teammateId, excludeRunId],
  );
  return res.rows[0]?.started_at ?? null;
}

export function inboxSentence(ev: EventRecord): string {
  const p = ev.payload as Record<string, unknown>;
  const task = p.number !== undefined ? `#${p.number} ${p.title ?? p.taskTitle ?? ""}`.trim() : "a task";
  const round = typeof p.round === "number" && p.round > 1 ? ` (round ${p.round})` : "";
  switch (ev.type) {
    case "message.posted":
      return `${p.authorName ?? "Someone"} mentioned you on ${task}: "${p.preview ?? ""}"`;
    case "task.chased":
      return `${task} is waiting on you.`;
    case "task.created":
    case "task.assigned":
      return `${task} was assigned to you.`;
    case "review.opened":
      return `${task} is yours to review${round}.`;
    case "review.reassigned":
      return `${p.byName ?? "Someone"} made ${task} yours to review${round}.`;
    case "review.changes_requested":
      return `${p.reviewerName ?? "The reviewer"} sent ${task} back with changes requested${round}.`;
    case "review.approved":
      return `${p.approverName ?? "The reviewer"} approved ${task}; it is Done.`;
    case "review.vetoed":
      return `${p.vetoedByName ?? "Someone"} vetoed the approval of ${task}: ${p.note ?? ""}`;
    case "approval.approved":
      return `Your proposed write "${p.title ?? ""}" on ${task} was approved.`;
    case "approval.executed":
      return `Your proposed write "${p.title ?? ""}" on ${task} was executed.`;
    case "approval.rejected":
      return `Your proposed write "${p.title ?? ""}" on ${task} was rejected${p.note ? `: ${p.note}` : "."}`;
    case "approval.failed":
      return `Your proposed write "${p.title ?? ""}" on ${task} could not be sent: ${p.error ?? "unknown error"}`;
    case "teammate.drift":
      return driftSentence(p);
    default:
      return ev.type;
  }
}

export function inboxItem(ev: EventRecord, since: Date | null): InboxItem {
  const p = ev.payload as Record<string, unknown>;
  return {
    id: ev.id,
    seq: ev.seq,
    type: ev.type,
    at: ev.createdAt,
    text: inboxSentence(ev),
    unread: since === null || new Date(ev.createdAt) > since,
    taskId:
      (typeof p.taskId === "string" ? p.taskId : null) ??
      (ev.subject?.kind === "task" ? ev.subject.id : null),
    reviewId: ev.subject?.kind === "review" ? ev.subject.id : null,
  };
}

export async function listInbox(
  db: Queryable,
  companyId: string,
  teammateId: string,
  opts: { limit?: number; since?: Date | null; onlyUnread?: boolean } = {},
): Promise<Inbox> {
  const since = opts.since === undefined ? await lastRunStart(db, teammateId) : opts.since;
  const limit = Math.max(1, Math.min(opts.limit ?? INBOX_LIMIT, 200));
  const res = await db.query<EventRow>(
    `SELECT * FROM events WHERE ${INBOX_WHERE}
       AND ($4::timestamptz IS NULL OR created_at > $4)
     ORDER BY seq DESC LIMIT $5`,
    [companyId, teammateId, JSON.stringify([{ id: teammateId }]), opts.onlyUnread ? since : null, limit],
  );
  const items = res.rows.map((r) => inboxItem(rowToEvent(r), since));
  return {
    since: since?.toISOString() ?? null,
    unread: items.filter((i) => i.unread).length,
    items,
  };
}
