// Goals: what a person hands Peter. A goal opens a project at once; Peter
// plans it (model or heuristic), asks at most one round of questions, then
// hands off: tasks with briefs, criteria, outputs, dependencies and assignees,
// a lifetime token budget when the goal has a cap, and the first tasks
// started. Every step is a mutation with events; Peter acts as himself.

import {
  GoalCapsSchema,
  type ActorRef,
  type GoalCaps,
  type GoalStatus,
  type UpdateGoalCapsInput,
} from "@rosterdock/shared";
import { costFor } from "../budgets/cost.js";
import { priceFor } from "../budgets/service.js";
import type { Db, Queryable } from "../db/pool.js";
import type { GitHubProvider } from "../git/github.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import type { RunQueue } from "../queue.js";
import type { ChaseOptions } from "../runs/chase.js";
import { dispatchRun, stopRun } from "../runs/service.js";
import type { ObjectStore } from "../storage/s3.js";
import {
  cancelInTx,
  CANCELLABLE_STATUSES,
  createTask,
  TASK_SELECT,
  taskToJson,
  type TaskRow,
} from "../tasks/service.js";
import { addUsage, type ModelUsage, type PeterModel } from "./model.js";
import {
  heuristicPlan,
  MAX_QUESTION_ROUNDS,
  PlanSchema,
  plannerSystemPrompt,
  plannerUserPrompt,
  validatePlan,
  type Plan,
  type PlanInput,
  type Roster,
} from "./plan.js";
import { ensurePeter, managerFor, managerForTask, type Manager } from "./seat.js";
import { modelAvailable } from "./planners.js";

export interface PeterDeps {
  db: Db;
  queue: RunQueue;
  github: GitHubProvider;
  model: PeterModel;
  log?: { warn(m: string): void };
  /** How long a task may wait on a teammate before the manager chases. */
  chase?: Partial<ChaseOptions>;
  /** Where artifacts over the inline limit are read from. */
  store?: ObjectStore | null;
}

export interface GoalRow {
  id: string;
  company_id: string;
  project_id: string;
  department_id: string | null;
  text: string;
  title: string;
  status: GoalStatus;
  plan: Plan | null;
  questions: { text: string; answer: string | null }[];
  caps: GoalCaps;
  planning_usage: Partial<ModelUsage> & { calls?: number };
  attention: string | null;
  planner: string | null;
  created_by_kind: "user" | "teammate";
  created_by_id: string;
  planned_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function goalToJson(row: GoalRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    departmentId: row.department_id,
    text: row.text,
    title: row.title,
    status: row.status,
    plan: row.plan,
    questions: row.questions ?? [],
    caps: row.caps,
    planningUsage: {
      inputTokens: row.planning_usage?.inputTokens ?? 0,
      outputTokens: row.planning_usage?.outputTokens ?? 0,
      calls: row.planning_usage?.calls ?? 0,
    },
    attention: row.attention,
    planner: row.planner,
    createdBy: { kind: row.created_by_kind, id: row.created_by_id },
    plannedAt: row.planned_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function loadGoal(
  db: Queryable,
  companyId: string,
  goalId: string,
  forUpdate = false,
): Promise<GoalRow> {
  const res = await db.query<GoalRow>(
    `SELECT * FROM goals WHERE id = $1 AND company_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [goalId, companyId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("goal");
  return row;
}

export async function listGoals(db: Queryable, companyId: string): Promise<GoalRow[]> {
  return (
    await db.query<GoalRow>("SELECT * FROM goals WHERE company_id = $1 ORDER BY created_at DESC", [companyId])
  ).rows;
}

function shortTitle(text: string): string {
  const first = text.split(/[.\n]/)[0]?.trim() ?? text;
  return (first.length > 80 ? `${first.slice(0, 77)}…` : first) || "Goal";
}

/**
 * Open a project for the goal, on the repository and branch the goal names, and record it as planning. The
 * caller plans it next.
 */
export async function createGoal(
  deps: PeterDeps,
  companyId: string,
  actor: ActorRef,
  input: {
    text: string;
    departmentId?: string | null;
    repoUrl?: string | null;
    defaultBranch?: string;
    caps?: Partial<GoalCaps>;
  },
): Promise<GoalRow> {
  const caps = GoalCapsSchema.parse(input.caps ?? {});
  const { result } = await mutate(deps.db, companyId, actor, async (ctx) => {
    await ensurePeter(ctx);
    if (input.departmentId) {
      const d = await ctx.client.query("SELECT 1 FROM departments WHERE id = $1 AND company_id = $2", [
        input.departmentId,
        companyId,
      ]);
      if (!d.rowCount) throw new HttpError(422, "department is not in this company");
    }
    const title = shortTitle(input.text);
    const project = (
      await ctx.client.query<{ id: string; name: string; client: string }>(
        `INSERT INTO projects (company_id, name, client, goal, repo_url, default_branch)
         VALUES ($1, $2, 'Internal', $3, $4, $5) RETURNING id, name, client`,
        [companyId, title, input.text, input.repoUrl ?? null, input.defaultBranch ?? "main"],
      )
    ).rows[0]!;
    await ctx.emit(
      "project.created",
      { kind: "project", id: project.id },
      { name: project.name, client: project.client, fromGoal: true },
    );
    const goal = (
      await ctx.client.query<GoalRow>(
        `INSERT INTO goals (company_id, project_id, department_id, text, title, caps, created_by_kind, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          companyId,
          project.id,
          input.departmentId ?? null,
          input.text,
          title,
          JSON.stringify(caps),
          actor.kind,
          actor.id,
        ],
      )
    ).rows[0]!;
    await ctx.emit(
      "goal.created",
      { kind: "goal", id: goal.id },
      {
        title: goal.title,
        projectId: project.id,
        departmentId: goal.department_id,
        preview: input.text.slice(0, 200),
      },
    );
    return goal;
  });
  return result;
}

