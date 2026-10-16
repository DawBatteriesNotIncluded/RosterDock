// Every mutation runs through here: one transaction, the work, and at least
// one event appended before commit. A mutation that appends no event is a
// programming error and rolls back.

import type { ActorRef, EventRecord, EventType, SubjectRef } from "@rosterdock/shared";
import type pg from "pg";
import type { Db } from "./db/pool.js";
import { withTransaction } from "./db/pool.js";
import { appendEvent } from "./events/store.js";

export interface MutationContext {
  client: pg.PoolClient;
  companyId: string;
  actor: ActorRef;
  emit(type: EventType, subject: SubjectRef | null, payload?: Record<string, unknown>): Promise<EventRecord>;
  events: EventRecord[];
}

export async function mutate<T>(
  db: Db,
  companyId: string,
  actor: ActorRef,
  fn: (ctx: MutationContext) => Promise<T>,
): Promise<{ result: T; events: EventRecord[] }> {
  return withTransaction(db, async (client) => {
    const events: EventRecord[] = [];
    const ctx: MutationContext = {
      client,
      companyId,
      actor,
      events,
      async emit(type, subject, payload) {
        const ev = await appendEvent(client, { companyId, type, actor, subject, payload });
        events.push(ev);
        return ev;
      },
    };
    const result = await fn(ctx);
    if (events.length === 0) throw new Error("mutation committed no event");
    return { result, events };
  });
}
