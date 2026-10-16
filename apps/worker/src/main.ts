// rosterdock-worker: consumes the runs queue and executes one run at a time.
// pg-boss keeps the job's heartbeat while the handler runs; the board's
// reaper handles what happens if this process dies.

import { PgBoss } from "pg-boss";
import { RUN_QUEUE_SETTINGS } from "@rosterdock/shared";
import { createBoardClient } from "./board-client.js";
import { loadConfig } from "./config.js";
import { createLog, logFormatFrom } from "./log.js";
import { createClaudeCodeEngine } from "./engines/claude-code.js";
import { createCodexEngine } from "./engines/codex.js";
import { stubEngine } from "./engines/stub.js";
import type { EngineAdapter } from "./engines/types.js";
import { createWorkerMetrics, startMetricsServer } from "./metrics.js";
import { createPodMetricsSampler, podMetricsConfig } from "./pod-metrics.js";
import { createResourceSampler } from "./resources.js";
import { engineEnvironment, executeRun, RunInterrupted } from "./run.js";

const config = loadConfig();
const log = createLog(logFormatFrom(process.env, process.stdout.isTTY === true), {
  service: "rosterdock-worker",
  worker: config.workerId,
});

const engines: Record<string, EngineAdapter> = {
  stub: stubEngine,
  claude_code: createClaudeCodeEngine({ bin: config.claudeBin, allowedTools: config.claudeAllowedTools }),
  codex: createCodexEngine({ bin: config.codexBin, sandbox: config.codexSandbox }),
};

// The worker's own counters, on a port of their own when one is configured (a ServiceMonitor scrapes the fleet).
const metrics = createWorkerMetrics({ worker: config.workerId, pool: config.pool, queue: config.queueName });
const metricsServer = config.metricsPort ? await startMetricsServer(metrics, config.metricsPort) : null;
if (metricsServer) log.info(`metrics on :${metricsServer.port}/metrics`);

// The pod's CPU and memory for the heartbeat: the metrics API when the chart turned it on, else the cgroup.
const podMetrics = config.podMetrics ? await podMetricsConfig() : null;
const resources = podMetrics
  ? createPodMetricsSampler(podMetrics, {
      fetch: (i, init) => fetch(i, init),
      fallback: createResourceSampler(),
      log,
    })
  : createResourceSampler();
if (podMetrics) log.info(`pod metrics from the metrics API for ${podMetrics.namespace}/${podMetrics.pod}`);

const shutdown = new AbortController();
const boss = new PgBoss({
  connectionString: config.databaseUrl,
  schema: "pgboss",
  supervise: false,
  migrate: false,
});
boss.on("error", (err) => log.warn(`pg-boss: ${err.message}`));
// The board creates the queue schema on its first boot; a worker that comes up first waits for it.
for (let attempt = 1; ; attempt++) {
  try {
    await boss.start();
    break;
  } catch (err) {
    if (attempt >= config.startAttempts) throw err;
    log.warn(
      `queue not ready (${(err as Error).message.split("\n")[0]}); retrying in ${config.startRetryMs} ms`,
    );
    await new Promise((r) => setTimeout(r, config.startRetryMs));
  }
}

// A pool's queue exists once the board has sent a run to it; a fresh pool's first worker makes it.
if (!(await boss.getQueue(config.queueName)))
  await boss.createQueue(config.queueName, { ...RUN_QUEUE_SETTINGS });
const board = createBoardClient(config.boardUrl, config.workerToken);
await boss.work<{ runId: string; companyId: string }>(
  config.queueName,
  { batchSize: 1, pollingIntervalSeconds: 2 },
  async (jobs) => {
    for (const job of jobs) {
      metrics.runStarted();
      const startedAt = Date.now();
      let status = "error";
      try {
        const outcome = await executeRun(
          { runId: job.data.runId, jobId: job.id },
          {
            board,
            engines,
            workRoot: config.workRoot,
            workerId: config.workerId,
            heartbeatMs: config.heartbeatMs,
            engineEnv: engineEnvironment(config.passEnvNames),
            boardUrl: config.boardUrl,
            gitToken: config.gitToken,
            repoTests: config.runRepoTests ? { timeoutMs: config.testTimeoutMs } : null,
            otlp: config.otlp ? { target: config.otlp, fetch: (i, init) => fetch(i, init) } : null,
            resources,
            shutdown: shutdown.signal,
            log,
          },
        );
        status = outcome.status;
      } catch (err) {
        // Thrown on to pg-boss, which retries the job; the retry resumes the run.
        if (err instanceof RunInterrupted) status = "interrupted";
        throw err;
      } finally {
        metrics.runFinished(status, Date.now() - startedAt);
      }
    }
  },
);
log.info(
  `consuming ${config.queueName} from ${config.boardUrl}; engines: ${Object.keys(engines).join(", ")}`,
  {
    queue: config.queueName,
    pool: config.pool,
  },
);

const stop = async () => {
  log.info("shutting down");
  shutdown.abort();
  await boss.stop({ graceful: true, timeout: 20_000, close: true });
  await metricsServer?.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
