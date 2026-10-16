// Workspace against a local bare repository: no network.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseUnifiedDiff } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupWorkspace,
  git,
  harvestWorkspace,
  prepareWorkspace,
  redactGit,
  withToken,
} from "../src/workspace.js";

let root: string;
let bare: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rosterdock-ws-"));
  const src = path.join(root, "src");
  bare = path.join(root, "origin.git");
  await (await import("node:fs/promises")).mkdir(src, { recursive: true });
  const env = {
    ...process.env,
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

  it("fails clearly on a bad repository without leaking a token", async () => {
    await expect(
      prepareWorkspace(
        path.join(root, "work"),
        "run-4",
        { repoUrl: path.join(root, "nope.git"), defaultBranch: "main" },
        "tok",
      ),
    ).rejects.toThrow(/git clone failed/);
  });

  it("injects the token into https URLs only and redacts it from messages", () => {
    expect(withToken("https://github.com/o/r.git", "abc")).toBe(
      "https://x-access-token:abc@github.com/o/r.git",
    );
    expect(withToken("git@github.com:o/r.git", "abc")).toBe("git@github.com:o/r.git");
    expect(withToken("https://u@github.com/o/r.git", "abc")).toBe("https://u@github.com/o/r.git");
    expect(redactGit("fatal: https://x-access-token:abc@github.com/o/r.git not found")).toBe(
      "fatal: https://***@github.com/o/r.git not found",
    );
  });
});
