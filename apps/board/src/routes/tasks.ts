import { CancelTaskSchema, CreateTaskSchema, MoveTaskSchema, UpdateTaskSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import { assertActorInCompany } from "../actors.js";
import type { Principal } from "../auth/tokens.js";
import type { Db, Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import type { RunQueue } from "../queue.js";
import { loadRun, stopRun } from "../runs/service.js";
import {
  assertDepartment,
  assertTeammateDepartment,
  cancelTask,
  createTask,
  decisionToJson,
  listDecisions,
  loadTask,
  moveTask,
  reopenTask,
  TASK_SELECT,
  taskToJson,
  type TaskRow,
} from "../tasks/service.js";
import { parseBody, uuidParam } from "../validate.js";

export { taskToJson, type TaskRow };

/** The task a run-scoped teammate token's run is on; null for a person, or a teammate outside a run. */
async function principalRunTask(db: Queryable, principal: Principal): Promise<string | null> {
  if (principal.kind !== "teammate" || !principal.runId) return null;
  return (await loadRun(db, principal.runId)).task_id;
}

export function registerTaskRoutes(app: FastifyInstance, db: Db, queue: RunQueue): void {
  app.get("/api/companies/:companyId/tasks", { config: { action: "company.read" } }, async (req) => {
    const q = req.query as { projectId?: string; departmentId?: string; status?: string };
    const params: unknown[] = [req.companyId];
    const where = ["t.company_id = $1"];
    if (q.projectId) {
      params.push(uuidParam(q.projectId, "projectId"));
      where.push(`t.project_id = $${params.length}`);
    }
    if (q.departmentId) {
      params.push(uuidParam(q.departmentId, "departmentId"));
      where.push(`t.department_id = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`t.status = $${params.length}`);
    }
    const res = await db.query<TaskRow>(
      `${TASK_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.number DESC`,
      params,
    );
    return res.rows.map(taskToJson);
  });

  app.post("/api/companies/:companyId/tasks", { config: { action: "task.create" } }, async (req, reply) => {
    const body = parseBody(CreateTaskSchema, req.body);
    // A teammate filing from its run files a follow-up of the run's task, as over MCP: same department.
    const runTaskId = await principalRunTask(db, req.principal);
    const task = await createTask(
      db,
      req.companyId,
      req.principal.actor,
      body,
      runTaskId ? { parentTaskId: runTaskId } : {},
    );
    reply.code(201);
    return taskToJson(task);
  });

  app.get("/api/companies/:companyId/tasks/:taskId", { config: { action: "company.read" } }, async (req) => {
    const id = uuidParam((req.params as { taskId: string }).taskId, "taskId");
    return taskToJson(await loadTask(db, req.companyId, id));
  });

  app.get(
    "/api/companies/:companyId/tasks/:taskId/decisions",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      await loadTask(db, req.companyId, id);
      return (await listDecisions(db, id)).map(decisionToJson);
    },
  );

  app.patch("/api/companies/:companyId/tasks/:taskId", { config: { action: "task.update" } }, async (req) => {
    const id = uuidParam((req.params as { taskId: string }).taskId, "taskId");
    const body = parseBody(UpdateTaskSchema, req.body);
    const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
      const task = await loadTask(ctx.client, req.companyId, id, true);
      if (task.status === "done")
        throw new HttpError(409, `#${task.number} is done. Open Activity for the history.`);
      await assertDepartment(ctx.client, req.companyId, body.departmentId);
      if (req.principal.kind === "teammate" && body.departmentId !== undefined)
        await assertTeammateDepartment(
          ctx.client,
          req.companyId,
          req.principal.teammate.id,
          body.departmentId,
          await principalRunTask(ctx.client, req.principal),
        );
      const assignee = body.assignee
        ? await assertActorInCompany(ctx.client, req.companyId, body.assignee)
        : null;
      const assigneeChanged = body.assignee !== undefined;
      await ctx.client.query(
        `UPDATE tasks SET title = COALESCE($3, title), description = COALESCE($4, description),
           department_id = CASE WHEN $5::boolean THEN $6 ELSE department_id END,
           assignee_kind = CASE WHEN $7::boolean THEN $8 ELSE assignee_kind END,
           assignee_id = CASE WHEN $7::boolean THEN $9 ELSE assignee_id END,
           declared_outputs = COALESCE($10::jsonb, declared_outputs),
           criteria = COALESCE($11::jsonb, criteria),
           work_kind = COALESCE($12, work_kind),
           updated_at = now()
         WHERE id = $1 AND company_id = $2`,
        [
          id,
          req.companyId,
          body.title ?? null,
          body.description ?? null,
          body.departmentId !== undefined,
          body.departmentId ?? null,
          assigneeChanged,
          assignee?.kind ?? null,
          assignee?.id ?? null,
          body.declaredOutputs ? JSON.stringify(body.declaredOutputs) : null,
          body.criteria ? JSON.stringify(body.criteria) : null,
          body.workKind ?? null,
        ],
      );
      const changes = Object.keys(body).filter((k) => k !== "assignee");
      if (changes.length)
        await ctx.emit(
          "task.updated",
          { kind: "task", id },
          { number: task.number, title: body.title ?? task.title, changes },
        );
      if (assigneeChanged) {
        await ctx.emit(
          "task.assigned",
          { kind: "task", id },
          {
            number: task.number,
            title: body.title ?? task.title,
            assignee: assignee ? { kind: assignee.kind, id: assignee.id, name: assignee.name } : null,
          },
        );
      }
      if (ctx.events.length === 0)
        await ctx.emit(
          "task.updated",
          { kind: "task", id },
          { number: task.number, title: task.title, changes: [] },
        );
      return loadTask(ctx.client, req.companyId, id);
    });
    return taskToJson(result);
  });

  // Moves between columns. Done is never reachable here: an approved review marks Done (M3).
  app.post(
    "/api/companies/:companyId/tasks/:taskId/move",
    { config: { action: "task.update" } },
    async (req) => {
      const id = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const raw = (req.body ?? {}) as { status?: string };
      if (raw.status === "done")
        throw new HttpError(409, "a task reaches Done only through an approved review");
      const body = parseBody(MoveTaskSchema, req.body);
      return taskToJson(await moveTask(db, req.companyId, req.principal.actor, id, body));
    },
  );

  // Close a task that will not be done (owners and admins). Its live runs are stopped; it is never Done.
  app.post(
    "/api/companies/:companyId/tasks/:taskId/cancel",
    { config: { action: "task.cancel" } },
    async (req) => {
      const id = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const body = parseBody(CancelTaskSchema, req.body ?? {});
      const { task, liveRuns } = await cancelTask(
        db,
        req.companyId,
        req.principal.actor,
        id,
        body.note ?? null,
      );
      for (const runId of liveRuns) {
        await stopRun(db, queue, req.companyId, req.principal.actor, runId).catch((err: Error) =>
          req.log.warn({ err, runId }, "could not stop a run on a cancelled task"),
        );
      }
      return taskToJson(task);
    },
  );

  app.post(
    "/api/companies/:companyId/tasks/:taskId/reopen",
    { config: { action: "task.cancel" } },
    async (req) => {
      const id = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      return taskToJson(await reopenTask(db, req.companyId, req.principal.actor, id));
    },
  );

  app.put(
    "/api/companies/:companyId/tasks/:taskId/dependencies/:dependsOnId",
    { config: { action: "task.update" } },
    async (req) => {
      const params = req.params as { taskId: string; dependsOnId: string };
      const id = uuidParam(params.taskId, "taskId");
      const dep = uuidParam(params.dependsOnId, "dependsOnId");
      if (id === dep) throw new HttpError(422, "a task cannot depend on itself");
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const task = await loadTask(ctx.client, req.companyId, id, true);
        const other = await loadTask(ctx.client, req.companyId, dep);
        // Refuse cycles: dep must not (transitively) depend on task.
        const cycle = await ctx.client.query(
          `WITH RECURSIVE chain AS (
           SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = $1
           UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain c ON d.task_id = c.id)
         SELECT 1 FROM chain WHERE id = $2`,
          [dep, id],
        );
        if (cycle.rowCount) throw new HttpError(409, "that dependency would form a cycle");
        await ctx.client.query(
          "INSERT INTO task_dependencies (company_id, task_id, depends_on_task_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [req.companyId, id, dep],
        );
        await ctx.emit(
          "task.dependency_added",
          { kind: "task", id },
          { number: task.number, dependsOn: { id: other.id, number: other.number, title: other.title } },
        );
        return loadTask(ctx.client, req.companyId, id);
      });
      return taskToJson(result);
    },
  );

  app.delete(
    "/api/companies/:companyId/tasks/:taskId/dependencies/:dependsOnId",
    { config: { action: "task.update" } },
    async (req) => {
      const params = req.params as { taskId: string; dependsOnId: string };
      const id = uuidParam(params.taskId, "taskId");
      const dep = uuidParam(params.dependsOnId, "dependsOnId");
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const task = await loadTask(ctx.client, req.companyId, id, true);
        const res = await ctx.client.query(
          "DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2",
          [id, dep],
        );
        if (!res.rowCount) throw notFound("dependency");
        await ctx.emit(
          "task.dependency_removed",
          { kind: "task", id },
          { number: task.number, dependsOn: { id: dep } },
        );
        return loadTask(ctx.client, req.companyId, id);
      });
      return taskToJson(result);
    },
  );
}