export async function buildRoster(db: Queryable, companyId: string, manager: Manager): Promise<Roster> {
  const mates = await db.query<{
    id: string;
    name: string;
    handle: string;
    role: string;
    load: number;
    department_ids: string[] | null;
  }>(
    `SELECT t.id, t.name, t.handle, t.role,
       (SELECT count(*)::int FROM tasks k WHERE k.assignee_kind = 'teammate' AND k.assignee_id = t.id AND k.status NOT IN ('done', 'cancelled')) AS load,
       (SELECT array_agg(dm.department_id) FROM department_members dm WHERE dm.teammate_id = t.id) AS department_ids
     FROM teammates t WHERE t.company_id = $1 ORDER BY t.created_at`,
    [companyId],
  );
  const depts = await db.query<{ id: string; name: string; write_policy: string }>(
    "SELECT id, name, write_policy FROM departments WHERE company_id = $1 ORDER BY created_at",
    [companyId],
  );
  return {
    teammates: mates.rows.map((m) => ({
      id: m.id,
      name: m.name,
      handle: m.handle,
      role: m.role,
      load: m.load,
      departmentIds: m.department_ids ?? [],
    })),
    departments: depts.rows.map((d) => ({ id: d.id, name: d.name, writePolicy: d.write_policy })),
    managerId: manager.id,
  };
}

/** The roster a department's goal is planned from: its members and the manager, and that department only. */
export function departmentRoster(roster: Roster, departmentId: string): Roster {
  return {
    ...roster,
    teammates: roster.teammates.filter(
      (m) => m.id === roster.managerId || m.departmentIds.includes(departmentId),
    ),
    departments: roster.departments.filter((d) => d.id === departmentId),
  };
}

/** How many times the model is asked for a plan: once, and once more with why the board did not accept it. */
export const PLAN_ATTEMPTS = 2;

/** How long a planning pass may hold its goal: longer than any model call, so a dead planner's claim runs out. */
export const PLANNING_CLAIM_SECONDS = 600;

/**
 * Plan or re-plan a goal that is in planning. Questions park it; a full plan
 * hands it off. The pass claims the goal first: the request that opened it and
 * the loop (or another replica) can reach it at once, and a model call can
 * take most of a minute, so whoever claims it plans and the other leaves it.
 */
