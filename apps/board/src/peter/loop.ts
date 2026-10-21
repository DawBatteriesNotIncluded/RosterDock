// The PM loop. One pass over a company: plan goals still waiting, start the
// tasks whose dependencies are done, re-plan failed runs (twice, then
// escalate), restart authors a review sent back, escalate reviews that go
// round and round, chase teammates that keep others waiting, rebalance load,
// and close goals whose every task is Done, with what they cost. Runs on a
// timer and on the events it cares about. Deterministic: the model only
// writes the re-plan note when Peter has one. Escalation is the goal turning
// amber; nothing else reaches a person. Merges and live writes stay gates.

import { blockerKind, type ActorRef, type EventRecord, type EventType } from "@rosterdock/shared";
import type { EventBus } from "../events/bus.js";
import { HttpError } from "../http-error.js";
import { mutate } from "../mutate.js";
import { chasePass, type ChaseOptions } from "../runs/chase.js";
import { dispatchRun, type RunRow } from "../runs/service.js";
import { artifactText } from "../storage/artifacts.js";
import { postMessage, TASK_SELECT, type TaskRow } from "../tasks/service.js";
import { escalateGoal, goalSpend, planGoal, startReadyTasks, type GoalRow, type PeterDeps } from "./goals.js";
import { addUsage } from "./model.js";
import {
  heuristicReplan,
  MAX_REPLANS,
  MAX_REVIEW_ROUNDS,
  ReplanSchema,
  replanModel,
  replanSystemPrompt,
  replanUserPrompt,
  type FailureContext,
  type Replan,
} from "./replan.js";
import { managerFor, managerForTask, type Manager } from "./seat.js";
import { modelAvailable } from "./planners.js";

/** A teammate with this many open tasks hands the extra ones to a colleague of the same role. */
export const REBALANCE_ABOVE = 3;

export interface PassResult {
  companyId: string;
  planned: string[];
  started: { taskId: string; runId: string }[];
  replanned: { taskId: string; runId: string; replans: number }[];
  restarted: { taskId: string; runId: string }[];
  escalated: { goalId: string; reason: string }[];
  /** Escalated goals a person has dealt with, active again. */
  resumed: string[];
  chased: number;
  rebalanced: { taskId: string; from: string; to: string }[];
  closed: string[];
}

/** Events that wake the loop for their company. */
export const PETER_WAKE_EVENTS: readonly EventType[] = [
  "goal.created",
  "goal.answered",
  "run.failed",
  "run.blocked",
  "run.completed",
  "run.stopped",
  "task.done",
  "task.blocked",
  "review.changes_requested",
  "review.approved",
  "review.vetoed",
  "pr.failed",
  "budget.alert",
  "goal.caps_changed",
  "approval.rejected",
];

/** The manager of one task: the department's lead, or Peter when the lead is the assignee. */
async function actorFor(
  deps: PeterDeps,
  companyId: string,
  task: { department_id: string | null; assignee_id: string | null },
): Promise<Manager | null> {
  return managerForTask(deps.db, companyId, task);
}

/** The teammate a note is written for: name, role, engine and model. */
async function teammateOf(
  deps: PeterDeps,
  task: { assignee_kind: string | null; assignee_id: string | null },
): Promise<FailureContext["teammate"]> {
  if (task.assignee_kind !== "teammate" || !task.assignee_id) return null;
  return (
    (
      await deps.db.query<{ name: string; role: string; engine: string; model: string }>(
        "SELECT name, role, engine, model FROM teammates WHERE id = $1",
        [task.assignee_id],
      )
    ).rows[0] ?? null
  );
}

async function goalOf(deps: PeterDeps, goalId: string | null): Promise<GoalRow | null> {
  if (!goalId) return null;
  return (await deps.db.query<GoalRow>("SELECT * FROM goals WHERE id = $1", [goalId])).rows[0] ?? null;
}

// --- 1. Goals waiting to be planned (a restart mid-plan) ---------------------

async function planWaiting(deps: PeterDeps, companyId: string, out: PassResult): Promise<void> {
  const rows = await deps.db.query<{ id: string }>(
    "SELECT id FROM goals WHERE company_id = $1 AND status = 'planning' ORDER BY created_at",
    [companyId],
  );
  for (const g of rows.rows) {
    try {
      await planGoal(deps, g.id);
      out.planned.push(g.id);
    } catch (err) {
      deps.log?.warn(`Peter could not plan goal ${g.id}: ${(err as Error).message}`);
    }
  }
}

