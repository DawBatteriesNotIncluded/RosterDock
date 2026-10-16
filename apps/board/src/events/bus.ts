// Live event bus. One LISTEN connection per process receives pg_notify from
// every replica's commits and pumps the committed rows into the in-process
// fan-out, so SSE clients on any replica see every event in seq order.
// Missed notifications self-heal: each notification fetches everything after
// the last seq this process saw for that company.

import { createFanout, type EventRecord, type Fanout } from "@rosterdock/shared";
import pg from "pg";
import type { Db } from "../db/pool.js";
import { EVENTS_CHANNEL, readEvents } from "./store.js";

export interface EventBus {
  fanout: Fanout<EventRecord>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Test hook: wait until the bus has delivered a given seq for a company. */
  waitFor(companyId: string, seq: number, timeoutMs?: number): Promise<void>;
}

export function createEventBus(
  db: Db,
  connectionString: string,
  log: { warn: (msg: string) => void },
): EventBus {
  const fanout = createFanout<EventRecord>();
  const lastSeq = new Map<string, number>();
  let listener: pg.Client | null = null;
  let stopped = false;
  let pumping: Promise<void> = Promise.resolve();

  async function pump(companyId: string, hintSeq: number): Promise<void> {
    const seen = lastSeq.get(companyId);
    // First sight of this company in this process: start just before the hint
    // so we deliver the row that woke us and everything after it.
    const afterSeq = seen === undefined ? hintSeq - 1 : seen;
    const rows = await readEvents(db, companyId, { afterSeq, limit: 1000 });
    for (const row of rows) {
      const prev = lastSeq.get(companyId) ?? -Infinity;
      if (row.seq <= prev) continue;
      lastSeq.set(companyId, row.seq);
      fanout.publish(row);
    }
  }

  function onNotification(payload: string | undefined): void {
    if (!payload) return;
    let parsed: { companyId?: string; seq?: number };
    try {
      parsed = JSON.parse(payload) as { companyId?: string; seq?: number };
    } catch {
      return;
    }
    if (!parsed.companyId || typeof parsed.seq !== "number") return;
    const { companyId, seq } = parsed;
    // Serialise pumps so rows never publish out of order within a process.
    pumping = pumping
      .then(() => pump(companyId, seq))
      .catch((err) => log.warn(`event pump failed: ${String(err)}`));
  }

  async function connect(): Promise<void> {
    const client = new pg.Client({ connectionString });
    await client.connect();
    client.on("notification", (msg) => {
      if (msg.channel === EVENTS_CHANNEL) onNotification(msg.payload);
    });
    client.on("error", (err) => {
      log.warn(`event listener connection error: ${err.message}`);
      void reconnect();
    });
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    listener = client;
  }

  async function reconnect(): Promise<void> {
    if (stopped) return;
    try {
      listener?.end().catch(() => {});
    } catch {
      // ignore
    }
    listener = null;
    await new Promise((r) => setTimeout(r, 1000));
    if (stopped) return;
    try {
      await connect();
    } catch (err) {
      log.warn(`event listener reconnect failed: ${String(err)}`);
      void reconnect();
    }
  }

  return {
    fanout,
    async start() {
      stopped = false;
      await connect();
    },
    async stop() {
      stopped = true;
      const client = listener;
      listener = null;
      if (client) await client.end();
    },
    waitFor(companyId, seq, timeoutMs = 5000) {
      if ((lastSeq.get(companyId) ?? -Infinity) >= seq) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`timed out waiting for seq ${seq} of company ${companyId}`));
        }, timeoutMs);
        const off = fanout.subscribe((ev) => {
          if (ev.companyId === companyId && ev.seq >= seq) {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
      });
    },
  };
}
