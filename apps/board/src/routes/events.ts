// Event log and the SSE tail. Replay with ?afterSeq= or Last-Event-ID; the
// tail subscribes before reading the backlog so nothing slips between the two.

import { tailFrom, type EventRecord, type SubjectRef } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import type { EventBus } from "../events/bus.js";
import { readEvents, readRecentEvents } from "../events/store.js";
import { uuidParam } from "../validate.js";

const MAX_STREAM_CLIENTS = 500;
const HEARTBEAT_MS = 25_000;

export function registerEventRoutes(app: FastifyInstance, db: Db, bus: EventBus): void {
  const openStreams = new Set<() => void>();
  // Before the server stops: it waits for open connections, and a stream stays open while a tab
  // holds it, so ending the streams in onClose (which runs after that wait) never came.
  app.addHook("preClose", async () => {
    for (const close of [...openStreams]) close();
  });

  app.get("/api/companies/:companyId/events", { config: { action: "events.read" } }, async (req) => {
    const q = req.query as { afterSeq?: string; limit?: string; subjectKind?: string; subjectId?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    const subject: SubjectRef | undefined =
      q.subjectKind && q.subjectId
        ? { kind: q.subjectKind as SubjectRef["kind"], id: uuidParam(q.subjectId, "subjectId") }
        : undefined;
    if (q.afterSeq !== undefined) {
      return readEvents(db, req.companyId, { afterSeq: Number(q.afterSeq), limit, subject });
    }
    if (subject) return readEvents(db, req.companyId, { subject, limit });
    return readRecentEvents(db, req.companyId, limit);
  });

  app.get(
    "/api/companies/:companyId/events/stream",
    { config: { action: "events.read" } },
    async (req, reply) => {
      if (openStreams.size >= MAX_STREAM_CLIENTS) {
        reply.code(503).header("Retry-After", "5");
        return { error: "too many stream clients; retry shortly" };
      }
      const q = req.query as { afterSeq?: string; replay?: string; once?: string };
      const lastEventId = req.headers["last-event-id"];
      const afterSeqRaw = typeof lastEventId === "string" ? lastEventId : q.afterSeq;
      const afterSeq = afterSeqRaw !== undefined ? Number(afterSeqRaw) : undefined;
      const replay = q.replay !== undefined ? Math.max(0, Math.min(Number(q.replay), 1000)) : 50;
      const once = q.once === "1";
      const companyId = req.companyId;

      // From here on the raw response is ours; Fastify sends nothing.
      reply.hijack();
      const raw = reply.raw;
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      const close = (): void => {
        if (closed) return;
        closed = true;
        openStreams.delete(close);
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          raw.end();
        } catch {
          // already gone
        }
      };
      openStreams.add(close);
      req.raw.on("close", close);
      req.raw.on("error", close);

      try {
        raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        raw.write(": connected\n\n");
        const socket = req.raw.socket as { setTimeout?: (ms: number) => void } | null | undefined;
        if (socket && typeof socket.setTimeout === "function") socket.setTimeout(0);
        heartbeat = setInterval(() => {
          try {
            raw.write(": hb\n\n");
          } catch {
            close();
          }
        }, HEARTBEAT_MS);
        heartbeat.unref();

        unsubscribe = await tailFrom<EventRecord>({
          fanout: bus.fanout,
          // Company scope, and never anything at or before the seq the client already has:
          // a late LISTEN notification can make the bus publish older rows.
          filter: (ev) =>
            ev.companyId === companyId &&
            (afterSeq === undefined || !Number.isFinite(afterSeq) || ev.seq > afterSeq),
          readBacklog: async () => {
            if (afterSeq !== undefined && Number.isFinite(afterSeq)) {
              return readEvents(db, companyId, { afterSeq, limit: 1000 });
            }
            if (replay > 0) return (await readRecentEvents(db, companyId, replay)).reverse();
            return [];
          },
          write: (ev) => {
            if (closed) return false;
            return raw.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          },
          onStall: close,
        });
        if (closed) unsubscribe();
        if (once) close();
      } catch (err) {
        req.log.warn({ err }, "event stream failed");
        close();
      }
    },
  );
}
