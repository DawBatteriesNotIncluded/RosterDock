// The harvest checks a file, then opens it. A link the run swaps in between is refused and never read: by
// O_NOFOLLOW where there is one, and on Windows, which has none, by the file id of what was opened.
import type * as Fs from "node:fs/promises";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cleanupWorkspace, harvestWorkspace, prepareWorkspace } from "../src/workspace.js";
import { skipWithoutSymlinks } from "./helpers.js";

// open as it is, until a test puts its swap in front of it.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
let secret: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rosterdock-swap-"));
  // A file the worker can read and the company must not, like /proc/self/environ.
  secret = path.join(root, "environ");
  await writeFile(secret, "ROSTERDOCK_WORKER_TOKEN=hunter2\n", "utf8");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it("refuses a file the run swaps for a link between the harvest's check and its open", async (ctx) => {
  await skipWithoutSymlinks(ctx, root);
  const ws = await prepareWorkspace(
    path.join(root, "work"),
    "run-swap",
    { repoUrl: null, defaultBranch: "main" },
    null,
  );
  const report = path.join(ws.dir, "report.md");
  await writeFile(report, "The report.\n", "utf8");
  const { open: openFile } = await vi.importActual<typeof Fs>("node:fs/promises");
  vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
    // The walk and realpath saw a regular file inside the workspace; now it points outside.
    await rm(report);
    await symlink(secret, report);
    return openFile(file, flags, mode);
  });
  const h = await harvestWorkspace(ws, ["report.md"]);
  expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
  expect(h.refusedOutputs).toEqual(["report.md"]);
  expect(h.filesWritten).toEqual([]);
  expect(JSON.stringify(h.artifacts)).not.toContain("hunter2");
  await cleanupWorkspace(ws);
});