export async function planGoal(deps: PeterDeps, goalId: string): Promise<GoalRow> {
  const claimed = (
    await deps.db.query<GoalRow>(
      `UPDATE goals SET planning_since = now() WHERE id = $1 AND status = 'planning'
         AND (planning_since IS NULL OR planning_since < now() - make_interval(secs => $2)) RETURNING *`,
      [goalId, PLANNING_CLAIM_SECONDS],
    )
  ).rows[0];
  if (!claimed) {
    const row = (await deps.db.query<GoalRow>("SELECT * FROM goals WHERE id = $1", [goalId])).rows[0];
    if (!row) throw notFound("goal");
    return row;
  }
  try {
    return await planClaimed(deps, claimed);
  } finally {
    await deps.db.query("UPDATE goals SET planning_since = NULL WHERE id = $1", [goalId]);
  }
}

async function planClaimed(deps: PeterDeps, first: GoalRow): Promise<GoalRow> {
  const manager = await managerFor(deps.db, first.company_id, first.department_id);
  if (!manager) throw new HttpError(409, "this company has no project manager teammate");
  const roster = await buildRoster(deps.db, first.company_id, manager);
  const project = (
    await deps.db.query<{ repo_url: string | null; default_branch: string }>(
      "SELECT repo_url, default_branch FROM projects WHERE id = $1",
      [first.project_id],
    )
  ).rows[0];
  const answered = (first.questions ?? []).filter((q) => q.answer !== null) as {
    text: string;
    answer: string;
  }[];
  const rounds = first.questions?.length ? 1 : 0;
  const input: PlanInput = {
    goal: first.text,
    answers: answered,
    mayAsk: rounds < MAX_QUESTION_ROUNDS,
    maxTasks: first.caps.maxTasks,
    departmentId: first.department_id,
    repo: project?.repo_url ? { url: project.repo_url, branch: project.default_branch } : null,
  };
  let plan: Plan | null = null;
  let planner = "heuristic";
  let usage: ModelUsage | null = null;
  if (await modelAvailable(deps.model, first.company_id)) {
    // A goal routed to a department is planned from its members: the model sees and may name only them.
    const planRoster = first.department_id ? departmentRoster(roster, first.department_id) : roster;
    try {
      // A plan the board cannot accept goes back to the model once, with the reasons, before the heuristic.
      let refused: string[] | undefined;
      for (let attempt = 1; attempt <= PLAN_ATTEMPTS && !plan; attempt++) {
        if (usage) {
          // The first call is spent whatever the second brings.
          first.planning_usage = addUsage(first.planning_usage, usage);
          await deps.db.query("UPDATE goals SET planning_usage = $2 WHERE id = $1", [
            first.id,
            JSON.stringify(first.planning_usage),
          ]);
          usage = null;
        }
        const result = await deps.model.complete({
          model: manager.model,
          effort: manager.effort,
          system: plannerSystemPrompt(planRoster),
          user: plannerUserPrompt(refused ? { ...input, refused } : input),
          schema: PlanSchema,
          trace: { purpose: "plan", companyId: first.company_id, goalId: first.id },
        });
        usage = result.usage;
        if (result.output) {
          const problems = validatePlan(result.output, planRoster, first.caps.maxTasks, {
            repository: !!input.repo,
          });
          if (!input.mayAsk && result.output.questions.length)
            problems.push("asked questions after its question round");
          if (problems.length === 0) {
            plan = result.output;
            planner = `model:${result.model}`;
          } else {
            planner = `heuristic (the model's plan was refused: ${problems.slice(0, 3).join("; ")})`;
            refused = problems;
          }
        } else if (result.problems?.length) {
          planner = `heuristic (the model's plan did not fit: ${result.problems.slice(0, 3).join("; ")})`;
          refused = result.problems;
        } else {
          // A refusal says nothing to put right: asking again is the same question.
          planner = "heuristic (the model returned no plan)";
          break;
        }
      }
    } catch (err) {
      deps.log?.warn(`Peter's model call failed for goal ${first.id}: ${(err as Error).message}`);
      planner = `heuristic (the model call failed: ${(err as Error).message.slice(0, 120)})`;
    }
  }
  if (!plan) plan = heuristicPlan(input, roster);
  if (plan.questions.length) {
    return parkWithQuestions(deps, first, manager, plan, planner, usage);
  }
  if (plan.tasks.length === 0) {
    return escalateGoal(
      deps,
      first,
      manager,
      "Nobody on the roster can take this goal. Hire a teammate whose role fits, then hand it to me again.",
      {
        plan,
        planner,
        usage,
      },
    );
  }
  return handoff(deps, first, manager, roster, plan, planner, usage);
}

