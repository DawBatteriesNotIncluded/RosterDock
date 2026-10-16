// The run queue on pg-boss. The board enqueues and inspects; workers consume.
// pg-boss owns job liveness (heartbeat, expiry, retries); the reaper maps job
// state back onto run rows. One queue by default (`runs`) and one per worker
// pool (`runs.<pool>`), created here the first time a run needs it.

import { PgBoss } from "pg-boss";
import { RUN_QUEUE_SETTINGS, RUNS_QUEUE } from "@rosterdock/shared";

export { RUNS_QUEUE };
export const RUN_HEARTBEAT_SECONDS = RUN_QUEUE_SETTINGS.heartbeatSeconds;
export const RUN_RETRY_LIMIT = RUN_QUEUE_SETTINGS.retryLimit;
export const RUN_RETRY_DELAY_SECONDS = RUN_QUEUE_SETTINGS.retryDelay;
export const RUN_RETRY_DELAY_MAX_SECONDS = RUN_QUEUE_SETTINGS.retryDelayMax;
export const RUN_EXPIRE_SECONDS = RUN_QUEUE_SETTINGS.expireInSeconds;

export interface RunJob {
  runId: string;
  companyId: string;
}

export type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed";

export interface RunQueue {
  boss: PgBoss;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Create the queue with the runs settings when it does not exist yet. */
  ensureQueue(name: string): Promise<void>;
  enqueueRun(job: RunJob, queueName?: string): Promise<string>;
  jobState(jobId: string, queueName?: string): Promise<JobState | null>;
  cancel(jobId: string, queueName?: string): Promise<void>;
}

export function createRunQueue(
  connectionString: string,
  log: { warn: (m: string) => void },
  opts: { max?: number } = {},
): RunQueue {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    supervise: true,
    migrate: true,
    max: opts.max ?? 10,
  });
  boss.on("error", (err) => log.warn(`pg-boss: ${err.message}`));
  const known = new Set<string>();
  const settings = { ...RUN_QUEUE_SETTINGS };
  const ensureQueue = async (name: string) => {
    if (known.has(name)) return;
    const existing = await boss.getQueue(name);
    if (!existing) await boss.createQueue(name, settings);
    else await boss.updateQueue(name, settings);
    known.add(name);
  };
  return {
    boss,
    async start() {
      await boss.start();
      await ensureQueue(RUNS_QUEUE);
    },
    async stop() {
      await boss.stop({ graceful: false, close: true, timeout: 2000 });
    },
    ensureQueue,
    async enqueueRun(job, queueName = RUNS_QUEUE) {
      await ensureQueue(queueName);
      const id = await boss.send(queueName, job);
      if (!id) throw new Error("pg-boss did not accept the run job");
      return id;
    },
    async jobState(jobId, queueName = RUNS_QUEUE) {
      const job = await boss.getJobById(queueName, jobId);
      return job?.state ?? null;
    },
    async cancel(jobId, queueName = RUNS_QUEUE) {
      await boss.cancel(queueName, jobId);
    },
  };
}
