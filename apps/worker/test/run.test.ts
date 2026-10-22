// executeRun against an in-memory board. No network, no model, no Postgres.
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RunCompleteSchema,
  type RunArtifactInput,
  type RunCompleteInput,
  type RunEventInput,
} from "@rosterdock/shared";
import { BoardError, type BoardClient, type ClaimedRun } from "../src/board-client.js";
import { createCodexEngine } from "../src/engines/codex.js";
import { stubEngine } from "../src/engines/stub.js";
import type { EngineAdapter } from "../src/engines/types.js";
import { engineEnvironment, executeRun, fitCompletion, RunInterrupted, type RunDeps } from "../src/run.js";
import { runRootSpanId, traceIdForRun } from "@rosterdock/shared";
import { git } from "../src/workspace.js";

let workRoot: string;
beforeAll(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), "rosterdock-work-"));
});
afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

interface FakeBoard extends BoardClient {
  shipped: RunEventInput[];
  artifacts: RunArtifactInput[];
  completion: RunCompleteInput | null;
  checkpoints: Record<string, unknown>[];
  heartbeats: number;
  stopAfterHeartbeats: number | null;
}

function fakeBoard(
  pack: string,
  declaredOutputs: string[],
  opts: {
    claimStatus?: number;
    claimDetails?: Record<string, unknown>;
    stopAfterHeartbeats?: number | null;
    repoUrl?: string;
    sandbox?: ClaimedRun["spec"]["sandbox"];
    limits?: ClaimedRun["spec"]["limits"];
    engine?: string;
    department?: ClaimedRun["spec"]["department"];
  } = {},
): FakeBoard {
  const claimed: ClaimedRun = {
    run: {
      id: "run-1",
      taskId: "task-1",
      teammateId: "cody",
      engine: opts.engine ?? "stub",
      model: "stub",
      attempt: 1,
      status: "running",
    },
    token: "run-token",
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    pack,
    spec: {
      runId: "run-1",
      attempt: 1,
      task: { id: "task-1", number: 7, title: "Fixture", description: "", declaredOutputs },
      project: { repoUrl: opts.repoUrl ?? null, defaultBranch: "main", name: "P" },
      teammate: { name: "Cody", handle: "cody", model: "stub", engine: opts.engine ?? "stub" },
      ...(opts.department ? { department: opts.department } : {}),
      sandbox: opts.sandbox ?? { allowedTools: null, envNames: null, timeoutSeconds: 3600 },
      ...(opts.limits ? { limits: opts.limits } : {}),
      checkpoint: null,
    },
  };
  const board: FakeBoard = {
    shipped: [],
    artifacts: [],
    completion: null,
    checkpoints: [],
    heartbeats: 0,
    stopAfterHeartbeats: opts.stopAfterHeartbeats ?? null,
    async claim() {
      if (opts.claimStatus)
        throw new BoardError(
          opts.claimStatus,
          `run is ${String(opts.claimDetails?.status ?? "completed")}`,
          opts.claimDetails ?? null,
        );
      return claimed;
    },
    async heartbeat() {
      board.heartbeats += 1;
      return {
        stopRequested: board.stopAfterHeartbeats !== null && board.heartbeats >= board.stopAfterHeartbeats,
      };
    },
    async events(_t, _r, evs) {
      board.shipped.push(...evs);
    },
    async checkpoint(_t, _r, cp) {
      board.checkpoints.push(cp);
    },
    async artifact(_t, _r, a) {
      if (a.content.includes("ghp_")) throw new BoardError(422, "secret-shaped");
      board.artifacts.push(a);
    },
    async complete(_t, _r, c) {
      // What the board's route does with a body its schema refuses.
      const parsed = RunCompleteSchema.safeParse(c);
      if (!parsed.success) throw new BoardError(400, parsed.error.message);
      board.completion = c;
    },
  };
  return board;
}

function deps(board: FakeBoard, overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    board,
    engines: { stub: stubEngine },
    workRoot,
    workerId: "test-worker",
    heartbeatMs: 50,
    engineEnv: {},
    boardUrl: "http://board.test",
    gitCredential: null,
    repoTests: null,
    shutdown: new AbortController().signal,
    log: { info: () => {}, warn: () => {} },
    ...overrides,
  };
}

const PACK = (marker = "") =>
  `# Fixture task\n\n${marker}\n\n## Expected outputs\n- vms-architecture.md\n- notes.md\n\n## Boundaries\n- x\n`;

