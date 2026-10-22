// Workspace against a local bare repository: no network.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyFilePatch, parseUnifiedDiff, renderNewFileDiff } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupWorkspace,
  fitDiff,
  git,
  gitEnvironment,
  harvestWorkspace,
  prepareWorkspace,
  type Harvest,
  redactGit,
  withToken,
} from "../src/workspace.js";
import { skipWithoutSymlinks } from "./helpers.js";

/** A path as a shell command or a git config value takes it on every platform: with forward slashes. */
const forShell = (p: string) => p.split(path.sep).join("/");

let root: string;
let bare: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rosterdock-ws-"));
  const src = path.join(root, "src");
  bare = path.join(root, "origin.git");
  await (await import("node:fs/promises")).mkdir(src, { recursive: true });
  const env = {
    // An identity only: never the caller's environment, which under a rebase or a hook points at this repository.
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  expect((await git(["init", "-b", "main"], src, env)).code).toBe(0);
  await writeFile(path.join(src, "README.md"), "# demo\n", "utf8");
  await git(["add", "."], src, env);
  expect((await git(["commit", "-m", "init"], src, env)).code).toBe(0);
  expect((await git(["clone", "--bare", src, bare], root, env)).code).toBe(0);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace", () => {
  it("clones a repository, harvests declared outputs, handover and the diff, then cleans up", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-1",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    expect(ws.repo).toBe(true);
    await writeFile(path.join(ws.dir, "README.md"), "# demo\n\nchanged\n", "utf8");
    await writeFile(path.join(ws.dir, "notes.md"), "notes\n", "utf8");
    await writeFile(
      path.join(ws.dir, "handover-summary.md"),
      "Changed the readme and added notes.\n",
      "utf8",
    );
    const h = await harvestWorkspace(ws, ["notes.md", "missing.md"]);
    expect(h.filesWritten).toEqual(["notes.md"]);
    expect(h.missingOutputs).toEqual(["missing.md"]);
    expect(h.handover).toBe("Changed the readme and added notes.");
    expect(h.blocked).toBeNull();
    const paths = h.artifacts.map((a) => a.path);
    expect(paths).toEqual(["notes.md", "handover-summary.md", "changes.diff"]);
    const diff = h.artifacts.find((a) => a.kind === "diff")!;
    expect(diff.content).toContain("+changed");
    expect(diff.content).toContain("+notes");
    expect(diff.content).not.toContain("handover-summary.md");
    expect(h.baseSha).toMatch(/^[0-9a-f]{40}$/);
    await cleanupWorkspace(ws);
    const { existsSync } = await import("node:fs");
    expect(existsSync(ws.dir)).toBe(false);
  });

  it("without declared outputs, harvests new and modified files; without a repo, top-level files", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-2",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "new.txt"), "x\n", "utf8");
    await rm(path.join(ws.dir, "README.md"));
    const h = await harvestWorkspace(ws, []);
    expect(h.filesWritten).toEqual(["new.txt"]);
    // Deletions are part of the diff even though there is no file to harvest.
    const diff = h.artifacts.find((a) => a.kind === "diff")!;
    expect(diff.content).toContain("deleted file mode");
    expect(diff.content).toContain("-# demo");
    await cleanupWorkspace(ws);

    const empty = await prepareWorkspace(
      path.join(root, "work"),
      "run-3",
      { repoUrl: null, defaultBranch: "main" },
      null,
    );
    expect(empty.repo).toBe(false);
    await writeFile(path.join(empty.dir, "a.md"), "a\n", "utf8");
    await writeFile(path.join(empty.dir, "blocked.md"), "Waiting on @ricky.\n", "utf8");
    const h2 = await harvestWorkspace(empty, []);
    expect(h2.filesWritten).toEqual(["a.md"]);
    expect(h2.blocked).toBe("Waiting on @ricky.");
    expect(h2.baseSha).toBeNull();
    // No repository: the diff adds every harvested file, so the review looks the same.
    const synthetic = h2.artifacts.find((a) => a.kind === "diff")!;
    expect(synthetic.content).toContain("+++ b/a.md");
    expect(synthetic.content).toContain("+a");
    expect(synthetic.content).not.toContain("blocked.md");
    await cleanupWorkspace(empty);
  });

  it("skips a file over the cap and cuts the diff at it; the board's cap from the run spec raises both", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-big",
      { repoUrl: null, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "big.csv"), "row\n".repeat(160 * 1024), "utf8"); // 640 KB
    await writeFile(path.join(ws.dir, "small.md"), "small\n", "utf8");
    const inline = await harvestWorkspace(ws, ["big.csv", "small.md"]);
    expect(inline.filesWritten).toEqual(["small.md"]);
    expect(inline.missingOutputs).toEqual(["big.csv"]);
    const raised = await harvestWorkspace(ws, ["big.csv", "small.md"], { maxArtifactBytes: 8 * 1024 * 1024 });
    expect(raised.filesWritten).toEqual(["big.csv", "small.md"]);
    expect(raised.missingOutputs).toEqual([]);
    const diff = raised.artifacts.find((a) => a.kind === "diff")!;
    expect(diff.content.length).toBeGreaterThan(512 * 1024);
    expect(diff.content).toContain("+++ b/small.md");
    await cleanupWorkspace(ws);
  });

  it("keeps the diff within the board's limit in bytes and in whole files, naming what it leaves out", () => {
    // 3,000 é is 3,000 characters and 6,000 bytes: over a 4,000-byte limit, though not by characters.
    const diff = [
      renderNewFileDiff("a.md", "first\n"),
      renderNewFileDiff("accents.md", `${"é".repeat(3000)}\n`),
      renderNewFileDiff("c.md", "last\n"),
    ].join("");
    const fitted = fitDiff(diff, 4000);
    expect(fitted.omitted).toEqual(["accents.md"]);
    expect(Buffer.byteLength(fitted.text, "utf8")).toBeLessThanOrEqual(4000);
    const files = parseUnifiedDiff(fitted.text);
    expect(files.map((f) => f.path)).toEqual(["a.md", "c.md"]);
    // What is left applies whole.
    expect(files.map((f) => applyFilePatch(null, f))).toEqual(["first\n", "last\n"]);
    expect(fitDiff(diff, 1_000_000)).toEqual({ text: diff, omitted: [] });
  });

  it("leaves a changed file that does not fit out of a repository's diff instead of cutting it", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-fit",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "README.md"), "# demo\n\nchanged\n", "utf8");
    await writeFile(path.join(ws.dir, "long.md"), "a long line of notes\n".repeat(200), "utf8");
    const h = await harvestWorkspace(ws, ["README.md"], { maxArtifactBytes: 2000 });
    expect(h.diffOmitted).toEqual(["long.md"]);
    const files = parseUnifiedDiff(h.artifacts.find((a) => a.kind === "diff")!.content);
    expect(files.map((f) => f.path)).toEqual(["README.md"]);
    expect(applyFilePatch("# demo\n", files[0]!)).toBe("# demo\n\nchanged\n");
    await cleanupWorkspace(ws);
  });

  it("harvests a binary file as base64 and puts a binary stanza in the diff", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-bin",
      { repoUrl: null, defaultBranch: "main" },
      null,
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    await writeFile(path.join(ws.dir, "logo.bin"), png);
    await writeFile(path.join(ws.dir, "notes.md"), "# notes\n", "utf8");
    const h = await harvestWorkspace(ws, ["logo.bin", "notes.md"]);
    expect(h.filesWritten).toEqual(["logo.bin", "notes.md"]);
    expect(h.missingOutputs).toEqual([]);
    expect(h.artifacts.find((a) => a.path === "logo.bin")).toEqual({
      path: "logo.bin",
      kind: "file",
      content: png.toString("base64"),
      encoding: "base64",
    });
    expect(h.artifacts.find((a) => a.path === "notes.md")).toMatchObject({
      kind: "document",
      encoding: "utf8",
    });
    const diff = h.artifacts.find((a) => a.kind === "diff")!.content;
    expect(diff).toContain("Binary files /dev/null and b/logo.bin differ");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.binary, f.status])).toEqual([
      ["logo.bin", true, "added"],
      ["notes.md", false, "added"],
    ]);
    await cleanupWorkspace(ws);
  });

  it("reads git output as a stream, so a character on a pipe boundary arrives whole", async () => {
    // Over half a megabyte of multibyte text: the pipe hands it over in chunks that split characters.
    const content = "a — ✅ 😀 ü\n".repeat(30_000);
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-utf8",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "big.txt"), content, "utf8");
    expect((await git(["add", "big.txt"], ws.dir)).code).toBe(0);
    const out = await git(["show", ":big.txt"], ws.dir);
    expect(out.stdout.includes("\ufffd")).toBe(false);
    expect(out.stdout).toBe(content);
    await cleanupWorkspace(ws);
  });

  it("runs git with none of the worker's credentials and no system or global config", () => {
    const env = gitEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      DATABASE_URL: "postgres://board",
      ROSTERDOCK_WORKER_TOKEN: "fleet-token",
      ROSTERDOCK_GIT_TOKEN: "git-token",
      ANTHROPIC_API_KEY: "model-key",
      OTEL_EXPORTER_OTLP_HEADERS: "x-key=v",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      // Git for Windows reads /dev/null as its NUL device too.
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
  });

  it("runs the git on PATH, never one the run left in its directory", async () => {
    // Windows looks for a program in the directory it starts in before PATH, unless told not to.
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-own-git",
      { repoUrl: null, defaultBranch: "main" },
      null,
    );
    if (process.platform === "win32") {
      // Any program will do as the impostor: a small one every Windows has.
      const windows = process.env.SystemRoot ?? "C:\\Windows";
      await copyFile(path.join(windows, "System32", "whoami.exe"), path.join(ws.dir, "git.exe"));
    } else {
      await writeFile(path.join(ws.dir, "git"), "#!/bin/sh\necho not git\n", { mode: 0o755 });
    }
    const res = await git(["--version"], ws.dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^git version /);
    await cleanupWorkspace(ws);
  });

  it("never lets an inherited GIT_DIR, work tree, index or -c config point git at another repository", async () => {
    // What `git rebase -x` or a hook hands its commands: the outer repository's location and config.
    const outer = {
      GIT_DIR: path.join(bare),
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: path.join(root, "outer-index"),
      GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
    };
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-outer-env",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    const where = await git(
      ["rev-parse", "--absolute-git-dir", "--show-toplevel", "--is-bare-repository"],
      ws.dir,
      outer,
    );
    // git writes paths with forward slashes on Windows too.
    const [gitDir, top, isBare] = where.stdout.trim().split("\n");
    expect([path.resolve(gitDir!), path.resolve(top!), isBare]).toEqual([
      path.join(await realpath(ws.dir), ".git"),
      await realpath(ws.dir),
      "false",
    ]);
    expect(existsSync(path.join(root, "outer-index"))).toBe(false);
    await cleanupWorkspace(ws);
  });

  it("runs nothing the run wrote into .git when it reads the changes back", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-gitconfig",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    const marker = (name: string) => path.join(root, `${name}-ran`);
    // What a run with write access could leave: its own config (behind a symlink, even) with a filter,
    // a textconv and an fsmonitor, and an attribute that points every Markdown file at them.
    const evil = path.join(root, "evil-config");
    const evilConfig =
      (await readFile(path.join(ws.dir, ".git", "config"), "utf8")) +
      `[core]\n\tfsmonitor = "touch '${forShell(marker("fsmonitor"))}'; false"\n` +
      `[filter "evil"]\n\tclean = "touch '${forShell(marker("filter"))}'; cat"\n` +
      `[diff "evil"]\n\ttextconv = "touch '${forShell(marker("textconv"))}'; cat"\n`;
    await writeFile(evil, evilConfig, "utf8");
    await rm(path.join(ws.dir, ".git", "config"));
    await symlink(evil, path.join(ws.dir, ".git", "config"));
    await writeFile(path.join(ws.dir, ".gitattributes"), "*.md filter=evil diff=evil\n", "utf8");
    await writeFile(path.join(ws.dir, "README.md"), "# demo\n\nchanged\n", "utf8");
    const h = await harvestWorkspace(ws, []);
    expect(h.artifacts.find((a) => a.kind === "diff")?.content).toContain("+changed");
    for (const name of ["fsmonitor", "filter", "textconv"])
      expect(existsSync(marker(name)), name).toBe(false);
    // The config is the clone's again, a plain file, and what the symlink pointed at is untouched.
    expect((await lstat(path.join(ws.dir, ".git", "config"))).isSymbolicLink()).toBe(false);
    expect(await readFile(evil, "utf8")).toBe(evilConfig);
    await cleanupWorkspace(ws);
  });

  it("runs no hook the run left in .git when it reads the changes back", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-hook",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    // git runs post-index-change whenever it writes the index, as the harvest's `git add` does.
    const marker = path.join(root, "hook-ran");
    await mkdir(path.join(ws.dir, ".git", "hooks"), { recursive: true });
    await writeFile(
      path.join(ws.dir, ".git", "hooks", "post-index-change"),
      `#!/bin/sh\necho ran > '${forShell(marker)}'\n`,
      { mode: 0o755 },
    );
    await writeFile(path.join(ws.dir, "README.md"), "# demo\n\nchanged\n", "utf8");
    // git without the worker's settings runs it, so the hook works here and the check below means something.
    const plain = spawnSync("git", ["add", "README.md"], { cwd: ws.dir, env: gitEnvironment() });
    expect(plain.status, plain.stderr.toString()).toBe(0);
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
    const h = await harvestWorkspace(ws, []);
    expect(h.artifacts.find((a) => a.kind === "diff")?.content).toContain("+changed");
    expect(existsSync(marker)).toBe(false);
    await cleanupWorkspace(ws);
  });

  it("refuses to read back a checkout whose .git the run replaced", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-gitfile",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await rm(path.join(ws.dir, ".git"), { recursive: true, force: true });
    await writeFile(path.join(ws.dir, ".git"), `gitdir: ${path.join(root, "elsewhere")}\n`, "utf8");
    await expect(harvestWorkspace(ws, [])).rejects.toThrow(/replaced the repository's .git/);
    await cleanupWorkspace(ws);
  });

  it("fails clearly on a bad repository without leaking a token", async () => {
    await expect(
      prepareWorkspace(
        path.join(root, "work"),
        "run-4",
        { repoUrl: path.join(root, "nope.git"), defaultBranch: "main" },
        { token: "tok", hosts: ["github.com"] },
      ),
    ).rejects.toThrow(/git clone failed/);
  });

  it("injects the token into https URLs on its own hosts only and redacts it from messages", () => {
    const github = { token: "abc", hosts: ["github.com"] };
    expect(withToken("https://github.com/o/r.git", github)).toBe(
      "https://x-access-token:abc@github.com/o/r.git",
    );
    expect(withToken("https://GitHub.com/o/r.git", github)).toBe(
      "https://x-access-token:abc@github.com/o/r.git",
    );
    expect(withToken("git@github.com:o/r.git", github)).toBe("git@github.com:o/r.git");
    expect(withToken("https://u@github.com/o/r.git", github)).toBe("https://u@github.com/o/r.git");
    // Any other host clones without it: a look-alike name, a subdomain, another port, plain http.
    for (const url of [
      "https://git.example.com/o/r.git",
      "https://github.com.example.com/o/r.git",
      "https://api.github.com/o/r.git",
      "https://github.com:8443/o/r.git",
      "http://github.com/o/r.git",
    ])
      expect(withToken(url, github), url).toBe(url);
    expect(
      withToken("https://git.example.com:8443/o/r.git", { token: "abc", hosts: ["git.example.com:8443"] }),
    ).toBe("https://x-access-token:abc@git.example.com:8443/o/r.git");
    expect(withToken("https://github.com/o/r.git", null)).toBe("https://github.com/o/r.git");
    expect(redactGit("fatal: https://x-access-token:abc@github.com/o/r.git not found")).toBe(
      "fatal: https://***@github.com/o/r.git not found",
    );
  });
});

