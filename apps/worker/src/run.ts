// One run, end to end: claim, workspace, engine, harvest, report. The board is
// the source of truth; if it says the run moved on (409), we stop quietly.

import type { RunCompleteInput, RunEventInput, RunUsage } from "@rosterdock/shared";
import { BoardError, type BoardClient, type ClaimedRun } from "./board-client.js";
import type { EngineAdapter } from "./engines/types.js";
import { createResourceSampler, type ResourceSampler } from "./resources.js";
import { createPhaseRecorder, exportWorkerTrace, type WorkerOtlp } from "./trace.js";
import { runRepoTests, type Exec } from "./tests.js";
import { clip } from "./text.js";
import { cleanupWorkspace, harvestWorkspace, prepareWorkspace, type Workspace } from "./workspace.js";

export interface RunDeps {
  board: BoardClient;
  engines: Record<string, EngineAdapter>;
  workRoot: string;
  workerId: string;
  heartbeatMs: number;
  /** Environment handed to engines: allowlisted names only. */
  engineEnv: Record<string, string>;
  /** Board URL as the engine process will reach it; the MCP endpoint is derived from it. */
  boardUrl: string;
  gitToken: string | null;
  /** Run the repository's tests after the harvest; null skips them. `exec` is for tests of the worker itself. */
  repoTests: { timeoutMs: number; exec?: Exec } | null;
  /** Worker shutdown signal. */
  shutdown: AbortSignal;
  log: { info(msg: string): void; warn(msg: string): void };
  /** Pod CPU and memory for the heartbeat; the default reads the cgroup. */
  resources?: ResourceSampler;
  /** The OTLP collector the run's worker-side spans go to; null for none. */
  otlp?: WorkerOtlp | null;
}

export interface RunOutcome {
  runId: string;
  status: RunCompleteInput["status"] | "skipped";
  reason?: string;
}

const TERMINAL = ["completed", "failed", "stopped", "blocked"];

const BASE_ENV_KEYS = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  // macOS: Claude Code finds its sign-in in the login Keychain under the user's name.
  "USER",
  "LOGNAME",
  "TMPDIR",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "TZ",
];

/**
 * A department preset can only narrow the worker's allowlist: keep base keys
 * and only those extra names the preset lists. Null means no narrowing.
 */
export function narrowEnv(env: Record<string, string>, envNames: string[] | null): Record<string, string> {
  if (envNames === null) return env;
  const keep = new Set([...BASE_ENV_KEYS, ...envNames]);
  return Object.fromEntries(Object.entries(env).filter(([k]) => keep.has(k)));
}