// --- 3. Failed runs: re-plan, then escalate ----------------------------------

async function decideReplan(
  deps: PeterDeps,
  manager: Manager,
  ctx: FailureContext,
  goal: GoalRow | null,
  subject: { companyId: string; taskId: string },
): Promise<Replan> {
  if (!(await modelAvailable(deps.model, subject.companyId))) return heuristicReplan(ctx);
  try {
    const result = await deps.model.complete({
      model: replanModel(ctx, manager.model),
      effort: manager.effort,
      system: replanSystemPrompt(),
      user: replanUserPrompt(ctx),
      schema: ReplanSchema,
      maxTokens: 2000,
      trace: {
        purpose: "replan",
        companyId: subject.companyId,
        goalId: goal?.id ?? null,
        taskId: subject.taskId,
      },
    });
    if (goal) {
      await deps.db.query("UPDATE goals SET planning_usage = $2, updated_at = now() WHERE id = $1", [
        goal.id,
        JSON.stringify(addUsage(goal.planning_usage, result.usage)),
      ]);
    }
    if (result.output) return result.output;
  } catch (err) {
    deps.log?.warn(`Peter's re-plan call failed for #${ctx.taskNumber}: ${(err as Error).message}`);
  }
  return heuristicReplan(ctx);
}

async function replanFailures(deps: PeterDeps, companyId: string, out: PassResult): Promise<void> {
  // Teammate tasks blocked by a run (not waiting on a teammate, a dependency or an approval), with no live run.
  const failed = await deps.db.query<TaskRow>(
    `${TASK_SELECT} WHERE t.company_id = $1 AND t.status = 'blocked' AND t.assignee_kind = 'teammate'
       AND t.blocker->>'code' NOT IN ('dependencies_unresolved', 'waiting_on_teammate', 'approval_required')
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'interrupted'))
       AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.kind = 'task' AND r.status IN ('failed', 'blocked'))
       AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.id = t.goal_id AND g.status IN ('stopped', 'done'))
     ORDER BY t.updated_at LIMIT 20`,
    [companyId],
  );
  for (const task of failed.rows) {
    if (!task.blocker || blockerKind(task.blocker.code) !== "run") continue;
    const last = (
      await deps.db.query<RunRow>(
        "SELECT * FROM runs WHERE task_id = $1 AND kind = 'task' ORDER BY created_at DESC LIMIT 1",
        [task.id],
      )
    ).rows[0];
    if (!last) continue;
    const handover = await artifactText(
      deps.store ?? null,
      (
        await deps.db.query<{ content: string | null; object_key: string | null }>(
          "SELECT content, object_key FROM artifacts WHERE run_id = $1 AND (kind = 'handover' OR path = 'blocked.md') ORDER BY kind LIMIT 1",
          [last.id],
        )
      ).rows[0] ?? null,
    );
    await replanTask(deps, companyId, task, out, {
      taskNumber: task.number,
      taskTitle: task.title,
      brief: task.description,
      attemptsSoFar: task.replans + 1,
      error: last.error ?? task.blocker.what,
      summary: last.summary,
      handover,
      blockerCode: task.blocker.code,
      teammate: await teammateOf(deps, task),
    });
  }
}

// --- 3b. Rejected proposals: the write a person said no to is re-planned ---

