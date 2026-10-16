// Company-facing run routes: start, watch, stop, read outputs.
import { DispatchRunSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import { notFound } from "../http-error.js";
import type { RunQueue } from "../queue.js";
import { taskDeliverable } from "../runs/outputs.js";
import {
  artifactToJson,
  dispatchRun,
  listArtifacts,
  listRunEvents,
  loadRun,
  runToJson,
  stopRun,
  type ArtifactRow,
  type RunRow,
} from "../runs/service.js";
import { artifactBytes, artifactText } from "../storage/artifacts.js";
import type { ObjectStore } from "../storage/s3.js";
import { parseBody, uuidParam } from "../validate.js";

export function registerRunRoutes(
  app: FastifyInstance,
  db: Db,
  queue: RunQueue,
  store: ObjectStore | null = null,
): void {
  app.get(
    "/api/companies/:companyId/tasks/:taskId/runs",
    { config: { action: "company.read" } },
    async (req) => {
      const taskId = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const res = await db.query<RunRow>(
        "SELECT * FROM runs WHERE task_id = $1 AND company_id = $2 ORDER BY created_at DESC",
        [taskId, req.companyId],
      );
      return res.rows.map(runToJson);
    },
  );

  // Start the assignee on the task.
  app.post(
    "/api/companies/:companyId/tasks/:taskId/runs",
    { config: { action: "task.update" } },
    async (req, reply) => {
      const taskId = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const body = parseBody(DispatchRunSchema, req.body);
      const run = await dispatchRun(db, queue, req.companyId, req.principal.actor, taskId, body);
      reply.code(201);
      return runToJson(run);
    },
  );

  app.get("/api/companies/:companyId/runs", { config: { action: "company.read" } }, async (req) => {
    const q = req.query as { status?: string; limit?: string };
    const params: unknown[] = [req.companyId];
    let where = "company_id = $1";
    if (q.status) {
      params.push(q.status.split(",").map((s) => s.trim()));
      where += ` AND status = ANY($${params.length}::text[])`;
    }
    params.push(Math.max(1, Math.min(Number(q.limit ?? 100), 500)));
    const res = await db.query<RunRow>(
      `SELECT * FROM runs WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(runToJson);
  });

  app.get("/api/companies/:companyId/runs/:runId", { config: { action: "company.read" } }, async (req) => {
    const runId = uuidParam((req.params as { runId: string }).runId, "runId");
    const afterSeq = Number((req.query as { afterSeq?: string }).afterSeq ?? 0);
    const run = await loadRun(db, runId);
    if (run.company_id !== req.companyId) throw notFound("run");
    const [events, artifacts] = await Promise.all([
      listRunEvents(db, runId, afterSeq),
      listArtifacts(db, runId),
    ]);
    return { ...runToJson(run), events, artifacts: artifacts.map((a) => artifactToJson(a)) };
  });

  app.get(
    "/api/companies/:companyId/runs/:runId/artifacts/:artifactId",
    { config: { action: "company.read" } },
    async (req) => {
      const params = req.params as { runId: string; artifactId: string };
      const runId = uuidParam(params.runId, "runId");
      const artifactId = uuidParam(params.artifactId, "artifactId");
      const res = await db.query<ArtifactRow>(
        "SELECT * FROM artifacts WHERE id = $1 AND run_id = $2 AND company_id = $3",
        [artifactId, runId, req.companyId],
      );
      const row = res.rows[0];
      if (!row) throw notFound("artifact");
      return { ...artifactToJson(row), content: await artifactText(store, row) };
    },
  );

  // The file itself, to save: text as UTF-8, anything else as bytes.
  app.get(
    "/api/companies/:companyId/runs/:runId/artifacts/:artifactId/download",
    { config: { action: "company.read" } },
    async (req, reply) => {
      const params = req.params as { runId: string; artifactId: string };
      const runId = uuidParam(params.runId, "runId");
      const artifactId = uuidParam(params.artifactId, "artifactId");
      const row = (
        await db.query<ArtifactRow>(
          "SELECT * FROM artifacts WHERE id = $1 AND run_id = $2 AND company_id = $3",
          [artifactId, runId, req.companyId],
        )
      ).rows[0];
      if (!row) throw notFound("artifact");
      const bytes = await artifactBytes(store, row);
      if (!bytes) throw notFound("artifact content");
      const name = row.path.split("/").pop() || "file";
      const ascii = name.replace(/[^A-Za-z0-9._-]/g, "_");
      reply.header(
        "content-type",
        row.encoding === "base64" ? "application/octet-stream" : "text/plain; charset=utf-8",
      );
      reply.header(
        "content-disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      return reply.send(bytes);
    },
  );

  // The ticket's deliverable: the declared files of the run its review approved (or its latest run), and
  // where the review stands on them.
  app.get(
    "/api/companies/:companyId/tasks/:taskId/deliverable",
    { config: { action: "company.read" } },
    async (req) => {
      const taskId = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const task = (
        await db.query<{ id: string; declared_outputs: string[] | null }>(
          "SELECT id, declared_outputs FROM tasks WHERE id = $1 AND company_id = $2",
          [taskId, req.companyId],
        )
      ).rows[0];
      if (!task) throw notFound("task");
      const d = await taskDeliverable(db, task);
      return { ...d, files: d.files.map((a) => artifactToJson(a)) };
    },
  );

  app.get(
    "/api/companies/:companyId/tasks/:taskId/artifacts",
    { config: { action: "company.read" } },
    async (req) => {
      const taskId = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const res = await db.query<ArtifactRow>(
        "SELECT * FROM artifacts WHERE task_id = $1 AND company_id = $2 ORDER BY created_at DESC, path",
        [taskId, req.companyId],
      );
      return res.rows.map((a) => artifactToJson(a));
    },
  );

  app.post(
    "/api/companies/:companyId/runs/:runId/stop",
    { config: { action: "task.update" } },
    async (req) => {
      const runId = uuidParam((req.params as { runId: string }).runId, "runId");
      return runToJson(await stopRun(db, queue, req.companyId, req.principal.actor, runId));
    },
  );
}
