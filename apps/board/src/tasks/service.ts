// Task and message operations shared by the HTTP routes and the board MCP
// server. Every function runs inside a mutation and emits events.

import {
  blockerFor,
  extractMentions,
  type ActorRef,
  type BlockerInput,
  type BlockerRecord,
  type CreateTaskInput,
  type Criterion,
  type MoveTaskInput,
  type TaskStatus,
  type WorkKind,
} from "@rosterdock/shared";
import { assertActorInCompany, describeActor } from "../actors.js";
import type { Db, Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate, type MutationContext } from "../mutate.js";

export interface TaskRow {
  id: string;
  company_id: string;
  project_id: string;
  department_id: string | null;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  assignee_kind: "user" | "teammate" | null;
  assignee_id: string | null;
  created_by_kind: "user" | "teammate";
  created_by_id: string;
  blocker: BlockerRecord | null;
  done_by: Record<string, unknown> | null;
  declared_outputs: string[];
  criteria: Criterion[];
  active_run_id: string | null;
  work_kind: WorkKind;
  parent_task_id: string | null;
  replans: number;
  created_at: Date;
  updated_at: Date;
  message_count?: number;
  depends_on?: string[] | null;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "In progress",
  blocked: "Blocked",
  review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export function taskToJson(row: TaskRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    departmentId: row.department_id,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee_kind && row.assignee_id ? { kind: row.assignee_kind, id: row.assignee_id } : null,
    createdBy: { kind: row.created_by_kind, id: row.created_by_id },
    blocker: row.blocker,
    doneBy: row.done_by,
    messageCount: row.message_count ?? 0,
    dependsOn: row.depends_on ?? [],
    declaredOutputs: row.declared_outputs ?? [],
    criteria: row.criteria ?? [],
    activeRunId: row.active_run_id,
    workKind: row.work_kind ?? "build",
    parentTaskId: row.parent_task_id,
    replans: row.replans ?? 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const TASK_SELECT = `
  SELECT t.*,
    (SELECT count(*)::int FROM messages m WHERE m.task_id = t.id) AS message_count,
    (SELECT coalesce(array_agg(d.depends_on_task_id), '{}') FROM task_dependencies d WHERE d.task_id = t.id) AS depends_on
  FROM tasks t`;

export async function loadTask(
  db: Queryable,
  companyId: string,
  id: string,
  forUpdate = false,
): Promise<TaskRow> {
  const res = await db.query<TaskRow>(
    `${TASK_SELECT} WHERE t.id = $1 AND t.company_id = $2${forUpdate ? " FOR UPDATE OF t" : ""}`,
    [id, companyId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("task");
  return row;
}

export async function findTaskByNumber(
  db: Queryable,
  companyId: string,
  number: number,
): Promise<TaskRow | null> {
  const res = await db.query<TaskRow>(`${TASK_SELECT} WHERE t.company_id = $1 AND t.number = $2`, [
    companyId,
    number,
  ]);
  return res.rows[0] ?? null;
}

export async function unresolvedDependencies(db: Queryable, taskId: string) {
  const res = await db.query<{ id: string; number: number; title: string }>(
    `SELECT t.id, t.number, t.title FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = $1 AND t.status <> 'done' ORDER BY t.number`,
    [taskId],
  );
  return res.rows;
}

export async function assertDepartment(
  db: Queryable,
  companyId: string,
  departmentId: string | null | undefined,
) {
  if (!departmentId) return;
  const res = await db.query("SELECT 1 FROM departments WHERE id = $1 AND company_id = $2", [
    departmentId,
    companyId,
  ]);
  if (!res.rowCount) throw new HttpError(422, "department is not in this company");
}

/** The department a task is in; null when it has none. */
async function taskDepartment(db: Queryable, companyId: string, taskId: string): Promise<string | null> {
  const res = await db.query<{ department_id: string | null }>(
    "SELECT department_id FROM tasks WHERE id = $1 AND company_id = $2",
    [taskId, companyId],
  );
  return res.rows[0]?.department_id ?? null;
}

/**
 * A teammate files and moves work only inside its own department, so a run never leaves its
 * department's sandbox, worker pool and write policy by putting a task somewhere else. In a run that
 * is the department of the run's task, whatever project the work goes into; outside a run, a
 * department the teammate belongs to (or none). People, and Peter's plans, are not narrowed here.
 */
export async function assertTeammateDepartment(
  db: Queryable,
  companyId: string,
  teammateId: string,
  departmentId: string | null,
  runTaskId: string | null,
): Promise<void> {
  if (runTaskId) {
    if ((await taskDepartment(db, companyId, runTaskId)) !== departmentId)
      throw new HttpError(403, "a teammate's work in a run stays in the department of the run's task");
    return;
  }
  if (!departmentId) return;
  const member = await db.query(
    `SELECT 1 FROM department_members WHERE company_id = $1 AND department_id = $2 AND teammate_id = $3
     UNION ALL SELECT 1 FROM departments WHERE company_id = $1 AND id = $2 AND lead_teammate_id = $3`,
    [companyId, departmentId, teammateId],
  );
  if (!member.rowCount)
    throw new HttpError(403, "a teammate files work only into a department it belongs to");
}

/** Teammates may not flood a project: at most this many tasks per project per day from teammates. */
export const TEAMMATE_TASKS_PER_PROJECT_PER_DAY = 25;

/** How deep a task sits below the goal's own tasks: the length of its parent chain. */
export async function taskDepth(db: Queryable, taskId: string | null): Promise<number> {
  let depth = 0;
  let cursor = taskId;
  while (cursor && depth < 50) {
    const res = await db.query<{ parent_task_id: string | null }>(
      "SELECT parent_task_id FROM tasks WHERE id = $1",
      [cursor],
    );
    cursor = res.rows[0]?.parent_task_id ?? null;
    depth += 1;
  }
  return depth;
}

export interface CreateTaskOptions {
  /**
   * The task the creating teammate was working in its run; sets the depth for the goal's caps, and
   * the new task's department when the body names none.
   */
  parentTaskId?: string | null;
  /** Peter's own tasks at handoff: counted against the goal's task cap, depth 0. */
  fromGoal?: boolean;
}

/**
 * A project that came from a goal has caps: teammates (Peter included) cannot
 * create tasks past them; a person must. Runaway delegation stops here.
 */
async function assertWithinGoalCaps(
  db: Queryable,
  projectId: string,
  actor: ActorRef,
  opts: CreateTaskOptions,
): Promise<void> {
  if (actor.kind !== "teammate") return;
  const goal = (
    await db.query<{ id: string; title: string; caps: { maxTasks?: number; maxDepth?: number } }>(
      "SELECT id, title, caps FROM goals WHERE project_id = $1",
      [projectId],
    )
  ).rows[0];
  if (!goal) return;
  const maxTasks = goal.caps?.maxTasks ?? 12;
  const maxDepth = goal.caps?.maxDepth ?? 2;
  const count = (
    await db.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE project_id = $1", [projectId])
  ).rows[0]!.n;
  if (count >= maxTasks) {
    throw new HttpError(
      429,
      `the goal "${goal.title}" is capped at ${maxTasks} tasks and has ${count}; a person must raise the cap or open more`,
    );
  }
  if (!opts.fromGoal) {
    const depth = await taskDepth(db, opts.parentTaskId ?? null);
    if (depth > maxDepth) {
      throw new HttpError(
        429,
        `the goal "${goal.title}" allows follow-up tasks ${maxDepth} deep; this one would be ${depth} deep. Ask the project manager instead.`,
      );
    }
  }
}

export async function createTask(
  db: Db,
  companyId: string,
  actor: ActorRef,
  body: CreateTaskInput,
  opts: CreateTaskOptions = {},
): Promise<TaskRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const project = await ctx.client.query("SELECT 1 FROM projects WHERE id = $1 AND company_id = $2", [
      body.projectId,
      companyId,
    ]);
    if (!project.rowCount) throw new HttpError(422, "project is not in this company");
    await assertDepartment(ctx.client, companyId, body.departmentId);
    let departmentId = body.departmentId ?? null;
    if (actor.kind === "teammate" && !opts.fromGoal) {
      const runTaskId = opts.parentTaskId ?? null;
      if (runTaskId && body.departmentId === undefined)
        departmentId = await taskDepartment(ctx.client, companyId, runTaskId);
      await assertTeammateDepartment(ctx.client, companyId, actor.id, departmentId, runTaskId);
    }
    if (actor.kind === "teammate") {
      const recent = await ctx.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND created_by_kind = 'teammate' AND created_at > now() - interval '1 day'`,
        [body.projectId],
      );
      if ((recent.rows[0]?.n ?? 0) >= TEAMMATE_TASKS_PER_PROJECT_PER_DAY) {
        throw new HttpError(
          429,
          `teammates have already created ${TEAMMATE_TASKS_PER_PROJECT_PER_DAY} tasks in this project today; a person must open more`,
        );
      }
    }
    await assertWithinGoalCaps(ctx.client, body.projectId, actor, opts);
    const assignee = body.assignee ? await assertActorInCompany(ctx.client, companyId, body.assignee) : null;
    // What the task points at (the tasks it waits on, the one it was filed from) is locked before it takes a
    // number. Every other mutation locks its rows first and the company counter last, with its first event;
    // numbering first and locking a dependency after deadlocked with a task being started (Peter filing a
    // plan's second task while the loop started the first).
    const references = opts.parentTaskId ? [...body.dependsOn, opts.parentTaskId] : body.dependsOn;
    if (references.length) {
      const found = new Set(
        (
          await ctx.client.query<{ id: string }>(
            "SELECT id FROM tasks WHERE id = ANY($1::uuid[]) AND company_id = $2 ORDER BY number FOR KEY SHARE",
            [references, companyId],
          )
        ).rows.map((r) => r.id),
      );
      const missing = body.dependsOn.find((dep) => !found.has(dep));
      if (missing) throw new HttpError(422, `dependency ${missing} is not a task in this company`);
    }
    const num = await ctx.client.query<{ n: number }>(
      "UPDATE company_counters SET next_task_number = next_task_number + 1 WHERE company_id = $1 RETURNING next_task_number - 1 AS n",
      [companyId],
    );
    const number = num.rows[0]!.n;
    const inserted = await ctx.client.query<{ id: string }>(
      `INSERT INTO tasks (company_id, project_id, department_id, number, title, description, assignee_kind, assignee_id, created_by_kind, created_by_id, declared_outputs, criteria, work_kind, parent_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        companyId,
        body.projectId,
        departmentId,
        number,
        body.title,
        body.description,
        assignee?.kind ?? null,
        assignee?.id ?? null,
        actor.kind,
        actor.id,
        JSON.stringify(body.declaredOutputs),
        JSON.stringify(body.criteria),
        body.workKind ?? "build",
        opts.parentTaskId ?? null,
      ],
    );
    const id = inserted.rows[0]!.id;
    for (const dep of body.dependsOn) {
      await ctx.client.query(
        "INSERT INTO task_dependencies (company_id, task_id, depends_on_task_id) VALUES ($1, $2, $3)",
        [companyId, id, dep],
      );
    }
    const creator = await describeActor(ctx.client, companyId, actor);
    await ctx.emit(
      "task.created",
      { kind: "task", id },
      {
        number,
        title: body.title,
        projectId: body.projectId,
        departmentId,
        assignee: assignee ? { kind: assignee.kind, id: assignee.id, name: assignee.name } : null,
        createdByName: creator?.name ?? null,
        dependsOn: body.dependsOn,
        workKind: body.workKind ?? "build",
      },
    );
    return loadTask(ctx.client, companyId, id);
  });
  return result;
}

export function blockerFromInput(input: BlockerInput): BlockerRecord {
  return blockerFor(input.code, {
    ...(input.what ? { what: input.what } : {}),
    ...(input.why ? { why: input.why } : {}),
    ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}),
  });
}