async function replanRejections(deps: PeterDeps, companyId: string, out: PassResult): Promise<void> {
  // Teammate tasks parked on an approval, with nothing pending any more and the latest decision a rejection.
  const rejected = await deps.db.query<
    TaskRow & { a_title: string; a_connection: string; a_tool: string; a_note: string | null }
  >(
    `${TASK_SELECT.replace("SELECT t.*,", "SELECT t.*, a.title AS a_title, a.connection AS a_connection, a.tool AS a_tool, a.note AS a_note,")}
     JOIN LATERAL (SELECT * FROM approvals x WHERE x.task_id = t.id ORDER BY x.updated_at DESC LIMIT 1) a ON true
     WHERE t.company_id = $1 AND t.status = 'blocked' AND t.assignee_kind = 'teammate'
       AND t.blocker->>'code' = 'approval_required' AND a.status = 'rejected'
       AND NOT EXISTS (SELECT 1 FROM approvals p WHERE p.task_id = t.id AND p.status = 'pending')
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'interrupted'))
       AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.id = t.goal_id AND g.status IN ('stopped', 'done'))
     ORDER BY t.updated_at LIMIT 20`,
    [companyId],
  );
  for (const task of rejected.rows) {
    await replanTask(deps, companyId, task, out, {
      taskNumber: task.number,
      taskTitle: task.title,
      brief: task.description,
      attemptsSoFar: task.replans + 1,
      error: `The proposed write "${task.a_title}" (${task.a_connection} · ${task.a_tool}) was rejected${task.a_note ? `: ${task.a_note}` : ""}`,
      summary: null,
      handover: null,
      blockerCode: "approval_required",
      teammate: await teammateOf(deps, task),
    });
  }
}

/** Re-plan one blocked task: a note from the manager, the count bumped, the assignee started again; or escalate. */
async function replanTask(
  deps: PeterDeps,
  companyId: string,
  task: TaskRow,
  out: PassResult,
  ctx: FailureContext,
): Promise<void> {
  const manager = await actorFor(deps, companyId, task);
  if (!manager) return;
  const goal = await goalOf(deps, task.goal_id);
  const actor: ActorRef = { kind: "teammate", id: manager.id };
  if (task.replans >= MAX_REPLANS) {
    await escalateTask(
      deps,
      companyId,
      manager,
      goal,
      task,
      `#${task.number} ${task.title} failed ${task.replans + 1} times; the last error: ${ctx.error ?? "none"}. It stays blocked until you look.`,
      out,
    );
    return;
  }
  const decision = await decideReplan(deps, manager, ctx, goal, { companyId, taskId: task.id });
  if (decision.needsPerson) {
    await escalateTask(
      deps,
      companyId,
      manager,
      goal,
      task,
      decision.reason || `#${task.number} needs you: ${ctx.error ?? "the run failed"}`,
      out,
    );
    return;
  }
  // Record the re-plan on the task, then start the assignee again with the note in the pack.
  const replans = task.replans + 1;
  await mutate(deps.db, companyId, actor, async (mctx) => {
    await mctx.client.query("UPDATE tasks SET replans = $2, updated_at = now() WHERE id = $1", [
      task.id,
      replans,
    ]);
    await mctx.emit(
      "task.replanned",
      { kind: "task", id: task.id },
      {
        number: task.number,
        title: task.title,
        replans,
        error: ctx.error,
        note: decision.note,
        managerName: manager.name,
        teammateId: task.assignee_id,
      },
    );
  });
  await postMessage(
    deps.db,
    companyId,
    actor,
    task.id,
    `Re-planned after attempt ${task.replans + 1}: ${decision.note}`,
  );
  try {
    const run = await dispatchRun(deps.db, deps.queue, companyId, actor, task.id, {
      note: `Re-planned by ${manager.name} after ${ctx.blockerCode === "approval_required" ? "a rejected proposal" : "a failed run"}. ${decision.note}`,
    });
    out.replanned.push({ taskId: task.id, runId: run.id, replans });
  } catch (err) {
    // Budget spent or engine off: escalate rather than wait silently.
    const why = err instanceof HttpError ? err.message : String(err);
    await escalateTask(
      deps,
      companyId,
      manager,
      goal,
      task,
      `#${task.number} cannot be restarted: ${why}`,
      out,
    );
  }
}

async function escalateTask(
  deps: PeterDeps,
  companyId: string,
  manager: Manager,
  goal: GoalRow | null,
  task: TaskRow,
  reason: string,
  out: PassResult,
): Promise<void> {
  if (goal) {
    if (goal.status === "needs_you" && goal.attention === reason) return;
    await escalateGoal(deps, goal, manager, reason);
    out.escalated.push({ goalId: goal.id, reason });
    return;
  }
  // No goal to turn amber: say so on the task, once per re-plan count.
  const said = await deps.db.query(
    "SELECT 1 FROM messages WHERE task_id = $1 AND author_kind = 'teammate' AND author_id = $2 AND body LIKE 'Needs a person:%' AND created_at > now() - interval '6 hours'",
    [task.id, manager.id],
  );
  if (said.rowCount) return;
  await postMessage(
    deps.db,
    companyId,
    { kind: "teammate", id: manager.id },
    task.id,
    `Needs a person: ${reason}`,
  );
  out.escalated.push({ goalId: "", reason });
}

