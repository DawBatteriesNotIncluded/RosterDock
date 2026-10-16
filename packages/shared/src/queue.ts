// The runs queue and its pools. Every run goes on a pg-boss queue: `runs` by
// default, or `runs.<pool>` when the task's department names a worker pool in
// its sandbox. A pool is a worker fleet the operator runs separately (the
// chart's worker.pools) with its own network policy, so a department that may
// reach only the git host, or nothing at all, gets workers that cannot reach
// anything else. The board and the worker agree on these names and settings.

export const RUNS_QUEUE = "runs";

/** A pool name: a short slug, the same shape as a department slug. */
export const POOL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function queueNameForPool(pool: string | null | undefined): string {
  if (!pool) return RUNS_QUEUE;
  if (!POOL_RE.test(pool)) throw new Error(`not a pool name: ${pool}`);
  return `${RUNS_QUEUE}.${pool}`;
}

/** The pool a queue name belongs to; null for the default queue. */
export function poolForQueue(queueName: string): string | null {
  if (queueName === RUNS_QUEUE) return null;
  const prefix = `${RUNS_QUEUE}.`;
  return queueName.startsWith(prefix) ? queueName.slice(prefix.length) : null;
}

// pg-boss notices a dead worker after heartbeatSeconds without a job heartbeat
// and retries with a delay that exceeds the board's stale window (60 s by
// default), so the retried job finds a run the board is willing to hand over.
export const RUN_QUEUE_SETTINGS = {
  heartbeatSeconds: 30,
  retryLimit: 5,
  retryBackoff: true,
  retryDelay: 60,
  retryDelayMax: 600,
  expireInSeconds: 6 * 3600,
} as const;