async function setBlocked(ctx: MutationContext, task: TaskRow, blocker: BlockerRecord): Promise<void> {
  await ctx.client.query(
    "UPDATE tasks SET status = 'blocked', blocker = $2, updated_at = now() WHERE id = $1",
    [task.id, JSON.stringify(blocker)],
  );
  await ctx.emit(
    "task.blocked",
    { kind: "task", id: task.id },
    { number: task.number, title: task.title, blocker },
  );
}

/** What a person may cancel: not Done, and not In review (a reviewer decides those). */
export const CANCELLABLE_STATUSES: readonly TaskStatus[] = ["todo", "doing", "blocked"];

/**
 * Close a task that will not be done, inside a mutation. Returns the runs still
 * live on it for the caller to stop; their end leaves the task cancelled.
 */
export async function cancelInTx(
  ctx: MutationContext,
  task: Pick<TaskRow, "id" | "number" | "title" | "status">,
  note: string | null,
): Promise<string[]> {
  await ctx.client.query(
    "UPDATE tasks SET status = 'cancelled', blocker = NULL, updated_at = now() WHERE id = $1",
    [task.id],
  );
  await ctx.emit(
    "task.moved",
    { kind: "task", id: task.id },
    {
      number: task.number,
      title: task.title,
      from: task.status,
      to: "cancelled",
      toLabel: STATUS_LABEL.cancelled,
      ...(note ? { note } : {}),
    },
  );
  const live = await ctx.client.query<{ id: string }>(
    "SELECT id FROM runs WHERE task_id = $1 AND status IN ('queued', 'running', 'interrupted') ORDER BY created_at",
    [task.id],
  );
  return live.rows.map((r) => r.id);
}

