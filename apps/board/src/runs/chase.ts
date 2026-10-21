// Chasing, one step of Peter's loop (M4; a timer of its own in M2): tasks
// that have waited on a teammate too long get a nudge on the task, which
// gives that teammate a turn. One nudge per wait, spoken by the manager of the
// task's department (its lead) or the company Peter. A wait still unanswered
// a window after its nudge goes to a person (escalateWaits in Peter's loop).

import type { Db } from "../db/pool.js";
import { mutate } from "../mutate.js";
import { managerForTask } from "../peter/seat.js";
import type { RunQueue } from "../queue.js";
import { postMessage, type TaskRow } from "../tasks/service.js";
import { teammateNamed } from "../tasks/waiting.js";
import { routeMessage } from "./routing.js";

export interface ChaseOptions {
  /**
   * A task blocked on a teammate for longer than this gets a nudge; still unanswered this long after the
   * nudge (or at once past it, when nobody can be nudged), it goes to a person.
   */
  blockedForMs: number;
  /** Only this company's tasks; every company otherwise. */
  companyId?: string;
}

export const DEFAULT_CHASE_OPTIONS: ChaseOptions = { blockedForMs: 10 * 60_000 };

export interface ChaseResult {
  chased: { taskId: string; teammateId: string; runId: string | null }[];
}

export async function chasePass(
  db: Db,
  queue: RunQueue,
  opts: Partial<ChaseOptions> = {},
): Promise<ChaseResult> {
  const o = { ...DEFAULT_CHASE_OPTIONS, ...opts };
  const out: ChaseResult = { chased: [] };
  // Once per wait: a chase that is older than the blocker was for an earlier wait.
  const stale = await db.query<TaskRow>(
    `SELECT * FROM tasks
     WHERE status = 'blocked' AND blocker->>'code' = 'waiting_on_teammate'
       AND blocker->'waitingOn'->>'kind' = 'teammate'
       AND ($2::uuid IS NULL OR company_id = $2)
       AND updated_at < now() - ($1 || ' milliseconds')::interval
       AND (last_chased_at IS NULL OR last_chased_at < updated_at)
     ORDER BY updated_at LIMIT 50`,
    [String(o.blockedForMs), o.companyId ?? null],
  );
  for (const task of stale.rows) {
    const waiting = task.blocker?.waitingOn;
    if (!waiting) continue;
    const manager = await managerForTask(db, task.company_id, task);
    if (!manager) continue;
    // Nobody to nudge (no such teammate, or the manager himself): escalateWaits tells a person instead.
    const target = await teammateNamed(db, task.company_id, waiting);
    if (!target || target.id === manager.id) continue;
    await mutate(db, task.company_id, { kind: "teammate", id: manager.id }, async (ctx) => {
      await ctx.client.query("UPDATE tasks SET last_chased_at = now() WHERE id = $1", [task.id]);
      await ctx.emit(
        "task.chased",
        { kind: "task", id: task.id },
        { number: task.number, title: task.title, teammateId: target.id, teammateName: target.name },
      );
    });
    const message = await postMessage(
      db,
      task.company_id,
      { kind: "teammate", id: manager.id },
      task.id,
      `@${target.handle} #${task.number} is waiting on you: ${task.blocker?.what ?? "please answer on this task"}`,
    );
    const routed = await routeMessage(db, queue, message);
    out.chased.push({ taskId: task.id, teammateId: target.id, runId: routed.turns[0]?.runId ?? null });
  }
  return out;
}
