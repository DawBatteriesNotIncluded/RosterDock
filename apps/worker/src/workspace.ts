// One ephemeral directory per run. With a repository: shallow clone, run, then
// capture the diff. Without: an empty directory the outputs land in.
// The git token, when present, goes into the clone URL only and is never
// logged or written to the board.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { renderBinaryFileDiff, renderNewFileDiff, type RunArtifactInput } from "@rosterdock/shared";

export const HANDOVER_FILE = "handover-summary.md";
export const BLOCKED_FILE = "blocked.md";
/** What a board without an object store takes; the run spec raises it when the board has one. */
export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_UNDECLARED_FILES = 50;

export interface Workspace {
  dir: string;
  repo: boolean;
}

export function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function withToken(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "https:" || u.username) return repoUrl;
    u.username = "x-access-token";
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/** Hide any credential that made it into a git message. */
export function redactGit(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1***@");
}

export async function prepareWorkspace(
  workRoot: string,
  runId: string,
  project: { repoUrl: string | null; defaultBranch: string },
  gitToken: string | null,
): Promise<Workspace> {
  const dir = path.join(workRoot, runId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (!project.repoUrl) return { dir, repo: false };
  const res = await git(
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      project.defaultBranch,
      "--",
      withToken(project.repoUrl, gitToken),
      ".",
    ],
    dir,
  );
  if (res.code !== 0) {
    throw new Error(
      `git clone failed: ${redactGit(res.stderr).trim().split("\n").at(-1) ?? "unknown error"}`,
    );
  }
  // Never leave the credential in the checkout.
  if (gitToken) await git(["remote", "set-url", "origin", project.repoUrl], dir);
  return { dir, repo: true };
}

export async function cleanupWorkspace(ws: Workspace): Promise<void> {
  await rm(ws.dir, { recursive: true, force: true, maxRetries: 3 });
}

export interface Harvest {
  artifacts: RunArtifactInput[];
  handover: string | null;
  blocked: string | null;
  missingOutputs: string[];
  filesWritten: string[];
  /** HEAD of the clone the diff was taken against; null without a repository. */
  baseSha: string | null;
}

async function readText(file: string, maxBytes: number): Promise<string | null> {
  try {
    const s = await stat(file);
    if (!s.isFile() || s.size > maxBytes) return null;
    const buf = await readFile(file);
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** A file as an artifact: text as it is, anything with a NUL byte as base64. Null over the cap or unreadable. */
async function readArtifact(
  file: string,
  maxBytes: number,
): Promise<{ content: string; encoding: "utf8" | "base64" } | null> {
  try {
    const s = await stat(file);
    if (!s.isFile() || s.size > maxBytes) return null;
    const buf = await readFile(file);
    return buf.includes(0)
      ? { content: buf.toString("base64"), encoding: "base64" }
      : { content: buf.toString("utf8"), encoding: "utf8" };
  } catch {
    return null;
  }
}

/** Declared outputs (or, if none were declared, new and changed files), the handover, blocked note and diff. */
export async function harvestWorkspace(
  ws: Workspace,
  declaredOutputs: string[],
  opts: { maxArtifactBytes?: number | undefined } = {},
): Promise<Harvest> {
  const maxBytes = opts.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
  const out: Harvest = {
    artifacts: [],
    handover: null,
    blocked: null,
    missingOutputs: [],
    filesWritten: [],
    baseSha: null,
  };
  out.handover = (await readText(path.join(ws.dir, HANDOVER_FILE), maxBytes))?.trim().slice(0, 4000) || null;
  out.blocked = (await readText(path.join(ws.dir, BLOCKED_FILE), maxBytes))?.trim().slice(0, 1000) || null;

  let candidates: string[];
  if (declaredOutputs.length) {
    candidates = declaredOutputs;
  } else if (ws.repo) {
    const status = await git(["status", "--porcelain", "--untracked-files=all"], ws.dir);
    candidates = status.stdout
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((p) => p && p !== HANDOVER_FILE && p !== BLOCKED_FILE)
      .slice(0, MAX_UNDECLARED_FILES);
  } else {
    const entries = await readdir(ws.dir, { withFileTypes: true });
    candidates = entries
      .filter((e) => e.isFile() && e.name !== HANDOVER_FILE && e.name !== BLOCKED_FILE)
      .map((e) => e.name)
      .slice(0, MAX_UNDECLARED_FILES);
  }
  for (const rel of candidates) {
    const read = await readArtifact(path.join(ws.dir, rel), maxBytes);
    if (read === null) {
      if (declaredOutputs.includes(rel)) out.missingOutputs.push(rel);
      continue;
    }
    out.filesWritten.push(rel);
    out.artifacts.push({
      path: rel,
      kind: read.encoding === "utf8" && /\.(md|txt|rst)$/i.test(rel) ? "document" : "file",
      content: read.content,
      encoding: read.encoding,
    });
  }
  if (out.handover)
    out.artifacts.push({ path: HANDOVER_FILE, kind: "handover", content: out.handover, encoding: "utf8" });
  // The diff is the review object. With a repository: stage everything
  // (additions, edits and deletions) and diff the index against HEAD, without
  // rename detection so every hunk applies to one path. Without: a diff that
  // adds every harvested text file, so the review looks the same.
  let diffText = "";
  if (ws.repo) {
    const head = await git(["rev-parse", "HEAD"], ws.dir);
    if (head.code === 0) out.baseSha = head.stdout.trim() || null;
    await git(["add", "-A", "--", ".", `:(exclude)${HANDOVER_FILE}`, `:(exclude)${BLOCKED_FILE}`], ws.dir);
    const diff = await git(["diff", "--cached", "--no-color", "--no-renames", "--no-ext-diff"], ws.dir);
    if (diff.code === 0) diffText = diff.stdout;
  } else {
    diffText = out.artifacts
      .filter((a) => a.kind !== "handover" && a.kind !== "diff")
      .map((a) =>
        a.encoding === "base64" ? renderBinaryFileDiff(a.path) : renderNewFileDiff(a.path, a.content),
      )
      .join("");
  }
  if (diffText.trim()) {
    out.artifacts.push({
      path: "changes.diff",
      kind: "diff",
      content: diffText.slice(0, maxBytes),
      encoding: "utf8",
    });
  }
  return out;
}