describe("executeRun", () => {
  it("completes: outputs and handover become artifacts, usage and summary reach the board, workspace is removed", async () => {
    const board = fakeBoard(PACK(), ["vms-architecture.md", "notes.md"]);
    const outcome = await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board));
    expect(outcome.status).toBe("completed");
    expect(board.completion?.status).toBe("completed");
    expect(board.completion?.summary).toMatch(/Wrote vms-architecture.md, notes.md/);
    expect(board.completion?.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(board.artifacts.map((a) => [a.path, a.kind])).toEqual([
      ["vms-architecture.md", "document"],
      ["notes.md", "document"],
      ["handover-summary.md", "handover"],
      ["changes.diff", "diff"],
    ]);
    // No repository: the diff adds the harvested files so the review looks the same.
    expect(board.artifacts.at(-1)!.content).toContain("+++ b/notes.md");
    expect(board.completion?.baseSha).toBeUndefined();
    expect(board.checkpoints[0]).toMatchObject({
      filesWritten: ["vms-architecture.md", "notes.md"],
      attempt: 1,
    });
    expect(board.shipped.map((e) => e.type)).toEqual(
      expect.arrayContaining(["step", "engine", "tool", "assistant"]),
    );
    expect(board.shipped.every((e) => typeof e.at === "string")).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(workRoot, "run-1"))).toBe(false);
  });

  it("reports missing declared outputs in the summary", async () => {
    const board = fakeBoard(PACK(), ["vms-architecture.md", "notes.md", "missing.md"]);
    await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board));
    expect(board.completion?.status).toBe("completed");
    expect(board.completion?.summary).toMatch(/Missing declared outputs: missing.md/);
  });

  it("reports a declared output left as a link in the summary, and never reads what it points at", async () => {
    const secret = path.join(workRoot, "environ");
    await writeFile(secret, "ROSTERDOCK_WORKER_TOKEN=hunter2\n", "utf8");
    const linking: EngineAdapter = {
      id: "stub",
      async run(ctx) {
        const result = await stubEngine.run(ctx);
        await symlink(secret, path.join(ctx.workdir, "report.md"));
        return result;
      },
    };
    const board = fakeBoard(PACK(), ["vms-architecture.md", "notes.md", "report.md"]);
    await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board, { engines: { stub: linking } }));
    expect(board.completion?.status).toBe("completed");
    expect(board.completion?.summary).toMatch(
      /Refused outputs \(a link, or a path outside the workspace\): report.md\./,
    );
    expect(board.completion?.summary).not.toMatch(/Missing declared outputs/);
    expect(board.artifacts.map((a) => a.path)).not.toContain("report.md");
    expect(JSON.stringify(board.artifacts)).not.toContain("hunter2");
  });

  it("fails when the engine fails, keeping whatever was written", async () => {
    const board = fakeBoard(PACK("[stub:fail]"), ["vms-architecture.md", "notes.md"]);
    await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board));
    expect(board.completion?.status).toBe("failed");
    expect(board.completion?.error).toMatch(/exited with code 1/);
    expect(board.artifacts.map((a) => a.path)).toEqual(["vms-architecture.md", "notes.md", "changes.diff"]);
    expect(board.shipped.some((e) => e.type === "stderr")).toBe(true);
  });

  it("fits an engine error longer than the board takes, so the failure is still recorded", async () => {
    // Claude Code's error carries its last stderr line, which can be 4,000 characters on its own.
    const long: EngineAdapter = {
      id: "stub",
      async run() {
        return {
          ok: false,
          exitCode: 1,
          usage: {},
          resultText: null,
          error: `Claude Code exited with code 1: ${"e".repeat(4000)}`,
        };
      },
    };
    const board = fakeBoard(PACK(), []);
    await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board, { engines: { stub: long } }));
    expect(board.completion?.status).toBe("failed");
    expect(board.completion?.error?.length).toBeLessThanOrEqual(4000);
    expect(board.completion?.error).toMatch(/^Claude Code exited with code 1: e+$/);
  });

  it("names in the summary and the run log the files a diff over the board's limit leaves out", async () => {
    const writer: EngineAdapter = {
      id: "stub",
      async run(ctx) {
        await writeFile(path.join(ctx.workdir, "one.md"), `${"1".repeat(199)}\n`, "utf8");
        await writeFile(path.join(ctx.workdir, "two.md"), `${"2".repeat(199)}\n`, "utf8");
        return { ok: true, exitCode: 0, usage: {}, resultText: "Wrote two files." };
      },
    };
    const board = fakeBoard(PACK(), [], { limits: { artifactBytes: 400 } });
    await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board, { engines: { stub: writer } }));
    expect(board.completion?.status).toBe("completed");
    expect(board.completion?.summary).toBe(
      "Wrote two files. The diff was over the size the board takes, so the review leaves out: two.md.",
    );
    expect(board.shipped.some((e) => String(e.payload?.text).includes("leaves out: two.md"))).toBe(true);
    expect(board.artifacts.find((a) => a.kind === "diff")?.content).not.toContain("two.md");
  });

  it("turns blocked.md into a blocked completion routed to the mentioned teammate", async () => {
    const board = fakeBoard(PACK("[stub:block]"), ["vms-architecture.md", "notes.md"]);
    await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board));
    expect(board.completion?.status).toBe("blocked");
    expect(board.completion?.blocker?.code).toBe("waiting_on_teammate");
    expect(board.completion?.blocker?.waitingOn?.name).toBe("brody");
    expect(board.completion?.summary).toMatch(/comparison criteria/);
  });

  it("stops a hanging engine when the board asks, and reports stopped", async () => {
    const board = fakeBoard(PACK("[stub:hang]"), ["vms-architecture.md"], { stopAfterHeartbeats: 2 });
    const outcome = await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board));
    expect(outcome.status).toBe("stopped");
    expect(board.completion?.status).toBe("stopped");
    expect(board.heartbeats).toBeGreaterThanOrEqual(2);
  });

  it("keeps the tokens a stopped or timed-out engine had used", async () => {
    const spent: EngineAdapter = {
      id: "stub",
      async run(ctx) {
        ctx.onUsage({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 37471 });
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
        return { ok: false, exitCode: null, usage: {}, resultText: null, error: "stopped" };
      },
    };
    const stopped = fakeBoard(PACK(), [], { stopAfterHeartbeats: 2 });
    await executeRun({ runId: "run-1", jobId: "job-1" }, deps(stopped, { engines: { stub: spent } }));
    expect(stopped.completion?.status).toBe("stopped");
    expect(stopped.completion?.usage).toMatchObject({ inputTokens: 10, cacheWriteTokens: 37471 });

    const slow = fakeBoard(PACK(), [], {
      sandbox: { allowedTools: null, envNames: null, timeoutSeconds: 1 },
    });
    await executeRun(
      { runId: "run-1", jobId: "job-1" },
      deps(slow, { engines: { stub: spent }, heartbeatMs: 10_000 }),
    );
    expect(slow.completion?.blocker?.code).toBe("timeout");
    expect(slow.completion?.usage).toMatchObject({ inputTokens: 10, cacheWriteTokens: 37471 });
  });

  it("leaves a run the worker's shutdown cut short to the queue's retry instead of reporting it stopped", async () => {
    const board = fakeBoard(PACK("[stub:hang]"), ["vms-architecture.md"]);
    const shutdown = new AbortController();
    const p = executeRun({ runId: "run-1", jobId: "job-1" }, deps(board, { shutdown: shutdown.signal }));
    setTimeout(() => shutdown.abort(), 100);
    // Thrown to pg-boss, which retries the job; the retry takes the run over from the checkpoint.
    await expect(p).rejects.toBeInstanceOf(RunInterrupted);
    expect(board.completion).toBeNull();
    expect(board.checkpoints).toHaveLength(1);
    expect(board.shipped.some((e) => String(e.payload?.text).includes("shutting down"))).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(workRoot, "run-1"))).toBe(false);
  });

  it("reports a run whose engine finished before the shutdown, and claims nothing once it began", async () => {
    const shutdown = new AbortController();
    const finished: EngineAdapter = {
      id: "stub",
      async run(ctx) {
        const result = await stubEngine.run(ctx);
        shutdown.abort();
        return result;
      },
    };
    const board = fakeBoard(PACK(), ["vms-architecture.md", "notes.md"]);
    await executeRun(
      { runId: "run-1", jobId: "job-1" },
      deps(board, { engines: { stub: finished }, shutdown: shutdown.signal }),
    );
    expect(board.completion?.status).toBe("completed");

    const late = fakeBoard(PACK(), []);
    late.claim = async () => {
      throw new Error("claimed during shutdown");
    };
    await expect(
      executeRun({ runId: "run-1", jobId: "job-1" }, deps(late, { shutdown: shutdown.signal })),
    ).rejects.toBeInstanceOf(RunInterrupted);
  });

  it("hands the run back to the queue when the board stays unreachable for the report", async () => {
    const board = fakeBoard(PACK(), ["vms-architecture.md", "notes.md"]);
    // What the client throws once its five minutes of retries are spent.
    board.complete = async () => {
      throw new BoardError(503, "HTTP 503");
    };
    await expect(executeRun({ runId: "run-1", jobId: "job-1" }, deps(board))).rejects.toThrow(
      /could not report the result \(HTTP 503\); the queue retries the run/,
    );
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(workRoot, "run-1"))).toBe(false);
  });

  it("reports a failure in words the board takes when it refuses the report", async () => {
    const board = fakeBoard(PACK(), ["vms-architecture.md", "notes.md"]);
    const sent: RunCompleteInput[] = [];
    board.complete = async (_t, _r, c) => {
      sent.push(c);
      if (sent.length === 1) throw new BoardError(422, "a value where a name belongs");
      board.completion = c;
    };
    const outcome = await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board));
    expect(sent[0]?.status).toBe("completed");
    expect(board.completion).toMatchObject({
      status: "failed",
      error: "The board refused this run's report: a value where a name belongs",
      usage: { inputTokens: 1200, outputTokens: 300 },
    });
    expect(outcome.status).toBe("failed");
  });

  it("skips quietly when the run already finished, but rethrows when it is still running elsewhere", async () => {
    const finished = fakeBoard(PACK(), [], { claimStatus: 409, claimDetails: { status: "completed" } });
    const outcome = await executeRun({ runId: "run-1", jobId: "job-1" }, deps(finished));
    expect(outcome.status).toBe("skipped");
    expect(finished.completion).toBeNull();

    const busy = fakeBoard(PACK(), [], { claimStatus: 409, claimDetails: { status: "running" } });
    await expect(executeRun({ runId: "run-1", jobId: "job-1" }, deps(busy))).rejects.toThrow(
      /run is running/,
    );
  });

  it("fails cleanly when no adapter exists for the engine", async () => {
    const board = fakeBoard(PACK(), []);
    await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board, { engines: {} }));
    expect(board.completion?.status).toBe("failed");
    expect(board.completion?.blocker?.code).toBe("adapter_unavailable");
  });
});