/** A person drops a task: it is closed, not Done. The caller stops the runs returned. */
export async function cancelTask(
  db: Db,
  companyId: string,
  actor: ActorRef,
  taskId: string,
  note: string | null,
): Promise<{ task: TaskRow; liveRuns: string[] }> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const task = await loadTask(ctx.client, companyId, taskId, true);
    if (!CANCELLABLE_STATUSES.includes(task.status))
      throw new HttpError(
        409,
        task.status === "review"
          ? `#${task.number} is in review: its reviewer decides it, so request changes before cancelling it`
          : `#${task.number} is ${task.status === "done" ? "done" : "already cancelled"}`,
      );
    const liveRuns = await cancelInTx(ctx, task, note);
    return { task: await loadTask(ctx.client, companyId, taskId), liveRuns };
  });
  return result;
}

/** A person takes a cancelled task back: it is To do again. */
export async function reopenTask(
  db: Db,
  companyId: string,
  actor: ActorRef,
  taskId: string,
): Promise<TaskRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const task = await loadTask(ctx.client, companyId, taskId, true);
    if (task.status !== "cancelled") throw new HttpError(409, `#${task.number} is not cancelled`);
    await ctx.client.query("UPDATE tasks SET status = 'todo', updated_at = now() WHERE id = $1", [taskId]);
    await ctx.emit(
      "task.moved",
      { kind: "task", id: taskId },
      { number: task.number, title: task.title, from: "cancelled", to: "todo", toLabel: STATUS_LABEL.todo },
    );
    return loadTask(ctx.client, companyId, taskId);
  });
  return result;
}