/** Base process env plus the allowlisted names. Values never leave the child. */
export function engineEnvironment(
  passEnvNames: string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...passEnvNames]) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export async function executeRun(job: { runId: string; jobId: string }, deps: RunDeps): Promise<RunOutcome> {
  let claimed: ClaimedRun;
  try {
    claimed = await deps.board.claim(job.runId, job.jobId, deps.workerId);
  } catch (err) {
    if (err instanceof BoardError && err.status === 409) {
      const status = typeof err.details?.status === "string" ? err.details.status : null;
      // Finished elsewhere: ack the job. Still running (another worker, or the
      // board does not yet consider it stale): rethrow so pg-boss retries later.
      if (status && TERMINAL.includes(status)) {
        deps.log.info(`run ${job.runId}: already ${status}; nothing to do`);
        return { runId: job.runId, status: "skipped", reason: err.message };
      }
      deps.log.info(`run ${job.runId}: not claimable yet (${err.message}); leaving it for a later retry`);
      throw err;
    }
    throw err;
  }
  const { token, spec, run } = claimed;
  const runId = run.id;
  deps.log.info(
    `run ${runId}: claimed attempt ${run.attempt} for #${spec.task.number} ${spec.task.title} (${run.engine}/${run.model})`,
  );

  const abort = new AbortController();
  let timedOut = false;
  const onShutdown = () => abort.abort();
  deps.shutdown.addEventListener("abort", onShutdown, { once: true });

  // Event buffer: batched to the board every second or every 20 events.
  const buffer: RunEventInput[] = [];
  let usage: Partial<RunUsage> = {};
  let step = "starting";
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer.splice(0, 200);
    try {
      await deps.board.events(token, runId, batch);
    } catch (err) {
      deps.log.warn(`run ${runId}: could not ship ${batch.length} events: ${(err as Error).message}`);
    }
  };
  const emit = (ev: RunEventInput) => {
    buffer.push({ ...ev, at: ev.at ?? new Date().toISOString() });
    if (ev.type === "tool" || ev.type === "step")
      step =
        `${ev.type === "tool" ? String(ev.payload?.name ?? "tool") + " " : ""}${clip(String(ev.payload?.input ?? ev.payload?.text ?? ""), 120)}`.trim();
    if (buffer.length >= 20) void flush();
  };
  const flushTimer = setInterval(() => void flush(), 1000);
  const sampler = deps.resources ?? createResourceSampler();
  void sampler.sample().catch(() => {});
  const heartbeatTimer = setInterval(() => {
    void sampler
      .sample()
      .catch(() => undefined)
      .then((resources) =>
        deps.board.heartbeat(token, runId, { step, usage, ...(resources ? { resources } : {}) }),
      )
      .then((r) => {
        if (r.stopRequested && !abort.signal.aborted) {
          deps.log.info(`run ${runId}: stop requested`);
          abort.abort();
        }
      })
      .catch((err) => {
        if (err instanceof BoardError && err.status === 409)
          abort.abort(); // reaped or stopped elsewhere
        else deps.log.warn(`run ${runId}: heartbeat failed: ${(err as Error).message}`);
      });
  }, deps.heartbeatMs);

  let ws: Workspace | null = null;
  let completion: RunCompleteInput;
  const startedAt = Date.now();
  const phases = createPhaseRecorder();
  try {
    const engine = deps.engines[run.engine];
    if (!engine) {
      completion = {
        status: "failed",
        error: `no engine adapter for ${run.engine} on this worker`,
        blocker: { code: "adapter_unavailable" },
      };
    } else {
      emit({
        type: "step",
        payload: { text: spec.project.repoUrl ? "cloning the repository" : "preparing the workspace" },
      });
      phases.begin("workspace", { "rosterdock.repo": !!spec.project.repoUrl });
      ws = await prepareWorkspace(deps.workRoot, runId, spec.project, deps.gitToken);
      phases.end();
      emit({ type: "step", payload: { text: `running ${engine.id}` } });
      phases.begin(`engine ${engine.id}`, { "rosterdock.engine": engine.id, "rosterdock.model": run.model });
      const sandbox = spec.sandbox ?? { allowedTools: null, envNames: null, timeoutSeconds: 3600 };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        emit({
          type: "stderr",
          payload: { text: `time limit of ${sandbox.timeoutSeconds} s reached; stopping the engine` },
        });
        abort.abort();
      }, sandbox.timeoutSeconds * 1000);
      let result;
      try {
        result = await engine.run({
          workdir: ws.dir,
          pack: claimed.pack,
          model: run.model,
          effort: claimed.spec.teammate.effort ?? null,
          signal: abort.signal,
          emit,
          onUsage: (u) => {
            usage = { ...usage, ...u };
          },
          env: narrowEnv(deps.engineEnv, sandbox.envNames),
          allowedTools: sandbox.allowedTools,
          mcp: { url: `${deps.boardUrl}/api/mcp`, token },
        });
      } finally {
        clearTimeout(timeoutTimer);
      }
      usage = { ...usage, ...result.usage };
      phases.end(result.ok ? null : (result.error ?? "the engine failed"));
      emit({ type: "step", payload: { text: "collecting outputs" } });
      phases.begin("harvest");
      // Ship the engine's log before artifacts so the run log reads in order.
      await flush();
      const harvest = await harvestWorkspace(ws, spec.task.declaredOutputs, {
        maxArtifactBytes: spec.limits?.artifactBytes,
      });
      await deps.board
        .checkpoint(token, runId, { filesWritten: harvest.filesWritten, attempt: run.attempt })
        .catch(() => {});
      for (const artifact of harvest.artifacts) {
        try {
          await deps.board.artifact(token, runId, artifact);
        } catch (err) {
          emit({
            type: "stderr",
            payload: { text: `artifact ${artifact.path} rejected: ${(err as Error).message}` },
          });
        }
      }
      phases.end();
      // The repository's own tests, after the diff is captured so their output stays out of the review.
      let checks: RunCompleteInput["checks"];
      if (deps.repoTests && ws.repo && result.ok && !abort.signal.aborted && !harvest.blocked) {
        emit({ type: "step", payload: { text: "running the repository's tests" } });
        phases.begin("tests");
        // Not the engine's environment: runRepoTests keeps only PATH, HOME, the temp directory and the locale.
        const check = await runRepoTests(ws, {
          exec: deps.repoTests.exec,
          env: deps.engineEnv,
          timeoutMs: deps.repoTests.timeoutMs,
        });
        if (check) {
          checks = [check];
          emit({ type: "check", payload: { kind: check.kind, ok: check.ok, text: check.title } });
        }
        phases.end(check && check.ok === false ? "tests failed" : null);
      }
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        completion = {
          status: "failed",
          error: `The run hit its ${sandbox.timeoutSeconds} s time limit.`,
          summary: harvest.handover ?? undefined,
          usage,
          durationMs,
          blocker: {
            code: "timeout",
            what: `The run hit its ${Math.round(sandbox.timeoutSeconds / 60)} minute time limit.`,
          },
        };
      } else if (abort.signal.aborted) {
        completion = {
          status: "stopped",
          summary: harvest.handover ?? "Stopped on request.",
          usage,
          durationMs,
        };
      } else if (harvest.blocked) {
        const mention = /@([a-z0-9_-]+)/i.exec(harvest.blocked)?.[1];
        completion = {
          status: "blocked",
          summary: harvest.blocked,
          usage,
          durationMs,
          blocker: {
            code: mention ? "waiting_on_teammate" : "unknown",
            what: clip(harvest.blocked, 1000),
            ...(mention
              ? { waitingOn: { kind: "teammate", id: mention.toLowerCase(), name: mention.toLowerCase() } }
              : {}),
          },
        };
      } else if (!result.ok) {
        completion = {
          status: "failed",
          error: result.error ?? "the engine failed",
          summary: harvest.handover ?? undefined,
          usage,
          durationMs,
        };
      } else {
        const missing = harvest.missingOutputs.length
          ? ` Missing declared outputs: ${harvest.missingOutputs.join(", ")}.`
          : "";
        completion = {
          status: "completed",
          summary: clip(`${harvest.handover ?? result.resultText ?? "Finished."}${missing}`, 4000),
          usage,
          durationMs,
          ...(harvest.baseSha ? { baseSha: harvest.baseSha } : {}),
          ...(checks ? { checks } : {}),
        };
      }
    }
  } catch (err) {
    phases.end(clip((err as Error).message, 500));
    completion = {
      status: abort.signal.aborted ? "stopped" : "failed",
      error: clip((err as Error).message, 4000),
      usage,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    phases.end();
    clearInterval(heartbeatTimer);
    clearInterval(flushTimer);
    deps.shutdown.removeEventListener("abort", onShutdown);
  }
  await flush();
  try {
    await deps.board.complete(token, runId, completion);
    deps.log.info(`run ${runId}: ${completion.status}`);
  } catch (err) {
    if (err instanceof BoardError && err.status === 409)
      deps.log.info(`run ${runId}: board already closed it (${err.message})`);
    else deps.log.warn(`run ${runId}: could not report completion: ${(err as Error).message}`);
  }
  if (ws) await cleanupWorkspace(ws).catch(() => {});
  if (deps.otlp && phases.phases.length) {
    const out = await exportWorkerTrace(deps.otlp, runId, deps.workerId, phases.phases);
    if (!out.ok) deps.log.warn(`run ${runId}: trace not exported: ${out.error}`);
  }
  return { runId, status: completion.status };
}