async function parkWithQuestions(
  deps: PeterDeps,
  goal: GoalRow,
  manager: Manager,
  plan: Plan,
  planner: string,
  usage: ModelUsage | null,
): Promise<GoalRow> {
  const { result } = await mutate(
    deps.db,
    goal.company_id,
    { kind: "teammate", id: manager.id },
    async (ctx) => {
      const questions = plan.questions.map((text) => ({ text, answer: null }));
      const row = (
        await ctx.client.query<GoalRow>(
          `UPDATE goals SET status = 'needs_you', plan = $2, questions = $3, planner = $4, planning_usage = $5,
           attention = $6, updated_at = now() WHERE id = $1 RETURNING *`,
          [
            goal.id,
            JSON.stringify(plan),
            JSON.stringify(questions),
            planner,
            JSON.stringify(usage ? addUsage(goal.planning_usage, usage) : goal.planning_usage),
            `${manager.name} has ${questions.length} question${questions.length === 1 ? "" : "s"} before planning.`,
          ],
        )
      ).rows[0]!;
      await ctx.emit(
        "goal.questions",
        { kind: "goal", id: goal.id },
        { title: goal.title, questions: plan.questions, managerName: manager.name },
      );
      return row;
    },
  );
  return result;
}

export async function escalateGoal(
  deps: PeterDeps,
  goal: GoalRow,
  manager: Manager,
  reason: string,
  extra: { plan?: Plan; planner?: string; usage?: ModelUsage | null } = {},
): Promise<GoalRow> {
  const { result } = await mutate(
    deps.db,
    goal.company_id,
    { kind: "teammate", id: manager.id },
    async (ctx) => {
      const row = (
        await ctx.client.query<GoalRow>(
          `UPDATE goals SET status = 'needs_you', attention = $2,
           plan = COALESCE($3, plan), planner = COALESCE($4, planner),
           planning_usage = COALESCE($5, planning_usage), updated_at = now()
         WHERE id = $1 RETURNING *`,
          [
            goal.id,
            reason,
            extra.plan ? JSON.stringify(extra.plan) : null,
            extra.planner ?? null,
            extra.usage ? JSON.stringify(addUsage(goal.planning_usage, extra.usage)) : null,
          ],
        )
      ).rows[0]!;
      await ctx.emit(
        "goal.escalated",
        { kind: "goal", id: goal.id },
        { title: goal.title, reason, managerName: manager.name },
      );
      return row;
    },
  );
  return result;
}

