// Workspace against a local bare repository: no network.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
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
  decodeNames,
  cleanupWorkspace,
  fitDiff,
  git,
  gitReason,
  GIT_NO_CONFIG,
  gitEnvironment,
  harvestWorkspace,
  prepareWorkspace,
  type Harvest,
  redactGit,
  removalsDone,
  removeTree,
  sameFile,
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

  it("fails a run whose diff carries two names a reviewer cannot tell apart, whatever it declared", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-lookalike",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "notes.md"), "n\n", "utf8");
    await writeFile(path.join(ws.dir, "README.md"), "# demo, changed\n", "utf8");
    await writeFile(path.join(ws.dir, "\ufeffREADME.md"), "other\n", "utf8");
    const h = await harvestWorkspace(ws, ["notes.md"]);
    expect(h.filesWritten).toEqual(["notes.md"]);
    expect(h.unreadable).toBe(
      'the run\'s changes could not be read back for review (two files\' names differ only by spaces or a U+FEFF at an end: "README.md" and "\\ufeffREADME.md")',
    );
    await cleanupWorkspace(ws);
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

    // Each file once, under the name git would give it; one whose name starts with U+FEFF is another than the
    // one without.
    const odd = await prepareWorkspace(
      path.join(root, "work"),
      "run-3b",
      { repoUrl: null, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(odd.dir, "report.md"), "r\n", "utf8");
    await writeFile(path.join(odd.dir, "\ufeffnotes.md"), "b\n", "utf8");
    const listed = await harvestWorkspace(odd, []);
    expect([...listed.filesWritten].sort()).toEqual(["report.md", "\ufeffnotes.md"]);
    expect(listed.unreadable).toBeNull();
    const read = (h: typeof listed) =>
      parseUnifiedDiff(h.artifacts.find((a) => a.kind === "diff")!.content).map((f) => f.path);
    expect(read(listed).sort()).toEqual(["report.md", "\ufeffnotes.md"]);
    expect(read(await harvestWorkspace(odd, ["./report.md"]))).toEqual(["report.md"]);
    const declared = await harvestWorkspace(odd, ["./report.md", "report.md"]);
    expect(declared.filesWritten).toEqual(["./report.md", "report.md"]);
    expect(read(declared)).toEqual(["report.md"]);
    expect(declared.unreadable).toBeNull();

    // Two names a reviewer cannot tell apart, the same but for a U+FEFF or a space at an end: the run fails.
    await writeFile(path.join(odd.dir, "\ufeffreport.md"), "other\n", "utf8");
    expect((await harvestWorkspace(odd, [])).unreadable).toBe(
      'the run\'s changes could not be read back for review (two files\' names differ only by spaces or a U+FEFF at an end: "report.md" and "\\ufeffreport.md")',
    );
    await rm(path.join(odd.dir, "\ufeffreport.md"));
    // Windows drops a space at the end of a name: there it is the same file.
    if (process.platform !== "win32") {
      await writeFile(path.join(odd.dir, "report.md "), "other\n", "utf8");
      expect((await harvestWorkspace(odd, [])).unreadable).toMatch(
        /"report.md" and "report.md "|"report.md " and "report.md"/,
      );
      // However a declared output spells it.
      expect((await harvestWorkspace(odd, ["./report.md ", "report.md"])).unreadable).toMatch(
        /"report.md " and "report.md"/,
      );
      await rm(path.join(odd.dir, "report.md "));
    }

    // A file no repository holds, one named .git in any case: never delivered, and the run fails naming it.
    await writeFile(path.join(odd.dir, ".GIT"), 'aws_key = "not-a-real-value-123"\n', "utf8");
    const dotGit = await harvestWorkspace(odd, []);
    expect(dotGit.unreadable).toBe(
      "the run's changes could not be read back for review (a file's name is one no repository can hold: \".GIT\")",
    );
    expect(dotGit.filesWritten).not.toContain(".GIT");
    expect(dotGit.artifacts.map((a) => a.path)).not.toContain(".GIT");
    expect(dotGit.artifacts.some((a) => a.content.includes("not-a-real-value"))).toBe(false);
    await rm(path.join(odd.dir, ".GIT"));
    await writeFile(path.join(odd.dir, ".git"), 'aws_key = "not-a-real-value-123"\n', "utf8");
    const declaredGit = await harvestWorkspace(odd, [".git", "report.md"]);
    expect(declaredGit.unreadable).toMatch(/one no repository can hold: "\.git"/);
    expect(declaredGit.artifacts.map((a) => a.path)).not.toContain(".git");
    await cleanupWorkspace(odd);
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

  it("cuts a diff over the limit only between files, never at a line separator inside a line", () => {
    // A line that holds U+2028 (or a CR) and then "diff --git": with `m`, `^` matched after it.
    const forged = `x\u2028diff --git a/evil.md b/evil.md\n${"y".repeat(3000)}`;
    const diff = [renderNewFileDiff("a.md", `${forged}\n`), renderNewFileDiff("c.md", "last\n")].join("");
    const fitted = fitDiff(diff, 2000);
    expect(fitted.omitted).toEqual(["a.md"]);
    expect(parseUnifiedDiff(fitted.text).map((f) => f.path)).toEqual(["c.md"]);
  });

  it("says why git failed by its error before a warning beside it", () => {
    const warned =
      "warning: in the working copy of 'x', LF will be replaced by CRLF\nfatal: Unable to create '.git/index.lock'";
    expect(gitReason(warned)).toBe("fatal: Unable to create '.git/index.lock'");
    expect(gitReason("warning: could not open directory 'closed/': Permission denied")).toBe(
      "warning: could not open directory 'closed/': Permission denied",
    );
    expect(gitReason("something odd\nlast words")).toBe("last words");
    expect(gitReason("fatal: https://x-access-token:secret@github.com/o/r.git")).not.toContain("secret");
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
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: GIT_NO_CONFIG,
    });
    // git's messages in English whatever the worker's locale: the harvest and the rework read some of them.
    expect(gitEnvironment({ LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" })).toMatchObject({ LC_ALL: "C" });
  });

  it("reads git's NUL-separated names as UTF-8, and spells one that is not apart, in ASCII", () => {
    const names = (...parts: (string | number[])[]) =>
      Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p))));
    expect(decodeNames(names("?? résumé.md", [0], "?? はじめに.md", [0]))).toEqual({
      names: ["?? résumé.md", "?? はじめに.md"],
      notUtf8: [],
    });
    expect(decodeNames(names(""))).toEqual({ names: [], notUtf8: [] });
    // bad\xff.md and bad\xfe.md: loosely decoded, both would be "bad\ufffd.md", the name of a third file.
    expect(
      decodeNames(names("?? bad", [0xff], ".md", [0], "?? ok.md", [0], "?? bad", [0xfe], ".md", [0])),
    ).toEqual({
      names: ["?? ok.md"],
      notUtf8: ["?? bad\\xff.md", "?? bad\\xfe.md"],
    });
    // A backslash doubled: `\\x82` the characters is not `\x82` the byte.
    expect(decodeNames(names("?? a\\x82", [0x82, 0]))).toEqual({ names: [], notUtf8: ["?? a\\\\x82\\x82"] });
    // A name that starts with U+FEFF keeps it: without, it is another file's.
    expect(decodeNames(names("\ufeffreport.md", [0], "report.md", [0]))).toEqual({
      names: ["\ufeffreport.md", "report.md"],
      notUtf8: [],
    });
  });

  it.runIf(process.platform === "linux")(
    "says git could not read the changes back where a file's name is not UTF-8",
    async () => {
      // Linux takes any bytes for a name; macOS and Windows take none of these.
      const ws = await prepareWorkspace(
        path.join(root, "work"),
        "run-not-utf8",
        { repoUrl: bare, defaultBranch: "main" },
        null,
      );
      await writeFile(
        Buffer.concat([Buffer.from(`${ws.dir}/bad`), Buffer.from([0xff]), Buffer.from(".md")]),
        "x\n",
      );
      await writeFile(path.join(ws.dir, "report.md"), "The report.\n", "utf8");
      for (const declared of [[], ["report.md"]]) {
        const h = await harvestWorkspace(ws, declared);
        expect(h.unreadable).toBe(
          "the run's changes could not be read back for review (a file's name is not UTF-8: bad\\xff.md)",
        );
        expect(h.artifacts.find((a) => a.kind === "diff")).toBeUndefined();
        // The run's other files are still its files: a blocked run keeps them.
        expect(h.filesWritten).toEqual(["report.md"]);
      }
      await cleanupWorkspace(ws);
    },
  );

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
    // git prints C:/… on Windows; path.resolve gives the platform's own separators.
    const [gitDir, top, ...rest] = where.stdout.trim().split("\n");
    expect([path.resolve(gitDir ?? ""), path.resolve(top ?? ""), ...rest]).toEqual([
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

  it("reads a run's changes back only against the commit its clone was at", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-moved-head",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    expect(ws.clonedSha).toMatch(/^[0-9a-f]{40}$/);
    // A commit moves HEAD: its changes would ride into a pull request that no review showed.
    const id = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    await writeFile(path.join(ws.dir, "leaked.env"), 'api_key = "not-a-real-value-123"\n', "utf8");
    await git(["add", "leaked.env"], ws.dir, id);
    expect((await git(["commit", "-m", "hide"], ws.dir, id)).code).toBe(0);
    await writeFile(path.join(ws.dir, "small.txt"), "small\n", "utf8");
    const h = await harvestWorkspace(ws, []);
    expect(h.unreadable).toBe(
      `the run's changes could not be read back for review (the clone is no longer at ${ws.clonedSha!.slice(0, 12)}, the commit it was cloned at: a checkout or a commit moved it)`,
    );
    await cleanupWorkspace(ws);
  });

  it("delivers no declared output git leaves out of the diff, and fails the run naming it", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-ignored-output",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, ".gitignore"), "*.log\n", "utf8");
    await writeFile(path.join(ws.dir, "run.log"), 'api_key = "not-a-real-value-123"\n', "utf8");
    await writeFile(path.join(ws.dir, "notes.md"), "n\n", "utf8");
    // README.md is the repository's own, unchanged: delivered as it is.
    const h = await harvestWorkspace(ws, ["README.md", "notes.md", "run.log", ".git/description"]);
    expect(h.unreadable).toBe(
      'the run\'s changes could not be read back for review (a declared output git leaves out of the diff, which the review would not show: "run.log")',
    );
    expect(h.filesWritten).toEqual(["README.md", "notes.md"]);
    expect(h.artifacts.map((a) => a.path)).toEqual(["README.md", "notes.md", "changes.diff"]);
    // Under .git too.
    expect((await harvestWorkspace(ws, ["notes.md", ".git/description"])).unreadable).toMatch(
      /leaves out of the diff, which the review would not show: "\.git\/description"/,
    );
    await cleanupWorkspace(ws);
  });

  it("says a run's changes cannot be read back where a file git reads as text holds a NUL byte", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-late-nul",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    // git looks for a NUL byte in a file's first 8000 bytes only: past them, the file is text to it.
    await writeFile(path.join(ws.dir, "late.txt"), `${"x".repeat(9000)}\n\0 tail\n`, "utf8");
    await writeFile(path.join(ws.dir, "README.md"), "# demo\n\nchanged\n", "utf8");
    const h = await harvestWorkspace(ws, []);
    expect(h.unreadable).toBe(
      'the run\'s changes could not be read back for review (a file git read as text holds a NUL byte: "late.txt")',
    );
    expect(h.artifacts.find((a) => a.kind === "diff")).toBeUndefined();
    await cleanupWorkspace(ws);
  });

  it("shows a text file as text whatever attributes the run gave the clone alone in .git/info", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-info-attributes",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    // `-diff` and `binary` would have git print "Binary files ... differ": the review would show none of it.
    await mkdir(path.join(ws.dir, ".git", "info"), { recursive: true });
    await writeFile(
      path.join(ws.dir, ".git", "info", "attributes"),
      "README.md -diff\n*.json binary\n",
      "utf8",
    );
    await writeFile(path.join(ws.dir, "README.md"), '# demo\n\napi_key = "not-a-real-value-123"\n', "utf8");
    await writeFile(
      path.join(ws.dir, "config.json"),
      '{ "smtp_password": "not-a-real-value-123" }\n',
      "utf8",
    );
    const h = await harvestWorkspace(ws, []);
    const files = parseUnifiedDiff(h.artifacts.find((a) => a.kind === "diff")!.content);
    expect(files.map((f) => [f.path, f.binary])).toEqual([
      ["README.md", false],
      ["config.json", false],
    ]);
    expect(existsSync(path.join(ws.dir, ".git", "info", "attributes"))).toBe(false);
    await cleanupWorkspace(ws);
  });

  it("shows a .gitattributes the run hid with .git/info/exclude, so the review sees why a file is binary", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-info-exclude",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await mkdir(path.join(ws.dir, ".git", "info"), { recursive: true });
    await writeFile(path.join(ws.dir, ".git", "info", "exclude"), ".gitattributes\n", "utf8");
    await writeFile(path.join(ws.dir, ".gitattributes"), "config.json -diff\n", "utf8");
    await writeFile(
      path.join(ws.dir, "config.json"),
      '{ "smtp_password": "not-a-real-value-123" }\n',
      "utf8",
    );
    const h = await harvestWorkspace(ws, []);
    const files = parseUnifiedDiff(h.artifacts.find((a) => a.kind === "diff")!.content);
    // The attribute is part of the change now, as the review shows; the board scans the file it makes binary.
    expect(files.map((f) => [f.path, f.binary])).toEqual([
      [".gitattributes", false],
      ["config.json", true],
    ]);
    await cleanupWorkspace(ws);
  });

  it("takes out a .git/info the run made a link, never what it points at", async (ctx) => {
    await skipWithoutSymlinks(ctx, root);
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-info-link",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    const elsewhere = await mkdtemp(path.join(root, "elsewhere-"));
    await writeFile(path.join(elsewhere, "attributes"), "README.md -diff\n", "utf8");
    await rm(path.join(ws.dir, ".git", "info"), { recursive: true, force: true });
    await symlink(elsewhere, path.join(ws.dir, ".git", "info"), "dir");
    await writeFile(path.join(ws.dir, "README.md"), "# demo\n\nchanged\n", "utf8");
    const h = await harvestWorkspace(ws, []);
    expect(h.artifacts.find((a) => a.kind === "diff")?.content).toContain("+changed");
    expect(existsSync(path.join(ws.dir, ".git", "info"))).toBe(false);
    expect(await readFile(path.join(elsewhere, "attributes"), "utf8")).toBe("README.md -diff\n");
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

  it("says git could not read the changes back, and sends no part of them, when it cannot stage them", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-index-lock",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "README.md"), "# demo\n\nchanged\n", "utf8");
    // What a git ended part-way leaves behind.
    await writeFile(path.join(ws.dir, ".git", "index.lock"), "", "utf8");
    const h = await harvestWorkspace(ws, []);
    // git's own reason, its first error line, not its advice; and none of the worker's folders in it.
    expect(h.unreadable).toMatch(
      /^the run's changes could not be read back for review \(git: (?:error|fatal): .+\)$/,
    );
    expect(h.unreadable).toContain("./.git/index.lock");
    for (const at of [ws.dir, await realpath(ws.dir), root]) {
      expect(h.unreadable).not.toContain(at);
      expect(h.unreadable).not.toContain(at.replace(/\\/g, "/"));
    }
    expect(h.artifacts.find((a) => a.kind === "diff")).toBeUndefined();
    await cleanupWorkspace(ws);
  });

  it.runIf(process.platform === "linux")(
    "says a run without a repository could not be read back where a file's name is not UTF-8",
    async () => {
      const ws = await prepareWorkspace(
        path.join(root, "work"),
        "run-no-repo-not-utf8",
        { repoUrl: null, defaultBranch: "main" },
        null,
      );
      await writeFile(
        Buffer.concat([Buffer.from(`${ws.dir}/bad`), Buffer.from([0xff]), Buffer.from(".md")]),
        "x\n",
      );
      await writeFile(path.join(ws.dir, "report.md"), "The report.\n", "utf8");
      const h = await harvestWorkspace(ws, []);
      expect(h.unreadable).toBe(
        "the run's changes could not be read back for review (a file's name is not UTF-8: bad\\xff.md)",
      );
      expect(h.filesWritten).toEqual(["report.md"]);
      await cleanupWorkspace(ws);
    },
  );

  // As root a folder's mode stops nobody, and Windows has none.
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "says git could not read the changes back where it could not open a folder the run made",
    async () => {
      const ws = await prepareWorkspace(
        path.join(root, "work"),
        "run-closed-folder",
        { repoUrl: bare, defaultBranch: "main" },
        null,
      );
      await writeFile(path.join(ws.dir, "README.md"), "# demo\n\nchanged\n", "utf8");
      await mkdir(path.join(ws.dir, "closed"));
      await writeFile(path.join(ws.dir, "closed", "part.md"), "part of the change\n", "utf8");
      await chmod(path.join(ws.dir, "closed"), 0o000);
      try {
        const h = await harvestWorkspace(ws, []);
        // git passes over it with a warning and adds the rest: no review of the rest alone.
        expect(h.unreadable).toMatch(/\(git: warning: could not open directory 'closed\/'/);
        expect(h.artifacts.find((a) => a.kind === "diff")).toBeUndefined();
      } finally {
        await chmod(path.join(ws.dir, "closed"), 0o755);
      }
      await cleanupWorkspace(ws);
    },
  );

  it("names each file in the review's diff as it is: past ASCII, with a quote or a tab, a trailing space", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-quoted-names",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    // Windows allows neither a quote, a tab nor a trailing space in a name.
    const names = [
      "résumé.md",
      "はじめに.md",
      ...(process.platform === "win32" ? [] : ['say "hi"\tnow.md', "README.md "]),
    ];
    for (const name of names) await writeFile(path.join(ws.dir, name), `${name}\n`, "utf8");
    const h = await harvestWorkspace(ws, []);
    const diff = h.artifacts.find((a) => a.kind === "diff")?.content ?? "";
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path).sort()).toEqual([...names].sort());
    // README.md beside "README.md " is left as it was: the review adds one file, it changes none.
    expect(files.every((f) => f.status === "added")).toBe(true);
    await cleanupWorkspace(ws);
  });

  it("delivers, with no outputs declared, a changed file by its name as it is and a moved one by its new name", async () => {
    const ws = await prepareWorkspace(
      path.join(root, "work"),
      "run-names",
      { repoUrl: bare, defaultBranch: "main" },
      null,
    );
    await writeFile(path.join(ws.dir, "my notes.md"), "notes\n", "utf8");
    await writeFile(path.join(ws.dir, "naïve.md"), "café\n", "utf8");
    await git(["mv", "README.md", "READ-ME.md"], ws.dir, { GIT_AUTHOR_NAME: "t" });
    const h = await harvestWorkspace(ws, []);
    expect([...h.filesWritten].sort()).toEqual(["READ-ME.md", "my notes.md", "naïve.md"]);
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

describe("a file's identity", () => {
  it("tells two files apart by their whole file id, which a number would round together", () => {
    // Real NTFS ids (sequence 35, records 198867 and 198869): as numbers they are one and the same.
    const a = (35n << 48n) | 198867n;
    const b = (35n << 48n) | 198869n;
    expect(Number(a)).toBe(Number(b));
    expect(sameFile({ dev: 7n, ino: a }, { dev: 7n, ino: b })).toBe(false);
    expect(sameFile({ dev: 7n, ino: a }, { dev: 7n, ino: a })).toBe(true);
    // Another device, or no id at all, is never the same file.
    expect(sameFile({ dev: 8n, ino: a }, { dev: 7n, ino: a })).toBe(false);
    expect(sameFile({ dev: 7n, ino: 0n }, { dev: 7n, ino: 0n })).toBe(false);
    // ReFS's id for a file whose own does not fit in 64 bits, all ones, which Node reads as -1.
    expect(sameFile({ dev: 7n, ino: -1n }, { dev: 7n, ino: -1n })).toBe(false);
  });

  it("finds a file's device by a handle the same as its directory's, as the harvest compares them on Windows", async () => {
    const dir = await mkdtemp(path.join(root, "dev-"));
    await writeFile(path.join(dir, "f.md"), "f\n", "utf8");
    const [file, folder] = await Promise.all([open(path.join(dir, "f.md"), "r"), open(dir, "r")]);
    try {
      const [f, d] = await Promise.all([file.stat({ bigint: true }), folder.stat({ bigint: true })]);
      expect(f.dev).toBe(d.dev);
      expect(f.ino).not.toBe(0n);
    } finally {
      await Promise.all([file.close(), folder.close()]);
    }
  });
});

describe("removing a run's directory", () => {
  const busy = () => Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });

  it("tries again while something in it is busy, and gives up within its time", async () => {
    let calls = 0;
    const started = Date.now();
    await expect(
      removeTree(path.join(root, "never"), 300, async () => {
        calls++;
        throw busy();
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls).toBeGreaterThan(1);

    calls = 0;
    await removeTree(path.join(root, "later"), 2000, async () => {
      if (++calls < 3) throw busy();
    });
    expect(calls).toBe(3);

    calls = 0;
    const denied = Object.assign(new Error("no"), { code: "EACCES" });
    await expect(
      removeTree(path.join(root, "denied"), 2000, async () => {
        calls++;
        throw denied;
      }),
    ).rejects.toBe(denied);
    expect(calls).toBe(1);
  });

  /**
   * A remover that finds the folder busy, as a file a taskkilled git holds on Windows, for `ms` from the
   * removal after the failed clone, however long the clone took to fail. The first call, before the clone,
   * finds nothing there and goes.
   */
  const heldFor = (ms: number): typeof rm => {
    let calls = 0;
    let until = 0;
    return async (p, o) => {
      if (++calls === 2) until = Date.now() + ms;
      if (calls > 1 && Date.now() < until) throw busy();
      return rm(p, o);
    };
  };
  const noSuchRepo = () => ({ repoUrl: path.join(root, "no-such.git"), defaultBranch: "main" });

  it("goes on removing a failed clone's folder past its window, and a stopping worker waits for it", async () => {
    const workRoot = await mkdtemp(path.join(root, "removals-"));
    await expect(
      prepareWorkspace(workRoot, "run-held", noSuchRepo(), null, undefined, heldFor(3000)),
    ).rejects.toThrow(/git clone failed/);
    expect(existsSync(path.join(workRoot, "run-held"))).toBe(true);
    await removalsDone();
    expect(existsSync(path.join(workRoot, "run-held"))).toBe(false);
  });

  it("lets a stopping worker wait for a removal that starts while it waits", async () => {
    const workRoot = await mkdtemp(path.join(root, "removals-"));
    await expect(
      prepareWorkspace(workRoot, "run-a", noSuchRepo(), null, undefined, heldFor(6000)),
    ).rejects.toThrow(/git clone failed/);
    // run-b's clone fails while the worker already waits for run-a's folder; its own outlasts that.
    const b = prepareWorkspace(workRoot, "run-b", noSuchRepo(), null, undefined, heldFor(6000));
    const done = removalsDone();
    await expect(b).rejects.toThrow(/git clone failed/);
    await done;
    expect(existsSync(path.join(workRoot, "run-a"))).toBe(false);
    expect(existsSync(path.join(workRoot, "run-b"))).toBe(false);
  });

  it("prepares a run again in a folder still being removed only once the removal is done, so it takes nothing new", async () => {
    const workRoot = await mkdtemp(path.join(root, "removals-"));
    const started = Date.now();
    const remove = heldFor(5000);
    await expect(
      prepareWorkspace(workRoot, "run-held", noSuchRepo(), null, undefined, remove),
    ).rejects.toThrow(/git clone failed/);
    const ws = await prepareWorkspace(
      workRoot,
      "run-held",
      { repoUrl: null, defaultBranch: "main" },
      null,
      undefined,
      remove,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    await writeFile(path.join(ws.dir, "work.md"), "w\n", "utf8");
    await removalsDone();
    expect(existsSync(path.join(ws.dir, "work.md"))).toBe(true);
    await cleanupWorkspace(ws);
  });

  it("gives up within its time when that is longer than the longest wait between tries", async () => {
    const started = Date.now();
    await expect(
      removeTree(path.join(root, "held-long"), 1500, async () => {
        throw busy();
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("tries again after a first try that took longer than its time, as a large tree's does", async () => {
    let calls = 0;
    await removeTree(path.join(root, "large"), 200, async () => {
      // A node_modules takes seconds to walk before the file still held stops it.
      if (++calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        throw busy();
      }
    });
    expect(calls).toBe(2);
  });

  it("removes a directory a program ran from once it ends, and on Windows gives up in time while it runs", async () => {
    const dir = await mkdtemp(path.join(root, "held-"));
    await writeFile(path.join(dir, "f.md"), "f\n", "utf8");
    // A program running from the directory, as a run's dev server would be. On Windows a copy of this Node:
    // Windows removes no file a process holds, and a running program's own file is one. Elsewhere this Node,
    // with the directory as its cwd, which goes like any other.
    const program = process.platform === "win32" ? path.join(dir, "held.exe") : process.execPath;
    if (program !== process.execPath) await copyFile(process.execPath, program);
    const child = spawn(program, ["-e", "setTimeout(() => {}, 60000)"], { cwd: dir, stdio: "ignore" });
    await new Promise((resolve) => child.once("spawn", resolve));
    try {
      if (process.platform === "win32") {
        await expect(rm(dir, { recursive: true, force: true })).rejects.toMatchObject({
          code: expect.stringMatching(/^(EBUSY|EPERM)$/),
        });
        const started = Date.now();
        await expect(removeTree(dir, 500)).rejects.toMatchObject({
          code: expect.stringMatching(/^(EBUSY|EPERM)$/),
        });
        expect(Date.now() - started).toBeLessThan(3000);
        expect(existsSync(dir)).toBe(true);
      } else {
        await removeTree(dir, 500);
        expect(existsSync(dir)).toBe(false);
      }
    } finally {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await gone;
    }
    await removeTree(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
