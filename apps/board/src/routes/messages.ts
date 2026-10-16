import { PostMessageSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import { notFound } from "../http-error.js";
import type { RunQueue } from "../queue.js";
import { routeMessage } from "../runs/routing.js";
import { listMessages, messageToJson, postMessage } from "../tasks/service.js";
import { parseBody, uuidParam } from "../validate.js";

export function registerMessageRoutes(app: FastifyInstance, db: Db, queue: RunQueue): void {
  app.get(
    "/api/companies/:companyId/tasks/:taskId/messages",
    { config: { action: "company.read" } },
    async (req) => {
      const taskId = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const task = await db.query("SELECT 1 FROM tasks WHERE id = $1 AND company_id = $2", [
        taskId,
        req.companyId,
      ]);
      if (!task.rowCount) throw notFound("task");
      return (await listMessages(db, req.companyId, taskId)).map(messageToJson);
    },
  );

  app.post(
    "/api/companies/:companyId/tasks/:taskId/messages",
    { config: { action: "message.post" } },
    async (req, reply) => {
      const taskId = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const body = parseBody(PostMessageSchema, req.body);
      // A teammate posting from inside a run: remember the run, so replies can be told from fresh asks.
      const runId = req.principal.kind === "teammate" ? (req.principal.runId ?? null) : null;
      const row = await postMessage(db, req.companyId, req.principal.actor, taskId, body.body, { runId });
      const routed = await routeMessage(db, queue, row);
      reply.code(201);
      return { ...messageToJson(row), routed };
    },
  );
}