async function handoff(
  deps: PeterDeps,
  goal: GoalRow,
  manager: Manager,
  roster: Roster,
  plan: Plan,
  planner: string,
  usage: ModelUsage | null,
): Promise<GoalRow> {
  const actor: ActorRef = { kind: "teammate", id: manager.id };
  const department =
    goal.department_id ??
    (plan.department ? (roster.departments.find((d) => d.name === plan.department)?.id ?? null) : null);
  // Tasks first, each its own mutation with its own event (the creator is Peter).
  const created: TaskRow[] = [];
  for (const t of plan.tasks) {
    const mate = roster.teammates.find((m) => m.handle === t.assignee.replace(/^@/, "").toLowerCase())!;
    const taskDepartment = department ?? mate.departmentIds[0] ?? null;
    const row = await createTask(
      deps.db,
      goal.company_id,
      actor,
      {
        projectId: goal.project_id,
        title: t.title,
        description: t.brief,
        departmentId: taskDepartment,
        assignee: { kind: "teammate", id: mate.id },
        dependsOn: t.dependsOn.map((i) => created[i]!.id),
        declaredOutputs: t.outputs,
        criteria: t.criteria.map((c) => ({ text: c.text, weight: c.weight })),
        workKind: t.workKind,
      },
      { fromGoal: goal.id },
    );
    created.push(row);
  }
  const { result } = await mutate(deps.db, goal.company_id, actor, async (ctx) => {
    await ctx.client.query("UPDATE projects SET name = $2, goal = $3, updated_at = now() WHERE id = $1", [
      goal.project_id,
      plan.title,
      `${goal.text}\n\nOutcome: ${plan.outcome}\nDone when: ${plan.doneDefinition}`,
    ]);
    if (goal.caps.tokens) {
      await ctx.client.query(
        `INSERT INTO budgets (company_id, scope_kind, scope_id, tokens_limit, window_kind) VALUES ($1, 'goal', $2, $3, 'goal')
         ON CONFLICT (company_id, scope_kind, scope_id) DO UPDATE SET tokens_limit = EXCLUDED.tokens_limit, updated_at = now()`,
        [goal.company_id, goal.id, goal.caps.tokens],
      );
    }
    const row = (
      await ctx.client.query<GoalRow>(
        `UPDATE goals SET status = 'active', title = $2, plan = $3, planner = $4, planning_usage = $5, department_id = $6,
           attention = NULL, planned_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [
          goal.id,
          plan.title,
          JSON.stringify(plan),
          planner,
          JSON.stringify(usage ? addUsage(goal.planning_usage, usage) : goal.planning_usage),
          department,
        ],
      )
    ).rows[0]!;
    await ctx.emit(
      "goal.planned",
      { kind: "goal", id: goal.id },
      {
        title: plan.title,
        projectId: goal.project_id,
        managerName: manager.name,
        planner,
        tasks: created.map((t) => ({
          id: t.id,
          number: t.number,
          title: t.title,
          assigneeId: t.assignee_id,
        })),
        assignees: [
          ...new Set(
            plan.tasks.map(
              (t) =>
                roster.teammates.find((m) => m.handle === t.assignee.replace(/^@/, "").toLowerCase())?.name ??
                t.assignee,
            ),
          ),
        ],
        tokensCap: goal.caps.tokens,
      },
    );
    return row;
  });
  await startReadyTasks(deps, goal.company_id, goal.id);
  return result;
}

/**
 * Autonomy by default: a task Peter (or a teammate) filed for a teammate
 * starts once every task it waits on is Done. Tasks people filed by hand are
 * left alone, a person may be drafting. Returns the runs started.
 */
export async function startReadyTasks(
  deps: PeterDeps,
  companyId: string,
  goalId: string | null,
): Promise<{ taskId: string; runId: string }[]> {
  const params: unknown[] = [companyId];
  let where = `t.company_id = $1 AND t.status = 'todo' AND t.assignee_kind = 'teammate' AND t.created_by_kind = 'teammate'
    AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id WHERE d.task_id = t.id AND p.status <> 'done')
    AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'interrupted'))
    AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.id = t.goal_id AND g.status IN ('stopped', 'needs_you'))`;
  if (goalId) {
    params.push(goalId);
    where += ` AND t.goal_id = $${params.length}`;
  }
  const ready = await deps.db.query<TaskRow>(`${TASK_SELECT} WHERE ${where} ORDER BY t.number`, params);
  const started: { taskId: string; runId: string }[] = [];
  for (const task of ready.rows) {
    const manager = await managerForTask(deps.db, companyId, task);
    if (!manager) continue;
    const actor: ActorRef = { kind: "teammate", id: manager.id };
    try {
      const run = await dispatchRun(deps.db, deps.queue, companyId, actor, task.id, {
        note: `Started by ${manager.name}: everything this task waited on is done.`,
      });
      started.push({ taskId: task.id, runId: run.id });
    } catch (err) {
      // Engine off, budget spent, assignee live elsewhere: the task waits on the board for the next pass.
      deps.log?.warn(`could not start #${task.number}: ${(err as Error).message}`);
    }
  }
  return started;
}

