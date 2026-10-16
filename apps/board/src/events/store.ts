// Appending to the one event stream. Called inside the same transaction as
// the mutation it describes; the per-company seq is allocated under the
// company_counters row lock, and pg_notify fires when the transaction commits.

import type { ActorRef, EventRecord, EventType, SubjectRef } from "@rosterdock/shared";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";

export const EVENTS_CHANNEL = "rosterdock_events";

export interface AppendEventInput {
  companyId: string;
  type: EventType;
  actor: ActorRef | null;
  subject: SubjectRef | null;
  payload?: Record<string, unknown>;
}

interface EventRow {
  id: string;
  company_id: string;
  seq: number;
  type: string;
  actor_kind: "user" | "teammate" | null;
  actor_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

export function rowToEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    seq: row.seq,
    type: row.type as EventType,
    actor: row.actor_kind && row.actor_id ? { kind: row.actor_kind, id: row.actor_id } : null,
    subject:
      row.subject_kind && row.subject_id
        ? { kind: row.subject_kind as SubjectRef["kind"], id: row.subject_id }
        : null,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

export async function appendEvent(client: pg.PoolClient, input: AppendEventInput): Promise<EventRecord> {
  const seqRes = await client.query<{ seq: number }>(
    "UPDATE company_counters SET next_event_seq = next_event_seq + 1 WHERE company_id = $1 RETURNING next_event_seq - 1 AS seq",
    [input.companyId],
  );
  const seq = seqRes.rows[0]?.seq;
  if (seq === undefined) throw new Error(`no counter row for company ${input.companyId}`);
  const res = await client.query<EventRow>(
    `INSERT INTO events (company_id, seq, type, actor_kind, actor_id, subject_kind, subject_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      input.companyId,
      seq,
      input.type,
      input.actor?.kind ?? null,
      input.actor?.id ?? null,
      input.subject?.kind ?? null,
      input.subject?.id ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  await client.query("SELECT pg_notify($1, $2)", [
    EVENTS_CHANNEL,
    JSON.stringify({ companyId: input.companyId, seq }),
  ]);
  return rowToEvent(res.rows[0]!);
}

export interface ReadEventsOptions {
  afterSeq?: number;
  limit?: number;
  subject?: SubjectRef;
}

/** Oldest-first events for a company, optionally after a seq and filtered by subject. */
export async function readEvents(
  db: Queryable,
  companyId: string,
  opts: ReadEventsOptions = {},
): Promise<EventRecord[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const params: unknown[] = [companyId];
  const where: string[] = ["company_id = $1"];
  if (opts.afterSeq !== undefined) {
    params.push(opts.afterSeq);
    where.push(`seq > $${params.length}`);
  }
  if (opts.subject) {
    params.push(opts.subject.kind, opts.subject.id);
    where.push(`subject_kind = $${params.length - 1} AND subject_id = $${params.length}`);
  }
  params.push(limit);
  const res = await db.query<EventRow>(
    `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(rowToEvent);
}

/** Newest-first events, for the Activity view. */
export async function readRecentEvents(
  db: Queryable,
  companyId: string,
  limit = 100,
): Promise<EventRecord[]> {
  const res = await db.query<EventRow>(
    "SELECT * FROM events WHERE company_id = $1 ORDER BY seq DESC LIMIT $2",
    [companyId, Math.max(1, Math.min(limit, 1000))],
  );
  return res.rows.map(rowToEvent);
}
