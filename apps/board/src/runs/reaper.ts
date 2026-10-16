// Recovery sweep. pg-boss decides whether a job is alive (heartbeat, expiry,
// retries); this pass maps that back onto run rows so nothing stays
// "running" forever and a dead worker's task lands in Blocked with a reason.
// Every step is idempotent, so overlapping passes from two replicas are safe.

import { blockerFor } from "@rosterdock/shared";
import type { Db } from "../db/pool.js";
import { mutate } from "../mutate.js";
import type { RunQueue } from "../queue.js";
import { completeRun, enqueue, type RunRow } from "./service.js";

export interface ReaperOptions {
  /** A running run without a heartbeat for this long is interrupted. */
  staleAfterMs: number;
  /** A queued run without a job id for this long is enqueued again. */
  orphanAfterMs: number;
}

export const DEFAULT_REAPER_OPTIONS: ReaperOptions = { staleAfterMs: 90_000, orphanAfterMs: 30_000 };

export interface ReaperResult {
  interrupted: string[];
  failed: string[];
  requeued: string[];
}

export async function reaperPass(
  db: Db,
  queue: RunQueue,
  opts: ReaperOptions = DEFAULT_REAPER_OPTIONS,
): Promise<ReaperResult> {
  const out: ReaperResult = { interrupted: [], failed: [], requeued: [] };

  // 1. Running runs whose worker stopped heartbeating.
  const stale = await db.query<RunRow>(
    `UPDATE runs SET status = 'interrupted', updated_at = now()
     WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval RETURNING *`,
    [String(opts.staleAfterMs)],
  );
  for (const run of stale.rows) {
    out.interrupted.push(run.id);
    await mutate(db, run.company_id, { kind: "teammate", id: run.teammate_id }, async (ctx) => {
      await ctx.emit(
        "run.interrupted",
        { kind: "run", id: run.id },
        {
          taskId: run.task_id,
          attempt: run.attempt,
          workerId: run.worker_id,
          lastHeartbeatAt: run.heartbeat_at?.toISOString() ?? null,
        },
      );
    });
  }

  // 2. Queued or interrupted runs: reconcile with the job.
  const pending = await db.query<RunRow>(
    "SELECT * FROM runs WHERE status IN ('queued', 'interrupted') ORDER BY queued_at",
  );
  for (const run of pending.rows) {
    if (!run.job_id) {
      if (Date.now() - run.queued_at.getTime() > opts.orphanAfterMs) {
        await enqueue(db, queue, run);
        out.requeued.push(run.id);
      }
      continue;
    }
    const state = await queue.jobState(run.job_id, run.queue_name);
    if (state === "failed" || state === "cancelled" || state === "completed" || state === null) {
      // The job will not run again. Either retries are exhausted, someone
      // cancelled it, or a worker finished the job without reporting.
      const reason =
        state === "failed"
          ? "The worker stopped and every retry was used."
          : state === "cancelled"
            ? "The run's job was cancelled."
            : "The worker finished without reporting a result.";
      await completeRun(
        db,
        run.id,
        {
          status: "failed",
          error: reason,
          blocker: { code: state === "failed" ? "retries_exhausted" : "worker_reported", what: reason },
        },
        { kind: "teammate", id: run.teammate_id },
      );
      out.failed.push(run.id);
    }
    // created, retry, active: a worker will (re)claim it; resume from the checkpoint.
  }
  return out;
}

export function startReaper(
  db: Db,
  queue: RunQueue,
  intervalMs: number,
  log: { warn: (m: string) => void },
  opts?: ReaperOptions,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void reaperPass(db, queue, opts).catch((err) => log.warn(`reaper pass failed: ${String(err)}`));
  }, intervalMs);
  timer.unref();
  return timer;
}

export { blockerFor };
