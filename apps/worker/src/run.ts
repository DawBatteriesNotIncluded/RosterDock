// One run, end to end: claim, workspace, engine, harvest, report. The board is
// the source of truth; if it says the run moved on (409), we stop quietly.

import type { RunCompleteInput, RunEventInput, RunUsage } from "@rosterdock/shared";
import { BoardError, type BoardClient, type ClaimedRun } from "./board-client.js";
import type { EngineAdapter } from "./engines/types.js";
import { createResourceSampler, type ResourceSampler } from "./resources.js";
import { applyPreviousRound, freshStartBrief, withRework, type ReworkStart } from "./rework.js";
import { createPhaseRecorder, exportWorkerTrace, type WorkerOtlp } from "./trace.js";
import { runRepoTests, type Exec } from "./tests.js";
import { clip, tail } from "./text.js";
import {
  cleanupWorkspace,
  harvestWorkspace,
  prepareWorkspace,
  type GitCredential,
  type Workspace,
} from "./workspace.js";

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
  /** The git token and the hosts it is sent to; null clones without one. */
  gitCredential: GitCredential | null;
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

/** The abort reason when the worker itself is going away (SIGTERM: a drain, a rollout). */
const SHUTDOWN = "worker shutdown";

/**
 * The worker shut down while the run's engine (or clone) was still going. Nothing is reported: the
 * handler throws this, the queue retries the job, and the retry takes the run over from the checkpoint
 * once the board sees it gone quiet, as operator.md describes for an interrupted run.
 */
export class RunInterrupted extends Error {
  constructor(runId: string) {
    super(`run ${runId}: interrupted by the worker shutting down; the queue retries it`);
    this.name = "RunInterrupted";
  }
}

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

/**
 * The completion cut to what the board's RunCompleteSchema takes, field by field. An engine's error
 * carries its last stderr line, and one over the limit made the board refuse the whole report.
 */
