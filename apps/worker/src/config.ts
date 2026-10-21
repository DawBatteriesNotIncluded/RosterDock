import os from "node:os";
import path from "node:path";
import { otlpHeaders, otlpTracesEndpoint, queueNameForPool, type OtlpTarget } from "@rosterdock/shared";
import { CODEX_SANDBOXES, type CodexSandbox } from "./engines/codex.js";
import type { GitCredential } from "./workspace.js";

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
  /**
   * The widest Codex sandbox for model-generated commands: workspace-write (default), read-only, or
   * danger-full-access for a pod that is sandboxed already. A department's tool list only narrows it.
   */
  codexSandbox: CodexSandbox;
  /** Env var NAMES passed through to engines. Values never appear in logs or the board. */
  passEnvNames: string[];
  /** The git token (ROSTERDOCK_GIT_TOKEN) and the hosts it is sent to (ROSTERDOCK_GIT_TOKEN_HOSTS). Null: no token. */
  gitCredential: GitCredential | null;
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

/** The Codex sandbox the worker allows at most; a department's tool list narrows from it, so it is one Codex knows. */
function codexSandbox(env: NodeJS.ProcessEnv): CodexSandbox {
  const raw = env.ROSTERDOCK_CODEX_SANDBOX?.trim() || "workspace-write";
  if (!(CODEX_SANDBOXES as readonly string[]).includes(raw))
    throw new Error(
      `ROSTERDOCK_CODEX_SANDBOX must be read-only, workspace-write or danger-full-access, not "${raw}"`,
    );
  return raw as CodexSandbox;
}

/** A host name, lower case, with a port where it is not 443: what a clone URL's host is compared with. */
const GIT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * The git token and the hosts it is for: github.com unless ROSTERDOCK_GIT_TOKEN_HOSTS names others. A clone
 * from any other host gets no token. A URL or a pattern there is refused, not guessed at.
 */
function gitCredential(env: NodeJS.ProcessEnv): GitCredential | null {
  const token = env.ROSTERDOCK_GIT_TOKEN?.trim();
  if (!token) return null;
  const raw = env.ROSTERDOCK_GIT_TOKEN_HOSTS?.trim() || "github.com";
  const hosts = raw.split(",").map((h) => h.trim().toLowerCase().replace(/:443$/, ""));
  if (!hosts.every((h) => GIT_HOST_RE.test(h)))
    throw new Error(
      `ROSTERDOCK_GIT_TOKEN_HOSTS names hosts, comma-separated (github.com,git.example.com:8443), not "${raw}"`,
    );
  return { token, hosts };
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
    codexSandbox: codexSandbox(env),
    passEnvNames: (
      env.ROSTERDOCK_ENGINE_PASS_ENV ??
      "ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENAI_API_KEY,CODEX_API_KEY"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    gitCredential: gitCredential(env),
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
