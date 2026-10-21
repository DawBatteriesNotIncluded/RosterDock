// Worker-facing routes. Claim needs the fleet's worker token; everything
// after that uses the run-scoped token returned by the claim, which only
// works for its own run and dies when the run finishes.

import { timingSafeEqual } from "node:crypto";
import {
  RunArtifactSchema,
  RunCheckpointSchema,
  RunCompleteSchema,
  RunEventsBatchSchema,
  RunHeartbeatSchema,
  WorkerClaimSchema,
} from "@rosterdock/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BoardConfig } from "../config.js";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import type { RunQueue } from "../queue.js";
import type { SourceFetcher } from "../reviews/sources.js";
import type { ObjectStore } from "../storage/s3.js";
import {
  addArtifact,
  appendRunEvents,
  artifactToJson,
  buildRunSpec,
  claimRun,
  completeRun,
  heartbeat,
  loadRun,
  runToJson,
  saveCheckpoint,
} from "../runs/service.js";
import { renderRunPack } from "../runs/pack.js";
import { parseBody, uuidParam } from "../validate.js";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** The bearer must be the run-scoped token for exactly this run. */
function requireRunToken(req: FastifyRequest): string {
  const runId = uuidParam((req.params as { runId: string }).runId, "runId");
  const p = req.principal;
  if (p.kind !== "teammate" || p.runId !== runId)
    throw new HttpError(403, "this token is not scoped to that run");
  return runId;
}

export function registerWorkerRoutes(
  app: FastifyInstance,
  db: Db,
  config: BoardConfig,
  queue: RunQueue,
  store: ObjectStore | null = null,
  sources: SourceFetcher | null = null,
): void {
  app.post("/api/worker/claim", { config: { public: true } }, async (req, reply) => {
    if (!config.workerToken) throw new HttpError(503, "no worker token is configured on the board");
    const presented = req.headers["x-rosterdock-worker-token"];
    if (typeof presented !== "string" || !safeEqual(presented, config.workerToken))
      throw new HttpError(401, "worker token required");
    const body = parseBody(WorkerClaimSchema, req.body);
    const claimed = await claimRun(db, body, {
      staleAfterMs: config.runStaleAfterMs,
      store,
      web: config.fetchSources,
    });
    reply.code(201);
    return {
      run: runToJson(claimed.run),
      token: claimed.token,
      tokenExpiresAt: claimed.tokenExpiresAt,
      pack: claimed.pack,
      spec: claimed.spec,
    };
  });

  app.get("/api/worker/runs/:runId", { config: {} }, async (req) => {
    const runId = requireRunToken(req);
    const run = await loadRun(db, runId);
    const spec = await buildRunSpec(db, run, store, { web: config.fetchSources });
    return { run: runToJson(run), pack: renderRunPack(spec), spec };
  });

  app.post("/api/worker/runs/:runId/heartbeat", { config: {} }, async (req) => {
    const runId = requireRunToken(req);
    const body = parseBody(RunHeartbeatSchema, req.body);
    return heartbeat(db, runId, body);
  });

  app.post("/api/worker/runs/:runId/events", { config: {} }, async (req) => {
    const runId = requireRunToken(req);
    const body = parseBody(RunEventsBatchSchema, req.body);
    return appendRunEvents(db, runId, body.events);
  });

  app.post("/api/worker/runs/:runId/checkpoint", { config: {} }, async (req) => {
    const runId = requireRunToken(req);
    const body = parseBody(RunCheckpointSchema, req.body);
    await saveCheckpoint(db, runId, body.checkpoint);
    return { ok: true };
  });

  // An artifact may be ARTIFACT_MAX_BYTES once decoded, base64 and JSON on top: the body limit allows for it.
  app.post(
    "/api/worker/runs/:runId/artifacts",
    { config: {}, bodyLimit: 16 * 1024 * 1024 },
    async (req, reply) => {
      const runId = requireRunToken(req);
      const body = parseBody(RunArtifactSchema, req.body);
      const row = await addArtifact(db, runId, body, store);
      reply.code(201);
      return artifactToJson(row);
    },
  );

  app.post("/api/worker/runs/:runId/complete", { config: {} }, async (req) => {
    const runId = requireRunToken(req);
    const body = parseBody(RunCompleteSchema, req.body);
    return runToJson(await completeRun(db, runId, body, undefined, queue, store, sources));
  });
}
