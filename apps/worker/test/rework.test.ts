// A rework run starts from the round sent back, replayed from a recorded review: task #6 of the
// dogfood company (fixtures/rework in @rosterdock/shared), its round 1 diff on the base it was taken
// against, and the same base after round 2's change landed on main. Local repositories, no network.
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff, sha256Hex, type DiffFile } from "@rosterdock/shared";
import type { RunArtifactInput, RunCompleteInput, RunEventInput } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoardClient, ClaimedRun } from "../src/board-client.js";
import type { EngineAdapter } from "../src/engines/types.js";
import { applyPreviousRound, whyNotApplied, type Rework } from "../src/rework.js";
import { executeRun, type RunDeps } from "../src/run.js";
import { git, GIT_NO_CONFIG, prepareWorkspace } from "../src/workspace.js";
import { skipWithoutSymlinks } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../../../packages/shared/test/fixtures");
const BASE = JSON.parse(readFileSync(path.join(fixtures, "rework/base.json"), "utf8")) as Record<
  string,
  string
>;
const ROUND_1 = readFileSync(path.join(fixtures, "rework/round-1.diff"), "utf8");
const ROUND_2 = readFileSync(path.join(fixtures, "rework/round-2.diff"), "utf8");

// One of the reviewer's round 1 comments, fixed the way round 2 fixed it.
const ROUND_1_ALT =
  "![The board of the Lighthouse demo company: teammates' tasks to do, in progress, blocked on a teammate, in review and done](docs/images/board.png)";
const FIXED_ALT =
  "![The board of the Lighthouse demo company, with teammates' tasks in columns](docs/images/board.png)";

// Never the caller's environment: a GIT_DIR exported by a rebase or a hook would point these at this repository.
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: GIT_NO_CONFIG,
};

let root: string;
let baseRepo: string;
let movedRepo: string;
let baseSha: string;
let movedSha: string;

async function run(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd, GIT_ENV);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text, "utf8");
  }
}

/** Whether `diff` applies to a fresh clone of `repo`: what the pull request needs of the next round. */
async function appliesTo(repo: string, diff: string, name: string): Promise<boolean> {
  const dir = path.join(root, `check-${name}`);
  await run(["clone", "--quiet", repo, dir], root);
  await writeFile(path.join(root, `${name}.diff`), diff, "utf8");
  return (await git(["apply", "--check", path.join(root, `${name}.diff`)], dir, GIT_ENV)).code === 0;
}