describe("the harvest never reads through a link", () => {
  // A file the worker can read and the company must not: outside every run's directory, like /proc/self/environ.
  const SECRET = "ROSTERDOCK_WORKER_TOKEN=hunter2";
  let outside: string;
  beforeAll(async () => {
    outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "environ"), `${SECRET}\n`, "utf8");
  });

  const leaks = (h: Harvest) =>
    [h.handover, h.blocked, ...h.artifacts.map((a) => Buffer.from(a.content, a.encoding).toString("utf8"))]
      .join("\n")
      .includes("hunter2");

  it("refuses declared outputs that are links, inside or outside the workspace, or reached through one", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-links",
      { repoUrl: null, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "notes.md"), "notes\n", "utf8");
    await mkdir(path.join(ws.dir, "docs"));
    await writeFile(path.join(ws.dir, "docs", "a.md"), "a\n", "utf8");
    await symlink(path.join(outside, "environ"), path.join(ws.dir, "report.md")); // a file outside
    await symlink("notes.md", path.join(ws.dir, "alias.md")); // a file inside
    await symlink(outside, path.join(ws.dir, "linked")); // a directory outside
    await symlink("docs", path.join(ws.dir, "docs-link")); // a directory inside
    await symlink(path.join(outside, "environ"), path.join(ws.dir, "handover-summary.md"));
    const declared = [
      "notes.md",
      "report.md",
      "alias.md",
      "linked/environ",
      "docs-link/a.md",
      "../../outside/environ",
    ];
    const h = await harvestWorkspace(ws, declared);
    expect(h.filesWritten).toEqual(["notes.md"]);
    expect(h.refusedOutputs).toEqual([
      "handover-summary.md",
      "report.md",
      "alias.md",
      "linked/environ",
      "docs-link/a.md",
      "../../outside/environ",
    ]);
    expect(h.missingOutputs).toEqual([]);
    expect(h.handover).toBeNull();
    expect(h.artifacts.map((a) => a.path)).toEqual(["notes.md", "changes.diff"]);
    expect(leaks(h)).toBe(false);
    await cleanupWorkspace(ws);
    // Removing the workspace removes the links, never what they point at.
    expect(existsSync(path.join(outside, "environ"))).toBe(true);
  });

  it("without declared outputs, refuses the links a run left in a repository; the diff holds only their targets", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-repo-links",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "new.md"), "new\n", "utf8");
    await symlink(path.join(outside, "environ"), path.join(ws.dir, "leak.txt"));
    await symlink(outside, path.join(ws.dir, "linked"));
    await symlink(path.join(outside, "environ"), path.join(ws.dir, "blocked.md"));
    const h = await harvestWorkspace(ws, []);
    expect(h.filesWritten).toEqual(["new.md"]);
    expect([...h.refusedOutputs].sort()).toEqual(["blocked.md", "leak.txt", "linked"]);
    expect(h.missingOutputs).toEqual([]);
    expect(h.blocked).toBeNull();
    const diff = h.artifacts.find((a) => a.kind === "diff")!.content;
    expect(diff).toContain("new file mode 120000");
    expect(leaks(h)).toBe(false);
    await cleanupWorkspace(ws);
  });
});