export function fitCompletion(c: RunCompleteInput): RunCompleteInput {
  const fit = (text: string | undefined, max: number) =>
    text === undefined ? undefined : clip(text.trim(), max);
  return {
    ...c,
    ...(c.summary !== undefined ? { summary: fit(c.summary, 4000) } : {}),
    ...(c.error !== undefined ? { error: fit(c.error, 4000) } : {}),
    ...(c.model !== undefined ? { model: fit(c.model, 120) } : {}),
    ...(c.blocker
      ? {
          blocker: {
            ...c.blocker,
            ...(c.blocker.what !== undefined ? { what: fit(c.blocker.what, 1000) } : {}),
            ...(c.blocker.why !== undefined ? { why: fit(c.blocker.why, 1000) } : {}),
            ...(c.blocker.waitingOn?.name !== undefined
              ? { waitingOn: { ...c.blocker.waitingOn, name: clip(c.blocker.waitingOn.name, 120) } }
              : {}),
          },
        }
      : {}),
    ...(c.checks
      ? {
          checks: c.checks.slice(0, 10).map((k) => ({
            ...k,
            title: clip(k.title.trim(), 200),
            ...(k.detail !== undefined ? { detail: tail(k.detail, 20_000, "…") } : {}),
          })),
        }
      : {}),
  };
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
  // A job handed over while the worker stops is left for another worker.
  if (deps.shutdown.aborted) throw new RunInterrupted(job.runId);
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
  const onShutdown = () => abort.abort(SHUTDOWN);
  deps.shutdown.addEventListener("abort", onShutdown, { once: true });
  const byShutdown = () => abort.signal.aborted && abort.signal.reason === SHUTDOWN;

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
  let reworkStart: ReworkStart | null = null;
  /** Null: the worker's shutdown cut the run short, and the queue's retry finishes it. */
  let completion: RunCompleteInput | null;
  const startedAt = Date.now();
  const phases = createPhaseRecorder();
  const sandbox = spec.sandbox ?? { allowedTools: null, envNames: null, timeoutSeconds: 3600 };
  const timeLimit = (summary?: string): RunCompleteInput => ({
    status: "failed",
    error: `The run hit its ${sandbox.timeoutSeconds} s time limit.`,
    summary,
    usage,
    durationMs: Date.now() - startedAt,
    blocker: {
      code: "timeout",
      what: `The run hit its ${Math.round(sandbox.timeoutSeconds / 60)} minute time limit.`,
    },
  });
  try {
    const engine = deps.engines[run.engine];
    // An engine that cannot keep to the department's tool list starts nothing: no clone, no process.
    const refused = engine?.refuse?.(sandbox.allowedTools, spec.department?.name ?? null) ?? null;
    if (!engine) {
      completion = {
        status: "failed",
        error: `no engine adapter for ${run.engine} on this worker`,
        blocker: { code: "adapter_unavailable" },
      };
    } else if (refused) {
      deps.log.info(`run ${runId}: not started: ${refused.what} ${refused.why}`);
      completion = {
        status: "failed",
        error: `${refused.what} ${refused.why} ${refused.fix}`,
        blocker: { code: "adapter_unavailable", what: refused.what, why: refused.why },
      };
    } else {
      // The time limit runs from here: a clone that stalls counts against it like the engine.
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        emit({
          type: "stderr",
          payload: { text: `time limit of ${sandbox.timeoutSeconds} s reached; stopping the run` },
        });
        abort.abort();
      }, sandbox.timeoutSeconds * 1000);
      let result;
      try {
        emit({
          type: "step",
          payload: { text: spec.project.repoUrl ? "cloning the repository" : "preparing the workspace" },
        });
        phases.begin("workspace", { "rosterdock.repo": !!spec.project.repoUrl });
        ws = await prepareWorkspace(deps.workRoot, runId, spec.project, deps.gitCredential, abort.signal);
        // Rework: the round sent back carries over into the clone, or the run says why it starts clean.
        if (spec.rework && ws.repo) {
          reworkStart = await applyPreviousRound(ws, spec.rework, spec.project.defaultBranch);
          emit(
            reworkStart.applied
              ? {
                  type: "step",
                  payload: {
                    text: `starting from round ${reworkStart.round}'s changes (${reworkStart.files} files)`,
                  },
                }
              : {
                  type: "stderr",
                  payload: {
                    text: `round ${reworkStart.round}'s changes did not carry over: ${reworkStart.reason}; starting from a fresh clone of ${spec.project.defaultBranch}`,
                  },
                },
          );
        }
        phases.end();
        emit({ type: "step", payload: { text: `running ${engine.id}` } });
        phases.begin(`engine ${engine.id}`, {
          "rosterdock.engine": engine.id,
          "rosterdock.model": run.model,
        });
        result = await engine.run({
          workdir: ws.dir,
          pack:
            reworkStart && !reworkStart.applied
              ? `${claimed.pack}\n\n${freshStartBrief(reworkStart, spec.project.defaultBranch)}\n`
              : claimed.pack,
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
      const omitted = harvest.diffOmitted.length
        ? ` The diff was over the size the board takes, so the review leaves out: ${harvest.diffOmitted.join(", ")}.`
        : "";
      if (omitted) emit({ type: "stderr", payload: { text: clip(omitted.trim(), 500) } });
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
        completion = timeLimit(harvest.handover ?? undefined);
      } else if (byShutdown() && !result.ok) {
        // Not a stop anyone asked for: what the run wrote is stored, and the retry picks it up.
        completion = null;
      } else if (abort.signal.aborted && !byShutdown()) {
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
        const missing =
          (harvest.missingOutputs.length
            ? ` Missing declared outputs: ${harvest.missingOutputs.join(", ")}.`
            : "") +
          (harvest.refusedOutputs.length
            ? ` Refused outputs (a link, or a path outside the workspace): ${harvest.refusedOutputs.join(", ")}.`
            : "");
        completion = {
          status: "completed",
          summary: clip(`${harvest.handover ?? result.resultText ?? "Finished."}${missing}${omitted}`, 4000),
          usage,
          durationMs,
          ...(harvest.baseSha ? { baseSha: harvest.baseSha } : {}),
          ...(checks ? { checks } : {}),
        };
      }
    }
  } catch (err) {
    phases.end(clip((err as Error).message, 500));
    completion = timedOut
      ? timeLimit()
      : byShutdown()
        ? null
        : {
            status: abort.signal.aborted ? "stopped" : "failed",
            error: clip((err as Error).message, 4000),
            usage,
            durationMs: Date.now() - startedAt,
          };
  } finally {
    phases.end();
    clearInterval(flushTimer);
    deps.shutdown.removeEventListener("abort", onShutdown);
  }
  const finish = async () => {
    clearInterval(heartbeatTimer);
    if (ws) await cleanupWorkspace(ws).catch(() => {});
    if (deps.otlp && phases.phases.length) {
      const out = await exportWorkerTrace(deps.otlp, runId, deps.workerId, phases.phases);
      if (!out.ok) deps.log.warn(`run ${runId}: trace not exported: ${out.error}`);
    }
  };
  if (!completion) {
    emit({ type: "step", payload: { text: "the worker is shutting down; the run will be picked up again" } });
    await flush();
    await finish();
    const err = new RunInterrupted(runId);
    deps.log.info(err.message);
    throw err;
  }
  if (reworkStart) completion = withRework(completion, reworkStart, spec.project.defaultBranch);
  await flush();
  completion = fitCompletion(completion);
  // The heartbeat goes on while the report is retried, so a board that comes back finds the run alive.
  try {
    await deps.board.complete(token, runId, completion);
    deps.log.info(`run ${runId}: ${completion.status}`);
  } catch (err) {
    if (err instanceof BoardError && err.status === 409) {
      deps.log.info(`run ${runId}: board already closed it (${err.message})`);
    } else if (err instanceof BoardError && err.status < 500) {
      // A refusal will not change on a retry: report the failure in words the board takes.
      deps.log.warn(
        `run ${runId}: the board refused the report (${err.status} ${err.message}); reporting a failure`,
      );
      const refused = fitCompletion({
        status: "failed",
        error: `The board refused this run's report: ${err.message}`,
        usage,
        durationMs: Date.now() - startedAt,
      });
      await deps.board
        .complete(token, runId, refused)
        .then(() => (completion = refused))
        .catch((e: Error) =>
          deps.log.warn(`run ${runId}: could not report the failure either: ${e.message}`),
        );
    } else {
      // The board stayed unreachable: throw, so pg-boss retries the job and the run is not lost.
      await finish();
      throw new Error(
        `run ${runId}: could not report the result (${(err as Error).message}); the queue retries the run`,
      );
    }
  }
  await finish();
  return { runId, status: completion.status };
}