/** Per file: its status and the lines it adds and removes, which do not depend on git's hunk layout. */
function changes(files: DiffFile[]) {
  return files.map((f) => ({
    path: f.path,
    status: f.status,
    added: f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text)),
    removed: f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "del").map((l) => l.text)),
  }));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rosterdock-rework-"));
  const src = path.join(root, "src");
  await mkdir(src, { recursive: true });
  await run(["init", "--quiet", "-b", "main"], src);
  await writeTree(src, BASE);
  await run(["add", "."], src);
  await run(["commit", "--quiet", "-m", "base"], src);
  baseSha = await run(["rev-parse", "HEAD"], src);
  baseRepo = path.join(root, "base.git");
  await run(["clone", "--quiet", "--bare", src, baseRepo], root);
  // main moves on: round 2's change lands, touching every file round 1 touched.
  await writeFile(path.join(root, "round-2.diff"), ROUND_2, "utf8");
  await run(["apply", path.join(root, "round-2.diff")], src);
  await run(["add", "-A"], src);
  await run(["commit", "--quiet", "-m", "moved"], src);
  movedSha = await run(["rev-parse", "HEAD"], src);
  movedRepo = path.join(root, "moved.git");
  await run(["clone", "--quiet", "--bare", src, movedRepo], root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const round1: () => Rework = () => ({ round: 1, diffSha256: sha256Hex(ROUND_1), baseSha, diff: ROUND_1 });

interface Seen {
  status: string;
  readme: string;
  pack: string;
}

/** An engine that looks at its working directory, then fixes the alt text the way round 2 did. */
function fixingEngine(seen: Seen[], fix = true): EngineAdapter {
  return {
    id: "stub",
    async run(ctx) {
      const readme = await readFile(path.join(ctx.workdir, "README.md"), "utf8");
      seen.push({
        status: (await git(["status", "--porcelain"], ctx.workdir, GIT_ENV)).stdout,
        readme,
        pack: ctx.pack,
      });
      if (fix) {
        const fixed = readme.includes(ROUND_1_ALT)
          ? readme.replace(ROUND_1_ALT, FIXED_ALT)
          : `${readme}\nA change made again.\n`;
        await writeFile(path.join(ctx.workdir, "README.md"), fixed, "utf8");
      }
      await writeFile(path.join(ctx.workdir, "handover-summary.md"), "Fixed the alt text.\n", "utf8");
      return { ok: true, exitCode: 0, usage: {}, resultText: null };
    },
  };
}

function fakeBoard(repoUrl: string, rework: Rework | null, declaredOutputs: string[] = []) {
  const out = {
    shipped: [] as RunEventInput[],
    artifacts: [] as RunArtifactInput[],
    completion: null as RunCompleteInput | null,
  };
  const claimed: ClaimedRun = {
    run: {
      id: "run-rework",
      taskId: "task-6",
      teammateId: "wren",
      engine: "stub",
      model: "stub",
      attempt: 1,
      status: "running",
    },
    token: "run-token",
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    pack: "# README landing page\n\n## Changes requested (review round 1)\n\n## Completion\nStop.\n",
    spec: {
      runId: "run-rework",
      attempt: 1,
      task: { id: "task-6", number: 6, title: "README landing page", description: "", declaredOutputs },
      project: { repoUrl, defaultBranch: "main", name: "RosterDock" },
      teammate: { name: "Wren", handle: "wren", model: "stub", engine: "stub" },
      sandbox: { allowedTools: null, envNames: null, timeoutSeconds: 3600 },
      checkpoint: null,
      rework,
    },
  };
  const board: BoardClient = {
    claim: async () => claimed,
    heartbeat: async () => ({ stopRequested: false }),
    events: async (_t, _r, evs) => void out.shipped.push(...evs),
    checkpoint: async () => {},
    artifact: async (_t, _r, a) => void out.artifacts.push(a),
    complete: async (_t, _r, c) => void (out.completion = c),
  };
  return { board, out };
}

function deps(board: BoardClient, engine: EngineAdapter, name: string): RunDeps {
  return {
    board,
    engines: { stub: engine },
    workRoot: path.join(root, `work-${name}`),
    workerId: "test-worker",
    heartbeatMs: 10_000,
    engineEnv: {},
    boardUrl: "http://board.test",
    gitCredential: null,
    repoTests: null,
    shutdown: new AbortController().signal,
    log: { info: () => {}, warn: () => {} },
  };
}

describe("a rework run", () => {
  it("starts from the round sent back, and its diff is still the whole change against the base", async () => {
    const seen: Seen[] = [];
    const { board, out } = fakeBoard(baseRepo, round1());
    await executeRun({ runId: "run-rework", jobId: "job" }, deps(board, fixingEngine(seen), "applied"));

    // The engine found round 1 in its clone, uncommitted, and the brief as the board wrote it.
    expect(seen[0]!.readme).toContain(ROUND_1_ALT);
    expect(seen[0]!.status.split("\n").filter(Boolean).sort()).toEqual([
      " M README.md",
      " M docs/install.md",
      " M docs/releasing.md",
      "?? docs/README.md",
    ]);
    expect(seen[0]!.pack).not.toContain("## Starting point");
    expect(out.shipped).toContainEqual(
      expect.objectContaining({
        type: "step",
        payload: { text: "starting from round 1's changes (4 files)" },
      }),
    );

    expect(out.completion).toMatchObject({
      status: "completed",
      summary: "Fixed the alt text.",
      baseSha,
      rework: { round: 1, applied: true },
    });
    const diff = out.artifacts.find((a) => a.kind === "diff")!.content;
    // Round 2 holds round 1's change with the fix in it, taken against the same base: the review's
    // hunks and the pull request come from a diff that applies to main as it is.
    expect(await appliesTo(baseRepo, diff, "applied")).toBe(true);
    const next = changes(parseUnifiedDiff(diff));
    const before = changes(parseUnifiedDiff(ROUND_1));
    expect(next.map((f) => [f.path, f.status])).toEqual(before.map((f) => [f.path, f.status]));
    const readme = next.find((f) => f.path === "README.md")!;
    expect(readme.added).toContain(FIXED_ALT);
    expect(readme.added).not.toContain(ROUND_1_ALT);
    expect(readme.added.filter((l) => l !== FIXED_ALT)).toEqual(
      before.find((f) => f.path === "README.md")!.added.filter((l) => l !== ROUND_1_ALT),
    );
    expect(next.filter((f) => f.path !== "README.md")).toEqual(before.filter((f) => f.path !== "README.md"));
    expect(existsSync(path.join(root, "work-applied", "run-rework"))).toBe(false);
  });

  it("with nothing to fix, hands back round 1's change as it was", async () => {
    const { board, out } = fakeBoard(baseRepo, round1());
    await executeRun({ runId: "run-rework", jobId: "job" }, deps(board, fixingEngine([], false), "as-was"));
    const diff = out.artifacts.find((a) => a.kind === "diff")!.content;
    expect(changes(parseUnifiedDiff(diff))).toEqual(changes(parseUnifiedDiff(ROUND_1)));
  });

  it("starts from a fresh clone when main moved and the round no longer applies, and says so", async () => {
    const seen: Seen[] = [];
    const { board, out } = fakeBoard(movedRepo, round1());
    await executeRun({ runId: "run-rework", jobId: "job" }, deps(board, fixingEngine(seen), "moved"));

    const reason = "README.md, docs/README.md, docs/install.md and 1 more changed on main since round 1";
    // A clean clone of the moved main, and a brief that says why.
    expect(seen[0]!.status).toBe("");
    expect(seen[0]!.readme).toContain(FIXED_ALT);
    expect(seen[0]!.pack).toMatch(
      new RegExp(
        `## Completion\\nStop\\.\\n\\n\\n## Starting point\\nRound 1's changes did not carry over: ${reason}\\. Your working directory is a clean clone of the current main, without them\\.`,
      ),
    );
    expect(out.shipped).toContainEqual(
      expect.objectContaining({
        type: "stderr",
        payload: {
          text: `round 1's changes did not carry over: ${reason}; starting from a fresh clone of main`,
        },
      }),
    );
    // The run's handover leads with it, and the board is told, to say it on the task.
    expect(out.completion).toMatchObject({
      status: "completed",
      summary: `Started from a fresh copy of main: round 1's changes did not carry over (${reason}). Fixed the alt text.`,
      baseSha: movedSha,
      rework: { round: 1, applied: false, reason },
    });
    // The change made again is taken against main as it is now.
    const diff = out.artifacts.find((a) => a.kind === "diff")!.content;
    expect(await appliesTo(movedRepo, diff, "moved")).toBe(true);
    expect(parseUnifiedDiff(diff).map((f) => f.path)).toEqual(["README.md"]);
  });

  it("applies nothing that does not match the sha256 the review recorded", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work-sha"),
      "run-sha",
      { repoUrl: baseRepo, defaultBranch: "main" },
      null,
    );
    const tampered = { ...round1(), diff: ROUND_1.replace(ROUND_1_ALT, FIXED_ALT) };
    expect(await applyPreviousRound(ws, tampered, "main")).toEqual({
      round: 1,
      applied: false,
      reason: "the changes the board sent do not match its record of round 1",
    });
    expect((await git(["status", "--porcelain"], ws.dir, GIT_ENV)).stdout).toBe("");
  });

  it("says a binary file is why, since the review's diff carries no bytes for it", async () => {
    // The recorded diff of the review tests: a binary stanza among text changes, on its recorded base.
    const diff = readFileSync(path.join(fixtures, "changes.diff"), "utf8");
    const base = JSON.parse(readFileSync(path.join(fixtures, "diff-base.json"), "utf8")) as Record<
      string,
      string | null
    >;
    const src = path.join(root, "binary-src");
    await mkdir(src, { recursive: true });
    await run(["init", "--quiet", "-b", "main"], src);
    await writeTree(
      src,
      Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== null)),
    );
    await writeFile(path.join(src, "logo.bin"), Buffer.from([0, 1, 2]));
    await run(["add", "."], src);
    await run(["commit", "--quiet", "-m", "base"], src);
    const ws = await prepareWorkspace(
      path.join(root, "work-bin"),
      "run-bin",
      { repoUrl: src, defaultBranch: "main" },
      null,
    );
    const start = await applyPreviousRound(
      ws,
      { round: 2, diffSha256: sha256Hex(diff), baseSha: await run(["rev-parse", "HEAD"], src), diff },
      "main",
    );
    expect(start).toEqual({
      round: 2,
      applied: false,
      reason: "logo.bin is a binary file, which the review's diff does not carry",
    });
    expect((await git(["status", "--porcelain"], ws.dir, GIT_ENV)).stdout).toBe("");
  });

  it("quotes git when it names no file", () => {
    expect(whyNotApplied("error: corrupt patch at line 12\n", 1, "main", false)).toBe(
      "git could not apply them (corrupt patch at line 12)",
    );
  });
});