// --- 4. Reviews sent back: restart the author; too many rounds: escalate ---

async function tendReviews(deps: PeterDeps, companyId: string, out: PassResult): Promise<void> {
  const sentBack = await deps.db.query<{
    id: string;
    task_id: string;
    round: number;
    reviewer_name: string | null;
    task_status: string;
    department_id: string | null;
    assignee_id: string | null;
    goal_id: string | null;
    number: number;
    title: string;
    live: number;
    restarted: boolean;
  }>(
    `SELECT r.id, r.task_id, r.round, rt.name AS reviewer_name, t.status AS task_status, t.department_id, t.assignee_id, t.goal_id, t.number, t.title,
       (SELECT count(*)::int FROM runs x WHERE x.task_id = t.id AND x.status IN ('queued', 'running', 'interrupted')) AS live,
       EXISTS (SELECT 1 FROM runs x WHERE x.task_id = t.id AND x.kind = 'task'
               AND x.created_at >= COALESCE(r.decided_at, r.updated_at)) AS restarted
     FROM reviews r JOIN tasks t ON t.id = r.task_id
     LEFT JOIN teammates rt ON r.reviewer_kind = 'teammate' AND rt.id = r.reviewer_id
     WHERE r.company_id = $1 AND r.status = 'changes_requested' AND t.assignee_kind = 'teammate' AND t.status NOT IN ('done', 'cancelled')`,
    [companyId],
  );
  for (const r of sentBack.rows) {
    const manager = await actorFor(deps, companyId, r);
    if (!manager) continue;
    const goal = await goalOf(deps, r.goal_id);
    if (goal && (goal.status === "stopped" || goal.status === "done")) continue;
    // Someone is on it: the author restarted, or a person asked for another round.
    if (r.live > 0 || r.task_status === "doing") continue;
    if (r.round >= MAX_REVIEW_ROUNDS) {
      const reason = `The review of #${r.number} ${r.title} has gone ${r.round} rounds without approval. Decide it yourself or reassign the task.`;
      if (goal) {
        if (goal.status === "needs_you" && goal.attention === reason) continue;
        await escalateGoal(deps, goal, manager, reason);
        out.escalated.push({ goalId: goal.id, reason });
      }
      continue;
    }
    // The author's restart failed at decision time (engine off, budget); try again now. Only then: once
    // the author has been started on this round, what became of that run is replanFailures' to handle.
    // Restarting after every failed run went round forever (seen on a live board, a run every few seconds).
    if (r.restarted) continue;
    try {
      const run = await dispatchRun(
        deps.db,
        deps.queue,
        companyId,
        { kind: "teammate", id: manager.id },
        r.task_id,
        {
          note: `${r.reviewer_name ?? "The reviewer"} requested changes in review round ${r.round}; address the comments in your pack.`,
        },
      );
      out.restarted.push({ taskId: r.task_id, runId: run.id });
    } catch {
      // Still cannot start: the next pass tries again; a budget blocker escalates through replanFailures once the task is blocked.
    }
  }
}

// --- 6. Load: a teammate with too many open tasks hands some to a colleague --