describe("sandbox preset", () => {
  it("narrows the engine environment to the preset's names and fails a run past its time limit", async () => {
    const seen: { env: Record<string, string>; allowedTools: string[] | null }[] = [];
    const spy: EngineAdapter = {
      id: "stub",
      async run(ctx) {
        seen.push({ env: ctx.env, allowedTools: ctx.allowedTools });
        return stubEngine.run(ctx);
      },
    };
    const board = fakeBoard(PACK(), [], {
      sandbox: { allowedTools: ["Read(./**)"], envNames: ["ALLOWED_ONE"], timeoutSeconds: 60 },
    });
    await executeRun(
      { runId: "run-1", jobId: "job-1" },
      deps(board, { engines: { stub: spy }, engineEnv: { PATH: "/bin", ALLOWED_ONE: "a", OTHER: "b" } }),
    );
    expect(seen[0]?.env).toEqual({ PATH: "/bin", ALLOWED_ONE: "a" });
    expect(seen[0]?.allowedTools).toEqual(["Read(./**)"]);

    const slow = fakeBoard(PACK("[stub:hang]"), [], {
      sandbox: { allowedTools: null, envNames: null, timeoutSeconds: 1 },
    });
    const outcome = await executeRun({ runId: "run-1", jobId: "job-1" }, deps(slow, { heartbeatMs: 10_000 }));
    expect(outcome.status).toBe("failed");
    expect(slow.completion?.blocker?.code).toBe("timeout");
    expect(slow.completion?.error).toMatch(/time limit/);
  });

  it("fails a run whose engine cannot keep to the department's tool list before anything starts", async () => {
    const started = path.join(workRoot, "codex-started");
    const mark = path.join(workRoot, "codex-mark.mjs");
    await writeFile(
      mark,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(started)}, "yes");`,
      "utf8",
    );
    const board = fakeBoard(PACK(), ["notes.md"], {
      engine: "codex",
      department: { name: "Research", writePolicy: "drafts" },
      // Never cloned: a clone of this missing repository would fail with an error of its own.
      repoUrl: path.join(workRoot, "missing.git"),
      sandbox: {
        allowedTools: ["Read(./**)", "Write(./**)", "WebSearch"],
        envNames: null,
        timeoutSeconds: 60,
      },
    });
    const codex = createCodexEngine({
      bin: process.execPath,
      sandbox: "workspace-write",
      prefixArgs: [mark],
    });
    const outcome = await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board, { engines: { codex } }));
    expect(outcome.status).toBe("failed");
    expect(board.completion).toEqual({
      status: "failed",
      error:
        "Codex cannot keep to Research's tool list. It reads files and runs commands only through its shell, and the list leaves out Bash. Name Bash on its own in the list, or pick another engine in the teammate's editor.",
      blocker: {
        code: "adapter_unavailable",
        what: "Codex cannot keep to Research's tool list.",
        why: "It reads files and runs commands only through its shell, and the list leaves out Bash.",
      },
    });
    // Nothing started: no workspace, no clone, no engine process.
    expect(board.shipped.filter((e) => e.type === "step")).toEqual([]);
    expect(existsSync(started)).toBe(false);
  });
});

/** A git host that accepts the connection and never answers: a clone against it stalls. Loopback only. */
async function silentHost(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/stalled.git`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("a stalled clone", () => {
  it("ends on Stop instead of holding the worker", async () => {
    const host = await silentHost();
    try {
      const board = fakeBoard(PACK(), [], { repoUrl: host.url, stopAfterHeartbeats: 2 });
      const started = Date.now();
      const outcome = await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board));
      expect(outcome.status).toBe("stopped");
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await host.close();
    }
  });

  it("counts against the run's time limit", async () => {
    const host = await silentHost();
    try {
      const board = fakeBoard(PACK(), [], {
        repoUrl: host.url,
        sandbox: { allowedTools: null, envNames: null, timeoutSeconds: 1 },
      });
      const outcome = await executeRun(
        { runId: "run-1", jobId: "job-1" },
        deps(board, { heartbeatMs: 10_000 }),
      );
      expect(outcome.status).toBe("failed");
      expect(board.completion?.blocker?.code).toBe("timeout");
      expect(board.completion?.error).toMatch(/time limit/);
      expect(existsSync(path.join(workRoot, "run-1"))).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("leaves nothing of a clone stopped part-way, the git token in its config included", async () => {
    const host = await silentHost();
    try {
      // https to a host the token is for: git writes the URL, token and all, into .git/config before it connects.
      const { port } = new URL(host.url);
      const board = fakeBoard(PACK(), [], {
        repoUrl: `https://127.0.0.1:${port}/stalled.git`,
        stopAfterHeartbeats: 4,
      });
      const outcome = await executeRun(
        { runId: "run-1", jobId: "job-1" },
        deps(board, { gitCredential: { token: "partial-clone-token", hosts: [`127.0.0.1:${port}`] } }),
      );
      expect(outcome.status).toBe("stopped");
      expect(existsSync(path.join(workRoot, "run-1"))).toBe(false);
    } finally {
      await host.close();
    }
  });
});

describe("repository tests", () => {
  it("runs the repository's test script after the harvest and ships the result as a check", async () => {
    // A bare repository with a package.json test script; the runner is a recorded exec, never npm.
    const src = path.join(workRoot, "src-repo");
    const bare = path.join(workRoot, "origin.git");
    await (await import("node:fs/promises")).mkdir(src, { recursive: true });
    const env = {
      // An identity only: never the caller's environment, which under a rebase or a hook points at this repository.
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    await git(["init", "-b", "main"], src, env);
    await writeFile(
      path.join(src, "package.json"),
      '{ "name": "demo", "scripts": { "test": "node t.js" } }\n',
    );
    await writeFile(path.join(src, "node_modules.keep"), "");
    await git(["add", "."], src, env);
    await git(["commit", "-m", "init"], src, env);
    await git(["clone", "--bare", src, bare], workRoot, env);

    const board = fakeBoard(PACK(), ["notes.md"], { repoUrl: bare });
    const commands: string[] = [];
    const envs: Record<string, string>[] = [];
    await executeRun(
      { runId: "run-1", jobId: "job-1" },
      deps(board, {
        engineEnv: { PATH: process.env.PATH ?? "/usr/bin", ANTHROPIC_API_KEY: "model-key" },
        repoTests: {
          timeoutMs: 1000,
          exec: async (command, args, opts) => {
            commands.push(`${command} ${args.join(" ")}`);
            envs.push(opts.env);
            return { code: args[0] === "test" ? 0 : 0, output: "1 passing\n", timedOut: false };
          },
        },
      }),
    );
    expect(board.completion?.status).toBe("completed");
    expect(board.completion?.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(board.completion?.checks).toEqual([
      { kind: "tests", ok: true, title: "npm test passed", detail: "1 passing\n" },
    ]);
    expect(commands).toEqual(["npm ci --ignore-scripts --no-audit --no-fund", "npm test"]);
    // The engine's key stays with the engine: the repository's scripts never see it.
    expect(envs.every((e) => !("ANTHROPIC_API_KEY" in e) && e.CI === "1")).toBe(true);
    // The diff was captured before the tests ran.
    expect(board.artifacts.find((a) => a.kind === "diff")?.content).toContain("+++ b/notes.md");
    expect(board.shipped.some((e) => e.type === "check")).toBe(true);
  });
});

describe("fitCompletion", () => {
  it("cuts every text field to the board's limit and leaves a valid completion valid", () => {
    const fitted = fitCompletion({
      status: "blocked",
      summary: "s".repeat(5000),
      blocker: { code: "unknown", what: "w".repeat(1200), why: "y".repeat(1200) },
      checks: [{ kind: "tests", ok: false, title: "t".repeat(300), detail: "d".repeat(25_000) }],
    });
    expect(RunCompleteSchema.safeParse(fitted).success).toBe(true);
    expect(fitted.checks?.[0]?.detail?.startsWith("…")).toBe(true);
    const fine: RunCompleteInput = { status: "completed", summary: "Done.", usage: { inputTokens: 1 } };
    expect(fitCompletion(fine)).toEqual(fine);
  });
});

describe("engineEnvironment", () => {
  it("passes only base keys and allowlisted names", () => {
    const env = engineEnvironment(["ANTHROPIC_API_KEY"], {
      PATH: "/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "k",
      DATABASE_URL: "postgres://secret",
      ROSTERDOCK_WORKER_TOKEN: "t",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "k" });
  });

  it("keeps the user's name and temp directory, without which Claude Code on macOS cannot find its sign-in", () => {
    const env = engineEnvironment([], {
      PATH: "/bin",
      HOME: "/Users/x",
      USER: "x",
      LOGNAME: "x",
      TMPDIR: "/var/folders/x/T/",
      SSH_AUTH_SOCK: "/private/tmp/agent",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/Users/x",
      USER: "x",
      LOGNAME: "x",
      TMPDIR: "/var/folders/x/T/",
    });
  });

  it("posts its half of the run's trace to the collector: workspace, engine and harvest under the board's root span", async () => {
    const board = fakeBoard(PACK(), ["vms-architecture.md", "notes.md"]);
    const posts: { url: string; headers: Record<string, string>; body: any }[] = [];
    const otlp = {
      target: {
        endpoint: "https://otel.test/v1/traces",
        headers: { "x-key": "k" },
        serviceName: "rosterdock-worker",
      },
      fetch: (async (url: any, init: any) => {
        posts.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: JSON.parse(String(init?.body)),
        });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    };
    const outcome = await executeRun({ runId: "run-1", jobId: "job-1" }, deps(board, { otlp }));
    expect(outcome.status).toBe("completed");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://otel.test/v1/traces");
    expect(posts[0]!.headers["x-key"]).toBe("k");
    const rs = posts[0]!.body.resourceSpans[0];
    expect(rs.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "rosterdock-worker" } },
      { key: "rosterdock.worker_id", value: { stringValue: "test-worker" } },
    ]);
    const spans = rs.scopeSpans[0].spans as any[];
    expect(spans.map((s) => s.name)).toEqual(["workspace", "engine stub", "harvest"]);
    expect(spans.every((s) => s.traceId === traceIdForRun("run-1"))).toBe(true);
    expect(spans.every((s) => s.parentSpanId === runRootSpanId("run-1"))).toBe(true);
    expect(spans.every((s) => s.status.code === 1)).toBe(true);
    expect(spans[1].attributes).toEqual([
      { key: "rosterdock.engine", value: { stringValue: "stub" } },
      { key: "rosterdock.model", value: { stringValue: "stub" } },
    ]);
    // A collector that is down costs nothing but a warning.
    const warnings: string[] = [];
    const down = {
      ...otlp,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    };
    const again = await executeRun(
      { runId: "run-1", jobId: "job-1" },
      deps(fakeBoard(PACK(), []), { otlp: down, log: { info: () => {}, warn: (m) => warnings.push(m) } }),
    );
    expect(again.status).toBe("completed");
    expect(warnings.some((w) => w.includes("trace not exported"))).toBe(true);
  });
});