describe("a rework run and links", () => {
  const SECRET = "ROSTERDOCK_WORKER_TOKEN=not-for-the-board";
  let outside: string;
  let secretFile: string;

  beforeAll(async () => {
    outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    secretFile = path.join(root, "secret.env");
    await writeFile(secretFile, `${SECRET}\n`, "utf8");
  });

  /** A round as the harvest takes it: a clone of the base, changed by `change`, staged and diffed. */
  async function recordRound(name: string, change: (dir: string) => Promise<void>): Promise<string> {
    const dir = path.join(root, `record-${name}`);
    await run(["clone", "--quiet", baseRepo, dir], root);
    await change(dir);
    await run(["add", "-A"], dir);
    return (await git(["diff", "--cached", "--no-color", "--no-renames", "--no-ext-diff"], dir, GIT_ENV))
      .stdout;
  }

  const roundOf = (diff: string): Rework => ({ round: 1, diffSha256: sha256Hex(diff), baseSha, diff });

  /** Git for Windows' own defaults, which a clone there takes by itself: no symlinks, no executable bit. */
  async function asOnWindows(dir: string): Promise<void> {
    for (const key of ["core.symlinks", "core.filemode"])
      expect((await git(["config", key, "false"], dir, GIT_ENV)).code).toBe(0);
  }

  it("never carries a link over: a round that leaves one is undone, and the clone is as it was", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    const diff = await recordRound("links", async (dir) => {
      await symlink(secretFile, path.join(dir, "report.md"));
      await rm(path.join(dir, "README.md"));
      await symlink(secretFile, path.join(dir, "README.md"));
    });
    expect(diff).toContain("new file mode 120000");
    const ws = await prepareWorkspace(
      path.join(root, "work-links"),
      "run-links",
      { repoUrl: baseRepo, defaultBranch: "main" },
      null,
    );
    expect(await applyPreviousRound(ws, roundOf(diff), "main")).toEqual({
      round: 1,
      applied: false,
      reason: "README.md, report.md are symbolic links, which a rework run does not carry over",
    });
    expect((await git(["status", "--porcelain", "--ignored"], ws.dir, GIT_ENV)).stdout).toBe("");
    expect((await lstat(path.join(ws.dir, "README.md"))).isFile()).toBe(true);
    expect(await readFile(path.join(ws.dir, "README.md"), "utf8")).toBe(BASE["README.md"]);
    expect(existsSync(path.join(ws.dir, "report.md"))).toBe(false);
    expect(await readFile(secretFile, "utf8")).toBe(`${SECRET}\n`);
  });

  it("refuses a link that git writes as a plain file, as git on Windows does", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    const diff = await recordRound("plain-link", async (dir) =>
      symlink(secretFile, path.join(dir, "report.md")),
    );
    const ws = await prepareWorkspace(
      path.join(root, "work-plain-link"),
      "run-plain-link",
      { repoUrl: baseRepo, defaultBranch: "main" },
      null,
    );
    // Git for Windows' own defaults, without the system config the worker never reads.
    await asOnWindows(ws.dir);
    expect(await applyPreviousRound(ws, roundOf(diff), "main")).toEqual({
      round: 1,
      applied: false,
      reason: "report.md is a symbolic link, which a rework run does not carry over",
    });
    expect((await git(["status", "--porcelain", "--ignored"], ws.dir, GIT_ENV)).stdout).toBe("");
  });

  it("refuses a round that points a committed link elsewhere, where git writes links as plain files", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    // A repository with a link in it, l -> a.
    const src = path.join(root, "link-src");
    await mkdir(src, { recursive: true });
    await run(["init", "--quiet", "-b", "main"], src);
    await writeFile(path.join(src, "a"), "a\n", "utf8");
    await symlink("a", path.join(src, "l"));
    await run(["add", "."], src);
    await run(["commit", "--quiet", "-m", "a link"], src);
    const repo = path.join(root, "link.git");
    await run(["clone", "--quiet", "--bare", src, repo], root);
    // Round 1 points it at a secret, recorded as the harvest records it: an index line, no mode line.
    const record = path.join(root, "record-retarget");
    await run(["clone", "--quiet", repo, record], root);
    await rm(path.join(record, "l"));
    await symlink(secretFile, path.join(record, "l"));
    await run(["add", "-A"], record);
    const diff = (
      await git(["diff", "--cached", "--no-color", "--no-renames", "--no-ext-diff"], record, GIT_ENV)
    ).stdout;
    expect(diff).toMatch(/^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/m);
    expect(diff).not.toMatch(/^(?:new file mode|new mode|old mode)/m);
    const ws = await prepareWorkspace(
      path.join(root, "work-retarget"),
      "run-retarget",
      { repoUrl: repo, defaultBranch: "main" },
      null,
    );
    const l = path.join(ws.dir, "l");
    if (process.platform === "win32") {
      // What Git for Windows does by itself: the link checked out as a plain file, no executable bit trusted.
      expect((await git(["config", "core.filemode"], ws.dir, GIT_ENV)).stdout.trim()).toBe("false");
    } else {
      // The same here: Git for Windows' defaults, and the link checked out again under them.
      await asOnWindows(ws.dir);
      await rm(l);
      expect((await git(["checkout", "--", "l"], ws.dir, GIT_ENV)).code).toBe(0);
    }
    expect((await lstat(l)).isSymbolicLink()).toBe(false);
    expect(await applyPreviousRound(ws, roundOf(diff), "main")).toEqual({
      round: 1,
      applied: false,
      reason: "l is a symbolic link, which a rework run does not carry over",
    });
    expect((await git(["status", "--porcelain", "--ignored"], ws.dir, GIT_ENV)).stdout).toBe("");
    expect(await readFile(l, "utf8")).toBe("a");
  });

  it("writes nothing through a link: a round that puts a file behind one is refused whole", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    // Two real diffs, joined the way a run holding its token could post them: a link out of the
    // clone, then a file under the link's name.
    const link = await recordRound("escape-link", async (dir) => symlink(outside, path.join(dir, "escape")));
    const file = await recordRound("escape-file", async (dir) => {
      await mkdir(path.join(dir, "escape"));
      await writeFile(path.join(dir, "escape", "x.md"), "written outside\n", "utf8");
    });
    const ws = await prepareWorkspace(
      path.join(root, "work-escape"),
      "run-escape",
      { repoUrl: baseRepo, defaultBranch: "main" },
      null,
    );
    expect(await applyPreviousRound(ws, roundOf(link + file), "main")).toEqual({
      round: 1,
      applied: false,
      reason: "git could not apply them (affected file 'escape/x.md' is beyond a symbolic link)",
    });
    expect(await readdir(outside)).toEqual([]);
    expect((await git(["status", "--porcelain", "--ignored"], ws.dir, GIT_ENV)).stdout).toBe("");
  });

  it("delivers nothing a round's link points at: the run starts clean and no artifact holds the target", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    const diff = await recordRound("leak", async (dir) => symlink(secretFile, path.join(dir, "report.md")));
    const seen: Seen[] = [];
    const { board, out } = fakeBoard(baseRepo, roundOf(diff), ["report.md"]);
    await executeRun({ runId: "run-rework", jobId: "job" }, deps(board, fixingEngine(seen, false), "leak"));
    expect(seen[0]!.status).toBe("");
    expect(out.completion).toMatchObject({
      status: "completed",
      rework: {
        round: 1,
        applied: false,
        reason: "report.md is a symbolic link, which a rework run does not carry over",
      },
    });
    expect(out.completion!.summary).toContain("Missing declared outputs: report.md.");
    for (const a of out.artifacts) {
      expect(a.content).not.toContain(SECRET);
      expect(Buffer.from(a.content, "base64").toString("utf8")).not.toContain(SECRET);
    }
  });
});