async function rebalance(deps: PeterDeps, companyId: string, out: PassResult): Promise<void> {
  const loads = await deps.db.query<{ id: string; name: string; role: string; load: number }>(
    `SELECT t.id, t.name, t.role,
       (SELECT count(*)::int FROM tasks k WHERE k.assignee_kind = 'teammate' AND k.assignee_id = t.id AND k.status NOT IN ('done', 'cancelled')) AS load
     FROM teammates t WHERE t.company_id = $1`,
    [companyId],
  );
  const busy = loads.rows.filter((m) => m.load > REBALANCE_ABOVE);
  for (const from of busy) {
    const peers = loads.rows
      .filter(
        (m) => m.id !== from.id && m.role.toLowerCase() === from.role.toLowerCase() && m.load < from.load - 1,
      )
      .sort((a, b) => a.load - b.load);
    const to = peers[0];
    if (!to) continue;
    // Move the newest task Peter created that has not started.
    const task = (
      await deps.db.query<TaskRow>(
        `${TASK_SELECT} WHERE t.company_id = $1 AND t.assignee_kind = 'teammate' AND t.assignee_id = $2 AND t.status = 'todo'
           AND t.created_by_kind = 'teammate' AND t.active_run_id IS NULL ORDER BY t.created_at DESC LIMIT 1`,
        [companyId, from.id],
      )
    ).rows[0];
    if (!task) continue;
    const manager = await actorFor(deps, companyId, task);
    if (!manager) continue;
    await mutate(deps.db, companyId, { kind: "teammate", id: manager.id }, async (ctx) => {
      await ctx.client.query("UPDATE tasks SET assignee_id = $2, updated_at = now() WHERE id = $1", [
        task.id,
        to.id,
      ]);
      await ctx.emit(
        "task.assigned",
        { kind: "task", id: task.id },
        {
          number: task.number,
          title: task.title,
          assignee: { kind: "teammate", id: to.id, name: to.name },
          from: { kind: "teammate", id: from.id, name: from.name },
          reason: `${from.name} has ${from.load} open tasks`,
        },
      );
    });
    out.rebalanced.push({ taskId: task.id, from: from.id, to: to.id });
    to.load += 1;
    from.load -= 1;
  }
}

// --- 7. Goals whose every task is Done (or cancelled) ---------------------------------------

async function closeGoals(deps: PeterDeps, companyId: string, out: PassResult): Promise<void> {
  const done = await deps.db.query<GoalRow>(
    `SELECT g.* FROM goals g WHERE g.company_id = $1 AND g.status = 'active'
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.status = 'done')
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.status NOT IN ('done', 'cancelled'))`,
    [companyId],
  );
  for (const goal of done.rows) {
    const manager = await managerFor(deps.db, companyId, goal.department_id);
    if (!manager) continue;
    const spend = await goalSpend(deps.db, goal);
    await mutate(deps.db, companyId, { kind: "teammate", id: manager.id }, async (ctx) => {
      await ctx.client.query(
        "UPDATE goals SET status = 'done', attention = NULL, closed_at = now(), updated_at = now() WHERE id = $1",
        [goal.id],
      );
      await ctx.emit(
        "goal.done",
        { kind: "goal", id: goal.id },
        { title: goal.title, projectId: goal.project_id, managerName: manager.name, spend },
      );
    });
    out.closed.push(goal.id);
  }
}

// --- 4b. Escalated goals a person has dealt with carry on ---------------------

/**
 * An escalated goal starts nothing while it waits for a person. Once nothing in
 * it is still what Peter escalated (a task blocked by its runs or by a write
 * that is no longer pending, with nothing running; a review sent back past the
 * round cap with nobody working on it) and no question is open, it is active
 * again and its ready tasks start in the same pass.
 */
async function resumeGoals(deps: PeterDeps, companyId: string, out: PassResult): Promise<void> {
  const live =
    "SELECT 1 FROM runs x WHERE x.task_id = t.id AND x.status IN ('queued', 'running', 'interrupted')";
  const rows = await deps.db.query<GoalRow>(
    `SELECT g.* FROM goals g WHERE g.company_id = $1 AND g.status = 'needs_you'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(g.questions, '[]'::jsonb)) q WHERE q->>'answer' IS NULL)
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id)
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.status = 'blocked'
         AND t.blocker->>'code' NOT IN ('dependencies_unresolved', 'waiting_on_teammate')
         AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.status = 'pending')
         AND NOT EXISTS (${live}))
       AND NOT EXISTS (SELECT 1 FROM reviews r JOIN tasks t ON t.id = r.task_id
         WHERE t.goal_id = g.id AND r.status = 'changes_requested' AND r.round >= $2
           AND t.status NOT IN ('done', 'doing') AND NOT EXISTS (${live}))`,
    [companyId, MAX_REVIEW_ROUNDS],
  );
  for (const goal of rows.rows) {
    const manager = await managerFor(deps.db, companyId, goal.department_id);
    if (!manager) continue;
    await mutate(deps.db, companyId, { kind: "teammate", id: manager.id }, async (ctx) => {
      const resumed = await ctx.client.query(
        "UPDATE goals SET status = 'active', attention = NULL, updated_at = now() WHERE id = $1 AND status = 'needs_you'",
        [goal.id],
      );
      if (!resumed.rowCount) return;
      await ctx.emit(
        "goal.resumed",
        { kind: "goal", id: goal.id },
        { title: goal.title, projectId: goal.project_id, managerName: manager.name, was: goal.attention },
      );
    });
    out.resumed.push(goal.id);
  }
}