/** Moves between columns. Done is never reachable here: an approved review marks Done. */
export async function moveTask(
  db: Db,
  companyId: string,
  actor: ActorRef,
  taskId: string,
  body: MoveTaskInput,
): Promise<TaskRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const task = await loadTask(ctx.client, companyId, taskId, true);
    if (task.status === "done") throw new HttpError(409, `#${task.number} is done and cannot be moved`);
    if (task.status === "cancelled")
      throw new HttpError(409, `#${task.number} is cancelled: reopen it before moving it`);
    const from = task.status;
    if (body.status === "blocked") {
      const actorName = (await describeActor(ctx.client, companyId, actor))?.name ?? "a teammate";
      const blocker = body.blocker
        ? blockerFromInput(body.blocker)
        : blockerFor("unknown", { what: `Blocked by ${actorName}. Tell the team why in the conversation.` });
      await setBlocked(ctx, task, blocker);
    } else {
      if (body.status === "doing") {
        const unresolved = await unresolvedDependencies(ctx.client, taskId);
        if (unresolved.length) {
          const first = unresolved[0]!;
          throw new HttpError(409, `#${task.number} is waiting on #${first.number} ${first.title}`, {
            blocker: blockerFor("dependencies_unresolved", {
              what: `Waiting on #${first.number} to reach Done.`,
              waitingOn: { kind: "task", id: first.id, name: `#${first.number}` },
            }),
          });
        }
      }
      if (from === body.status) return task;
      await ctx.client.query(
        "UPDATE tasks SET status = $2, blocker = NULL, updated_at = now() WHERE id = $1",
        [taskId, body.status],
      );
      if (from === "blocked")
        await ctx.emit(
          "task.unblocked",
          { kind: "task", id: taskId },
          { number: task.number, title: task.title },
        );
    }
    await ctx.emit(
      "task.moved",
      { kind: "task", id: taskId },
      { number: task.number, title: task.title, from, to: body.status, toLabel: STATUS_LABEL[body.status] },
    );
    return loadTask(ctx.client, companyId, taskId);
  });
  return result;
}

export interface MessageRow {
  id: string;
  company_id: string;
  task_id: string;
  author_kind: "user" | "teammate";
  author_id: string;
  body: string;
  mentions: { kind: "teammate"; id: string; handle: string; name: string }[];
  /** The run the author was in when they wrote it, for teammate messages. */
  run_id: string | null;
  created_at: Date;
  author_name?: string;
}

export function messageToJson(row: MessageRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    author: { kind: row.author_kind, id: row.author_id, name: row.author_name ?? null },
    body: row.body,
    mentions: row.mentions,
    createdAt: row.created_at.toISOString(),
  };
}