describe("a rework run and a submodule's folder", () => {
  // A clone leaves a submodule's folder empty, and git status and git clean never look inside it. The
  // repository holds a link of its own (l -> a), which a copy or a rename could carry in there. The diffs
  // are what a run holding its token could post: the harvest diffs with --no-renames and never writes one.
  let subRepo: string;
  let subBase: string;
  const target = () => path.join(root, "secret.env");

  beforeAll(async () => {
    const src = path.join(root, "sub-src");
    await mkdir(src, { recursive: true });
    await run(["init", "--quiet", "-b", "main"], src);
    await writeTree(src, {
      "README.md": "hello\n",
      a: "a\n",
      ".gitmodules": '[submodule "sub"]\n\tpath = sub\n\turl = https://example.com/sub.git\n',
    });
    await run(["add", "."], src);
    // Committed without the OS: the link as git stores it, and the submodule as a commit id.
    await writeFile(path.join(root, "link-blob"), "a", "utf8");
    const blob = await run(["hash-object", "-w", path.join(root, "link-blob")], src);
    await run(["update-index", "--add", "--cacheinfo", `120000,${blob},l`], src);
    await run(["update-index", "--add", "--cacheinfo", `160000,${baseSha},sub`], src);
    await run(["commit", "--quiet", "-m", "base"], src);
    subBase = await run(["rev-parse", "HEAD"], src);
    subRepo = path.join(root, "sub.git");
    await run(["clone", "--quiet", "--bare", src, subRepo], root);
  });

  const subRound = (diff: string): Rework => ({
    round: 1,
    diffSha256: sha256Hex(diff),
    baseSha: subBase,
    diff,
  });
  const fresh = (name: string) =>
    prepareWorkspace(
      path.join(root, `work-${name}`),
      `run-${name}`,
      { repoUrl: subRepo, defaultBranch: "main" },
      null,
    );

  /** The clone as it was: nothing git sees, nothing in the submodule's folder, the repository's link in place. */
  async function asCloned(dir: string): Promise<void> {
    expect((await git(["status", "--porcelain", "--ignored", "-uall"], dir, GIT_ENV)).stdout).toBe("");
    expect(await readdir(path.join(dir, "sub"))).toEqual([]);
    expect(await lstat(path.join(dir, "l"))).toBeTruthy();
  }

  it("refuses a round that copies or renames a file, which would carry the repository's link into the folder", async () => {
    const copy = [
      "diff --git a/l b/sub/l",
      "similarity index 10%",
      "copy from l",
      "copy to sub/l",
      "--- a/l",
      "+++ b/sub/l",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      `+${target()}`,
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const rename = [
      "diff --git a/l b/sub/l",
      "similarity index 100%",
      "rename from l",
      "rename to sub/l",
      "",
    ].join("\n");
    for (const [name, diff] of [
      ["copy", copy],
      ["rename", rename],
    ] as const) {
      const ws = await fresh(`sub-${name}`);
      expect(await applyPreviousRound(ws, subRound(diff), "main")).toEqual({
        round: 1,
        applied: false,
        reason: "sub/l is a copy or a rename of another file, which a rework run does not carry over",
      });
      await asCloned(ws.dir);
    }
  });

  it("refuses a link a round makes inside the folder, and the undo leaves the folder empty", async () => {
    const diff = [
      "diff --git a/sub/evil b/sub/evil",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/sub/evil",
      "@@ -0,0 +1 @@",
      `+${target()}`,
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const ws = await fresh("sub-link");
    expect(await applyPreviousRound(ws, subRound(diff), "main")).toEqual({
      round: 1,
      applied: false,
      reason: "sub/evil is a symbolic link, which a rework run does not carry over",
    });
    await asCloned(ws.dir);
  });

  it("undoes what a refused round wrote into the folder, so the clean clone the brief names is one", async () => {
    const diff = [
      "diff --git a/report.md b/report.md",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/report.md",
      "@@ -0,0 +1 @@",
      `+${target()}`,
      "\\ No newline at end of file",
      "diff --git a/sub/notes.md b/sub/notes.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/sub/notes.md",
      "@@ -0,0 +1 @@",
      "+written into the submodule's folder",
      "",
    ].join("\n");
    const ws = await fresh("sub-undo");
    expect(await applyPreviousRound(ws, subRound(diff), "main")).toEqual({
      round: 1,
      applied: false,
      reason: "report.md is a symbolic link, which a rework run does not carry over",
    });
    await asCloned(ws.dir);
    expect(existsSync(path.join(ws.dir, "report.md"))).toBe(false);
  });

  it("carries over a round beside the repository's own link and submodule", async () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-hello",
      "+hello again",
      "",
    ].join("\n");
    const ws = await fresh("sub-ok");
    expect(await applyPreviousRound(ws, subRound(diff), "main")).toEqual({
      round: 1,
      applied: true,
      files: 1,
    });
    expect(await readFile(path.join(ws.dir, "README.md"), "utf8")).toBe("hello again\n");
    expect(await readdir(path.join(ws.dir, "sub"))).toEqual([]);
  });
});
