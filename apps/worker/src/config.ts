import os from "node:os";
import path from "node:path";
import { otlpHeaders, otlpTracesEndpoint, queueNameForPool, type OtlpTarget } from "@rosterdock/shared";

export interface WorkerConfig {
  databaseUrl: string;
  boardUrl: string;
  workerToken: string;
  workerId: string;
  workRoot: string;
  heartbeatMs: number;
  claudeBin: string;
  claudeAllowedTools: string;
  codexBin: string;
  /** Codex sandbox for model-generated commands: workspace-write (default), read-only, or danger-full-access for a pod that is sandboxed already. */
  codexSandbox: string;
  /** Env var NAMES passed through to engines. Values never appear in logs or the board. */
  passEnvNames: string[];
  gitToken: string | null;
  /** Run the repository's own test script after the diff is captured; the result is a review check. */
  runRepoTests: boolean;
  testTimeoutMs: number;
  /** How long to wait for the board to create the queue schema on a fresh install. */
  startAttempts: number;
  startRetryMs: number;
  /** The OTLP collector a run's worker-side spans go to (OTEL_EXPORTER_OTLP_*). Null: no traces. */
  otlp: OtlpTarget | null;
  /** The worker pool this fleet is (ROSTERDOCK_WORKER_POOL), and the queue it consumes. */
  pool: string | null;
  queueName: string;
  /** Serve /metrics on this port (ROSTERDOCK_WORKER_METRICS_PORT). 0: no metrics page. */
  metricsPort: number;
  /** Read the pod's CPU and memory from the metrics API (ROSTERDOCK_POD_METRICS), for an engine that forks beyond the cgroup. Off: the cgroup. */
  podMetrics: boolean;
}

/**
 * A whole-number setting: its default when unset, and a clear refusal of anything else. Number("15s") is
 * NaN, which setInterval would run every millisecond.
 */
function wholeNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max = Infinity,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(
      `${name} must be a whole number from ${min}${max === Infinity ? " up" : ` to ${max}`}, not "${raw}"`,
    );
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const workerToken = env.ROSTERDOCK_WORKER_TOKEN?.trim();
  if (!workerToken) throw new Error("ROSTERDOCK_WORKER_TOKEN is required");
  const pool = env.ROSTERDOCK_WORKER_POOL?.trim() || null;
  return {
    databaseUrl,
    pool,
    queueName: queueNameForPool(pool),
    boardUrl: (env.BOARD_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    workerToken,
    workerId: env.ROSTERDOCK_WORKER_ID?.trim() || `worker-${os.hostname()}-${process.pid}`,
    workRoot: env.ROSTERDOCK_WORK_ROOT?.trim() || path.join(os.tmpdir(), "rosterdock-runs"),
    heartbeatMs: wholeNumber(env, "ROSTERDOCK_HEARTBEAT_MS", 15_000, 1000),
    claudeBin: env.ROSTERDOCK_CLAUDE_BIN?.trim() || "claude",
    claudeAllowedTools:
      env.ROSTERDOCK_CLAUDE_ALLOWED_TOOLS?.trim() ||
      "Read(./**),Write(./**),Edit(./**),Glob(./**),Grep(./**)",
    codexBin: env.ROSTERDOCK_CODEX_BIN?.trim() || "codex",
    codexSandbox: env.ROSTERDOCK_CODEX_SANDBOX?.trim() || "workspace-write",
    passEnvNames: (
      env.ROSTERDOCK_ENGINE_PASS_ENV ??
      "ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENAI_API_KEY,CODEX_API_KEY"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    gitToken: env.ROSTERDOCK_GIT_TOKEN?.trim() || null,
    runRepoTests: env.ROSTERDOCK_RUN_REPO_TESTS !== "0" && env.ROSTERDOCK_RUN_REPO_TESTS !== "false",
    testTimeoutMs: wholeNumber(env, "ROSTERDOCK_TEST_TIMEOUT_MS", 10 * 60_000, 1000),
    startAttempts: wholeNumber(env, "ROSTERDOCK_START_ATTEMPTS", 60, 1),
    metricsPort: wholeNumber(env, "ROSTERDOCK_WORKER_METRICS_PORT", 0, 0, 65_535),
    podMetrics: env.ROSTERDOCK_POD_METRICS === "1" || env.ROSTERDOCK_POD_METRICS === "true",
    startRetryMs: wholeNumber(env, "ROSTERDOCK_START_RETRY_MS", 5_000, 0),
    otlp: (() => {
      const endpoint = otlpTracesEndpoint(env);
      return endpoint
        ? {
            endpoint,
            headers: otlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
            serviceName: env.OTEL_SERVICE_NAME?.trim() || "rosterdock-worker",
          }
        : null;
    })(),
  };
}
