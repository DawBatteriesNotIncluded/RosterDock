// The worker's view of the board: claim with the fleet token, then everything
// with the run-scoped token. Retries transient failures; a 409 means the run
// moved on without us (reaped or stopped) and is reported, not retried.

import type {
  RunArtifactInput,
  RunCompleteInput,
  RunEventInput,
  RunHeartbeatInput,
  RunStatus,
} from "@rosterdock/shared";
import type { Rework } from "./rework.js";

export interface ClaimedRun {
  run: {
    id: string;
    taskId: string;
    teammateId: string;
    engine: string;
    model: string;
    attempt: number;
    status: RunStatus;
  };
  token: string;
  tokenExpiresAt: string;
  pack: string;
  spec: {
    runId: string;
    attempt: number;
    task: { id: string; number: number; title: string; description: string; declaredOutputs: string[] };
    project: { repoUrl: string | null; defaultBranch: string; name: string };
    teammate: { name: string; handle: string; model: string; engine: string; effort?: string | null };
    /** The task's department, whose sandbox this is; null for none. */
    department?: { name: string; writePolicy: string } | null;
    sandbox: { allowedTools: string[] | null; envNames: string[] | null; timeoutSeconds: number };
    /** The largest artifact the board takes back, in bytes; older boards do not say (the worker assumes the inline limit). */
    limits?: { artifactBytes: number };
    checkpoint: unknown | null;
    /** Sent back with changes requested on a repository task: the round to start from. Older boards send none. */
    rework?: Rework | null;
  };
}

export class BoardError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown> | null;
  constructor(status: number, message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = "BoardError";
    this.status = status;
    this.details = details;
  }
}

export interface BoardClient {
  claim(runId: string, jobId: string, workerId: string): Promise<ClaimedRun>;
  heartbeat(token: string, runId: string, input: RunHeartbeatInput): Promise<{ stopRequested: boolean }>;
  events(token: string, runId: string, events: RunEventInput[]): Promise<void>;
  checkpoint(token: string, runId: string, checkpoint: Record<string, unknown>): Promise<void>;
  /** The commit the run's clone is at, right after cloning, before the engine runs. */
  cloned(token: string, runId: string, sha: string): Promise<void>;
  artifact(token: string, runId: string, input: RunArtifactInput): Promise<void>;
  complete(token: string, runId: string, input: RunCompleteInput): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The completion is the run's result: it is retried for about five minutes (backoff to 30 s), long
 * enough for a board restart or a rollout, before the worker gives up on it.
 */
export const COMPLETE_RETRIES = { retries: 15, maxDelayMs: 30_000 };

export function createBoardClient(
  boardUrl: string,
  workerToken: string,
  fetchImpl: typeof fetch = fetch,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): BoardClient {
  const sleep = opts.sleep ?? wait;
  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    retries = 4,
    maxDelayMs = 10_000,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(`${boardUrl}${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        const json = text ? (JSON.parse(text) as unknown) : null;
        if (res.ok) return json as T;
        const err = (json ?? {}) as { error?: string; details?: Record<string, unknown> };
        // 4xx are decisions, not glitches: do not retry.
        if (res.status >= 400 && res.status < 500)
          throw new BoardError(res.status, err.error ?? `HTTP ${res.status}`, err.details ?? null);
        lastError = new BoardError(res.status, err.error ?? `HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof BoardError && err.status < 500) throw err;
        lastError = err;
      }
      if (attempt < retries) await sleep(Math.min(maxDelayMs, 500 * 2 ** attempt));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    claim: (runId, jobId, workerId) =>
      call(
        "POST",
        "/api/worker/claim",
        { runId, jobId, workerId },
        { "x-rosterdock-worker-token": workerToken },
        2,
      ),
    heartbeat: (token, runId, input) =>
      call("POST", `/api/worker/runs/${runId}/heartbeat`, input, bearer(token), 1),
    events: async (token, runId, events) => {
      await call("POST", `/api/worker/runs/${runId}/events`, { events }, bearer(token), 2);
    },
    cloned: async (token, runId, sha) => {
      await call("POST", `/api/worker/runs/${runId}/cloned`, { sha }, bearer(token), 2);
    },
    checkpoint: async (token, runId, checkpoint) => {
      await call("POST", `/api/worker/runs/${runId}/checkpoint`, { checkpoint }, bearer(token), 2);
    },
    artifact: async (token, runId, input) => {
      await call("POST", `/api/worker/runs/${runId}/artifacts`, input, bearer(token), 3);
    },
    complete: async (token, runId, input) => {
      await call(
        "POST",
        `/api/worker/runs/${runId}/complete`,
        input,
        bearer(token),
        COMPLETE_RETRIES.retries,
        COMPLETE_RETRIES.maxDelayMs,
      );
    },
  };
}