/** The person answers Peter's questions; the goal goes back to planning and is planned again at once. */
export async function answerGoal(
  deps: PeterDeps,
  companyId: string,
  actor: ActorRef,
  goalId: string,
  answers: string[],
): Promise<GoalRow> {
  await mutate(deps.db, companyId, actor, async (ctx) => {
    const goal = await loadGoal(ctx.client, companyId, goalId, true);
    if (goal.status !== "needs_you")
      throw new HttpError(409, `this goal is ${goal.status.replace("_", " ")}`);
    const open = goal.questions.filter((q) => q.answer === null);
    if (!open.length)
      throw new HttpError(409, "this goal has no open questions; it needs a decision, not an answer");
    if (answers.length < open.length)
      throw new HttpError(422, `${open.length} questions are open; ${answers.length} answers given`);
    let i = 0;
    const merged = goal.questions.map((q) =>
      q.answer === null ? { text: q.text, answer: answers[i++] ?? "" } : q,
    );
    await ctx.client.query(
      "UPDATE goals SET questions = $2, status = 'planning', attention = NULL, updated_at = now() WHERE id = $1",
      [goal.id, JSON.stringify(merged)],
    );
    await ctx.emit(
      "goal.answered",
      { kind: "goal", id: goal.id },
      { title: goal.title, answered: open.length },
    );
  });
  return planGoal(deps, goalId);
}

/**
 * A person drops the goal. Runs on its tasks that wait for a worker (or sit
 * interrupted) are stopped and their tasks go back to To do; a run that is
 * live on a worker is asked to stop. The goal is marked first, so the pass
 * those stops wake starts nothing again.
 */
export async function stopGoal(
  deps: PeterDeps,
  companyId: string,
  actor: ActorRef,
  goalId: string,
): Promise<GoalRow> {
  const { result } = await mutate(deps.db, companyId, actor, async (ctx) => {
    const goal = await loadGoal(ctx.client, companyId, goalId, true);
    if (goal.status === "done" || goal.status === "stopped")
      throw new HttpError(409, `this goal is already ${goal.status}`);
    const live = (
      await ctx.client.query<{ id: string; status: string; number: number }>(
        `SELECT r.id, r.status, t.number FROM runs r JOIN tasks t ON t.id = r.task_id
         WHERE t.goal_id = $1 AND r.status IN ('queued', 'running', 'interrupted') ORDER BY r.created_at`,
        [goal.id],
      )
    ).rows;
    const row = (
      await ctx.client.query<GoalRow>(
        "UPDATE goals SET status = 'stopped', attention = NULL, closed_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [goal.id],
      )
    ).rows[0]!;
    // What it leaves unfinished is cancelled, so it does not sit open on the board; a task in review
    // stays with its reviewer.
    const open = (
      await ctx.client.query<Pick<TaskRow, "id" | "number" | "title" | "status">>(
        "SELECT id, number, title, status FROM tasks WHERE goal_id = $1 AND status = ANY($2) ORDER BY number FOR UPDATE",
        [goal.id, CANCELLABLE_STATUSES],
      )
    ).rows;
    for (const t of open) await cancelInTx(ctx, t, `The goal "${goal.title}" was stopped.`);
    await ctx.emit(
      "goal.stopped",
      { kind: "goal", id: goal.id },
      {
        title: goal.title,
        runsStopped: live.filter((r) => r.status !== "running").map((r) => r.number),
        runsAsked: live.filter((r) => r.status === "running").map((r) => r.number),
        tasksCancelled: open.map((t) => t.number),
      },
    );
    return { row, live };
  });
  for (const r of result.live) {
    try {
      await stopRun(deps.db, deps.queue, companyId, actor, r.id);
    } catch (err) {
      // Finished between the read and now: nothing to stop.
      deps.log?.warn(`could not stop the run on #${r.number}: ${(err as Error).message}`);
    }
  }
  return result.row;
}

/**
 * A person raises or lowers a goal's caps. The task and depth caps apply to the
 * next task a teammate files; the token cap is the goal's lifetime budget, kept
 * in step here (set, raised, lowered or removed) once the goal has been handed
 * off. A done or stopped goal keeps its caps.
 */
