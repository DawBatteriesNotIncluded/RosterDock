// What happens after a message lands or a teammate files a task. Mentions
// become turns for the named teammate; a reply from the teammate a task is
// waiting on restarts the assignee; a task a teammate files for a teammate
// starts on its own. The filters keep two teammates from waking each other
// forever: a bounded reply chain and a per-task hourly cap.

import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import type { RunQueue } from "../queue.js";
import { loadTask, moveTask, type MessageRow, type TaskRow } from "../tasks/service.js";
import { dispatchRun, dispatchTurn, liveRunFor } from "./service.js";

/** At most this many turns per task per hour, whoever asks. */
export const TURNS_PER_TASK_PER_HOUR = 6;
/** question → answer → follow-up → answer, then the chain stops. */
export const MAX_REPLY_DEPTH = 3;
/** An answer restarts a blocked assignee at most this often; after that the task waits for a person. */
export const RESTARTS_PER_TASK_PER_HOUR = 2;

export interface RoutingOutcome {
  turns: { teammateId: string; runId: string }[];
  /** The task was waiting on the author; the assignee was started again. */
  restartedRunId: string | null;
  skipped: { teammateId: string; reason: string }[];
}

async function turnsInLastHour(db: Db, taskId: string): Promise<number> {
  const res = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM runs WHERE task_id = $1 AND kind = 'turn' AND created_at > now() - interval '1 hour'",
    [taskId],
  );
  return res.rows[0]?.n ?? 0;
}

async function restartsInLastHour(db: Db, taskId: string): Promise<number> {
  const res = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM runs WHERE task_id = $1 AND kind = 'task' AND trigger_message_id IS NOT NULL AND created_at > now() - interval '1 hour'",
    [taskId],
  );
  return res.rows[0]?.n ?? 0;
}

/**
 * How many turns deep this message is: a message written in a turn that was
 * triggered by a message written in a turn... Stops at the first message not
 * written in a turn.
 */
export async function replyDepth(db: Db, message: Pick<MessageRow, "run_id">): Promise<number> {
  let depth = 0;
  let runId = message.run_id;
  while (runId && depth <= MAX_REPLY_DEPTH) {
    const res = await db.query<{ run_id: string | null }>(
      `SELECT m.run_id FROM runs r LEFT JOIN messages m ON m.id = r.trigger_message_id WHERE r.id = $1 AND r.kind = 'turn'`,
      [runId],
    );
    if (!res.rows[0]) break;
    depth += 1;
    runId = res.rows[0].run_id;
  }
  return depth;
}

/** Route a message that was just posted: turns for mentions, restart when a wait is answered. */
export async function routeMessage(db: Db, queue: RunQueue, message: MessageRow): Promise<RoutingOutcome> {
  const out: RoutingOutcome = { turns: [], restartedRunId: null, skipped: [] };
  const task = await loadTask(db, message.company_id, message.task_id);
  if (task.status === "done" || task.status === "cancelled") return out;

  // 1. The teammate the task is waiting on answered: the assignee continues.
  const waitingOn =
    task.status === "blocked" && task.blocker?.waitingOn?.kind === "teammate" ? task.blocker.waitingOn : null;
  if (waitingOn && message.author_kind === "teammate") {
    const author = (
      await db.query<{ id: string; handle: string }>("SELECT id, handle FROM teammates WHERE id = $1", [
        message.author_id,
      ])
    ).rows[0];
    const answered = author && (author.id === waitingOn.id || author.handle === waitingOn.name);
    if (answered) {
      if (task.assignee_kind === "teammate" && task.assignee_id && task.assignee_id !== author.id) {
        // Two teammates who both lack an answer would restart each other forever; after the cap the task stays blocked for a person.
        const restarts = await restartsInLastHour(db, task.id);
        if (restarts >= RESTARTS_PER_TASK_PER_HOUR) {
          out.skipped.push({
            teammateId: task.assignee_id,
            reason: `#${task.number} was restarted ${restarts} times this hour; it stays blocked until a person weighs in`,
          });
        } else {
          try {
            const run = await dispatchRun(
              db,
              queue,
              message.company_id,
              { kind: "teammate", id: author.id },
              task.id,
              {
                note: `@${author.handle} answered on the task; continue from the conversation.`,
                triggerMessageId: message.id,
              },
            );
            out.restartedRunId = run.id;
          } catch (err) {
            // The assignee is still live (the answer is in their conversation), or the run cannot start; the task keeps its blocker.
            out.skipped.push({
              teammateId: task.assignee_id,
              reason: err instanceof HttpError ? err.message : String(err),
            });
          }
        }
      } else {
        await moveTask(db, message.company_id, { kind: "teammate", id: author.id }, task.id, {
          status: "todo",
        });
      }
    }
  }

  // 2. Mentions become turns.
  if (!message.mentions.length) return out;
  const depth = await replyDepth(db, message);
  let turns = await turnsInLastHour(db, task.id);
  for (const m of message.mentions) {
    if (message.author_kind === "teammate" && m.id === message.author_id) continue;
    if (depth >= MAX_REPLY_DEPTH) {
      out.skipped.push({
        teammateId: m.id,
        reason: `reply chain on #${task.number} is ${depth} deep; a person can pick it up`,
      });
      continue;
    }
    if (turns >= TURNS_PER_TASK_PER_HOUR) {
      out.skipped.push({
        teammateId: m.id,
        reason: `#${task.number} had ${TURNS_PER_TASK_PER_HOUR} turns this hour`,
      });
      continue;
    }
    // The assignee works the task through runs, never turns: a restart carried the message, or a person starts one.
    if (task.assignee_kind === "teammate" && m.id === task.assignee_id) {
      out.skipped.push({
        teammateId: m.id,
        reason: out.restartedRunId
          ? "the assignee was restarted with this message in the conversation"
          : "the assignee; the message waits in the conversation for their next run",
      });
      continue;
    }
    if (await liveRunFor(db, task.id, m.id)) {
      out.skipped.push({
        teammateId: m.id,
        reason: "already live on this task; the message is in their conversation",
      });
      continue;
    }
    try {
      const run = await dispatchTurn(db, queue, message.company_id, m.id, task.id, message);
      out.turns.push({ teammateId: m.id, runId: run.id });
      turns += 1;
    } catch (err) {
      out.skipped.push({ teammateId: m.id, reason: err instanceof HttpError ? err.message : String(err) });
    }
  }
  return out;
}

/** A task a teammate filed for a teammate starts on its own (autonomy by default). */
export async function autoDispatchCreated(
  db: Db,
  queue: RunQueue,
  task: TaskRow,
  creatorTeammateId: string,
): Promise<string | null> {
  if (task.assignee_kind !== "teammate" || !task.assignee_id) return null;
  try {
    const run = await dispatchRun(
      db,
      queue,
      task.company_id,
      { kind: "teammate", id: creatorTeammateId },
      task.id,
      {
        note: "Filed by a teammate and started automatically.",
      },
    );
    return run.id;
  } catch {
    // Dependencies not done, budget spent, engine off: the task waits on the board.
    return null;
  }
}