export const MESSAGE_SELECT = `
  SELECT m.*, CASE m.author_kind WHEN 'user' THEN u.name ELSE t.name END AS author_name
  FROM messages m
  LEFT JOIN users u ON m.author_kind = 'user' AND u.id = m.author_id
  LEFT JOIN teammates t ON m.author_kind = 'teammate' AND t.id = m.author_id`;

export async function listMessages(
  db: Queryable,
  companyId: string,
  taskId: string,
  limit = 500,
): Promise<MessageRow[]> {
  const res = await db.query<MessageRow>(
    `${MESSAGE_SELECT} WHERE m.task_id = $1 AND m.company_id = $2 ORDER BY m.created_at LIMIT $3`,
    [taskId, companyId, limit],
  );
  return res.rows;
}

/** Post on a task's conversation. @handles resolve to teammates and are recorded as mentions. */
export async function postMessage(
  db: Db,
  companyId: string,
  actor: ActorRef,
  taskId: string,
  body: string,
  opts: { runId?: string | null } = {},
): Promise<MessageRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const task = await ctx.client.query<{ number: number; title: string }>(
      "SELECT number, title FROM tasks WHERE id = $1 AND company_id = $2",
      [taskId, companyId],
    );
    const t = task.rows[0];
    if (!t) throw notFound("task");
    const handles = extractMentions(body);
    const mentions: MessageRow["mentions"] = [];
    if (handles.length) {
      const res = await ctx.client.query<{ id: string; handle: string; name: string }>(
        "SELECT id, handle, name FROM teammates WHERE company_id = $1 AND handle = ANY($2::text[])",
        [companyId, handles],
      );
      for (const h of handles) {
        const m = res.rows.find((r) => r.handle === h);
        // A teammate mentioning itself does not route anywhere.
        if (m && !(actor.kind === "teammate" && actor.id === m.id)) {
          mentions.push({ kind: "teammate", id: m.id, handle: m.handle, name: m.name });
        }
      }
    }
    const inserted = await ctx.client.query<{ id: string }>(
      "INSERT INTO messages (company_id, task_id, author_kind, author_id, body, mentions, run_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [companyId, taskId, actor.kind, actor.id, body, JSON.stringify(mentions), opts.runId ?? null],
    );
    const author = await describeActor(ctx.client, companyId, actor);
    await ctx.emit(
      "message.posted",
      { kind: "task", id: taskId },
      {
        messageId: inserted.rows[0]!.id,
        number: t.number,
        title: t.title,
        authorName: author?.name ?? null,
        preview: body.slice(0, 140),
        mentions: mentions.map((m) => ({ id: m.id, handle: m.handle, name: m.name })),
      },
    );
    const row = await ctx.client.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [
      inserted.rows[0]!.id,
    ]);
    return row.rows[0]!;
  });
  return result;
}

export interface DecisionRow {
  id: string;
  task_id: string;
  run_id: string | null;
  teammate_id: string;
  decision: string;
  assumptions: string[];
  confidence: string | number;
  created_at: Date;
}

export function decisionToJson(row: DecisionRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    teammateId: row.teammate_id,
    decision: row.decision,
    assumptions: row.assumptions,
    confidence: Number(row.confidence),
    createdAt: row.created_at.toISOString(),
  };
}

export async function listDecisions(db: Queryable, taskId: string): Promise<DecisionRow[]> {
  const res = await db.query<DecisionRow>("SELECT * FROM decisions WHERE task_id = $1 ORDER BY created_at", [
    taskId,
  ]);
  return res.rows;
}

/** The decision audit trail: what a teammate decided, on what assumptions, with what confidence. */
export async function logDecision(
  db: Db,
  companyId: string,
  teammateId: string,
  runId: string | null,
  taskId: string,
  input: { decision: string; assumptions: string[]; confidence: number },
): Promise<DecisionRow> {
  const { result } = await mutate(db, companyId, { kind: "teammate", id: teammateId }, async (ctx) => {
    const task = await loadTask(ctx.client, companyId, taskId);
    const res = await ctx.client.query<DecisionRow>(
      `INSERT INTO decisions (company_id, task_id, run_id, teammate_id, decision, assumptions, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        companyId,
        taskId,
        runId,
        teammateId,
        input.decision,
        JSON.stringify(input.assumptions),
        input.confidence,
      ],
    );
    const row = res.rows[0]!;
    await ctx.emit(
      "decision.logged",
      { kind: "task", id: taskId },
      {
        number: task.number,
        title: task.title,
        decisionId: row.id,
        decision: input.decision.slice(0, 300),
        assumptions: input.assumptions.length,
        confidence: input.confidence,
      },
    );
    return row;
  });
  return result;
}