export async function updateGoalCaps(
  deps: PeterDeps,
  companyId: string,
  actor: ActorRef,
  goalId: string,
  patch: UpdateGoalCapsInput,
): Promise<GoalRow> {
  const { result } = await mutate(deps.db, companyId, actor, async (ctx) => {
    const goal = await loadGoal(ctx.client, companyId, goalId, true);
    if (goal.status === "done" || goal.status === "stopped")
      throw new HttpError(409, `this goal is ${goal.status}; its caps no longer apply`);
    const before = GoalCapsSchema.parse(goal.caps ?? {});
    const after: GoalCaps = {
      maxTasks: patch.maxTasks ?? before.maxTasks,
      maxDepth: patch.maxDepth ?? before.maxDepth,
      tokens: patch.tokens === undefined ? before.tokens : patch.tokens,
    };
    const changed = (Object.keys(after) as (keyof GoalCaps)[]).filter((k) => after[k] !== before[k]);
    if (!changed.length) throw new HttpError(409, "the caps already stand at those numbers");
    const row = (
      await ctx.client.query<GoalRow>(
        "UPDATE goals SET caps = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [goal.id, JSON.stringify(after)],
      )
    ).rows[0]!;
    if (changed.includes("tokens") && goal.planned_at) {
      if (after.tokens) {
        await ctx.client.query(
          `INSERT INTO budgets (company_id, scope_kind, scope_id, tokens_limit, window_kind) VALUES ($1, 'goal', $2, $3, 'goal')
           ON CONFLICT (company_id, scope_kind, scope_id) DO UPDATE SET tokens_limit = EXCLUDED.tokens_limit, updated_at = now()`,
          [companyId, goal.id, after.tokens],
        );
      } else {
        await ctx.client.query(
          "DELETE FROM budgets WHERE company_id = $1 AND scope_kind = 'goal' AND scope_id = $2",
          [companyId, goal.id],
        );
      }
    }
    await ctx.emit(
      "goal.caps_changed",
      { kind: "goal", id: goal.id },
      { title: goal.title, projectId: goal.project_id, before, after, changed },
    );
    return row;
  });
  return result;
}

export interface GoalSpend {
  /** Tokens the teammates' runs used on the goal's tasks. */
  runTokens: number;
  runs: number;
  /** Tokens Peter spent planning. */
  planningTokens: number;
  planningCalls: number;
  totalTokens: number;
  costMinorUnits: number | null;
  currency: string | null;
  tokensCap: number | null;
}

export async function goalSpend(db: Queryable, goal: GoalRow): Promise<GoalSpend> {
  const usage = await db.query<{
    model: string;
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    cache_write_tokens: string;
    runs: string;
  }>(
    `SELECT u.model, sum(u.input_tokens)::text AS input_tokens, sum(u.output_tokens)::text AS output_tokens,
            sum(u.cache_read_tokens)::text AS cache_read_tokens, sum(u.cache_write_tokens)::text AS cache_write_tokens,
            count(*)::text AS runs
     FROM run_usage u JOIN tasks t ON t.id = u.task_id WHERE u.company_id = $1 AND t.goal_id = $2 GROUP BY u.model`,
    [goal.company_id, goal.id],
  );
  let runTokens = 0;
  let runs = 0;
  let cost: number | null = null;
  let currency: string | null = null;
  for (const r of usage.rows) {
    const u = {
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
    };
    runTokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    runs += Number(r.runs);
    const price = await priceFor(db, goal.company_id, r.model);
    const c = costFor(u, price);
    if (c !== null) {
      cost = (cost ?? 0) + c;
      currency = price?.currency ?? currency;
    }
  }
  const pu = goal.planning_usage ?? {};
  const planningTokens =
    (pu.inputTokens ?? 0) + (pu.outputTokens ?? 0) + (pu.cacheReadTokens ?? 0) + (pu.cacheWriteTokens ?? 0);
  return {
    runTokens,
    runs,
    planningTokens,
    planningCalls: pu.calls ?? 0,
    totalTokens: runTokens + planningTokens,
    costMinorUnits: cost,
    currency,
    tokensCap: goal.caps.tokens ?? null,
  };
}

export async function goalDetail(db: Queryable, companyId: string, goalId: string) {
  const goal = await loadGoal(db, companyId, goalId);
  const tasks = await db.query<TaskRow>(`${TASK_SELECT} WHERE t.goal_id = $1 ORDER BY t.number`, [goal.id]);
  return { ...goalToJson(goal), tasks: tasks.rows.map(taskToJson), spend: await goalSpend(db, goal) };
}