/** One pass over one company. Every step is safe to repeat; two replicas passing at once do no harm. */
export async function peterPass(
  deps: PeterDeps,
  companyId: string,
  opts: { chase?: Partial<ChaseOptions> } = {},
): Promise<PassResult> {
  const out: PassResult = {
    companyId,
    planned: [],
    started: [],
    replanned: [],
    restarted: [],
    escalated: [],
    resumed: [],
    chased: 0,
    rebalanced: [],
    closed: [],
  };
  if (!(await managerFor(deps.db, companyId, null))) return out;
  await planWaiting(deps, companyId, out);
  await replanFailures(deps, companyId, out);
  await replanRejections(deps, companyId, out);
  await tendReviews(deps, companyId, out);
  await resumeGoals(deps, companyId, out);
  await rebalance(deps, companyId, out);
  out.started = await startReadyTasks(deps, companyId, null);
  out.chased = (await chasePass(deps.db, deps.queue, { ...opts.chase, companyId })).chased.length;
  await closeGoals(deps, companyId, out);
  return out;
}

/** Every company with a project manager. */
export async function companiesToTend(deps: PeterDeps): Promise<string[]> {
  const res = await deps.db.query<{ company_id: string }>(
    "SELECT DISTINCT company_id FROM teammates WHERE handle = 'peter' OR role ILIKE '%project manager%'",
  );
  return res.rows.map((r) => r.company_id);
}

export interface PeterLoop {
  /** Run a pass now for one company (or every company), serialised per company. */
  wake(companyId?: string): Promise<void>;
  stop(): void;
}

/**
 * The loop: a pass per company on a timer, and a pass for a company soon
 * after one of its wake events lands. Passes for one company never overlap;
 * a wake during a pass queues one more.
 */
export function startPeterLoop(
  deps: PeterDeps,
  bus: EventBus,
  intervalMs: number,
  log: { warn(m: string): void },
  opts: { chase?: Partial<ChaseOptions>; debounceMs?: number } = {},
): PeterLoop {
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  const passFor = (companyId: string): Promise<void> => {
    const current = running.get(companyId);
    if (current) {
      again.add(companyId);
      return current;
    }
    const p = (async () => {
      try {
        await peterPass(deps, companyId, { chase: opts.chase });
      } catch (err) {
        log.warn(`Peter's pass over ${companyId} failed: ${(err as Error).message}`);
      } finally {
        running.delete(companyId);
        if (again.delete(companyId) && !stopped) void passFor(companyId);
      }
    })();
    running.set(companyId, p);
    return p;
  };

  const schedule = (companyId: string) => {
    if (stopped) return;
    const existing = timers.get(companyId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(companyId);
      void passFor(companyId);
    }, opts.debounceMs ?? 300);
    t.unref();
    timers.set(companyId, t);
  };

  const unsubscribe = bus.fanout.subscribe((ev: EventRecord) => {
    if (PETER_WAKE_EVENTS.includes(ev.type)) schedule(ev.companyId);
  });

  const timer =
    intervalMs > 0
      ? setInterval(() => {
          void companiesToTend(deps)
            .then((ids) => Promise.all(ids.map((id) => passFor(id))))
            .catch((err) => log.warn(`Peter's timer pass failed: ${String(err)}`));
        }, intervalMs)
      : null;
  timer?.unref();

  return {
    async wake(companyId) {
      const ids = companyId ? [companyId] : await companiesToTend(deps);
      await Promise.all(ids.map((id) => passFor(id)));
    },
    stop() {
      stopped = true;
      unsubscribe();
      if (timer) clearInterval(timer);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
