// One ephemeral directory per run. With a repository: shallow clone, run, then
// capture the diff. Without: an empty directory the outputs land in.
// The git token, when present, goes into the clone URL only and is never
// logged or written to the board. git itself sees none of the worker's
// environment and no config but the clone's own: the harvest runs git in a
// checkout the run has just changed, and a filter, an fsmonitor or a hook the
// run wrote into it would otherwise run with the worker's credentials.

import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseUnifiedDiff,
  renderBinaryFileDiff,
  renderNewFileDiff,
  type RunArtifactInput,
} from "@rosterdock/shared";
import { clip } from "./text.js";

export const HANDOVER_FILE = "handover-summary.md";
export const BLOCKED_FILE = "blocked.md";
/** What a board without an object store takes; the run spec raises it when the board has one. */
export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_UNDECLARED_FILES = 50;

export interface Workspace {
  dir: string;
  repo: boolean;
  /** .git/config as the clone left it, put back before the harvest runs git. */
  gitConfig?: string;
}

/** Where programs live, the temp directory, the locale: all git needs from the worker's environment. */
const GIT_ENV_KEYS = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TZ",
];

/** git's environment: the keys above, no prompt, and no system or global config (a credential helper, an include, a ~/.gitconfig an earlier run wrote). */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of GIT_ENV_KEYS) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  return { ...out, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
}

/** Every command: no fsmonitor and no hooks, whatever the repository's config says. */
const GIT_SAFE_ARGS = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`];

/**
 * Run git with gitEnvironment; `extraEnv` is for the worker's own tests (an author for a commit). An abort
 * kills git and the helpers it started (the network side of a clone is a process of its own).
 */
export function git(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string | undefined> = {},
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: null, stdout: "", stderr: "stopped" });
    // Its own process group where there are groups, so a stop reaches the helpers too.
    const group = process.platform !== "win32";
    const child = spawn("git", [...GIT_SAFE_ARGS, ...args], {
      cwd,
      env: { ...gitEnvironment(), ...extraEnv },
      shell: false,
      windowsHide: true,
      detached: group,
    });
    let stdout = "";
    let stderr = "";
    // Decoded as a stream: a character split across two pipe chunks stays whole (the diff is the review).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    let settled = false;
    const done = (r: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // gone
      }
      done({ code: null, stdout, stderr: `${stderr}\nstopped` });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => done({ code: null, stdout, stderr: `${stderr}\n${err.message}` }));
    child.on("close", (code) => done({ code, stdout, stderr }));
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

/** A clone that moves less than this many bytes a second for this many seconds gives up. */
export const CLONE_LOW_SPEED = { bytesPerSecond: 1000, seconds: 60 };

/** The run's directory, with the repository cloned into it. `signal` (Stop, the time limit, shutdown) ends the clone. */
export async function prepareWorkspace(
  workRoot: string,
  runId: string,
  project: { repoUrl: string | null; defaultBranch: string },
  gitToken: string | null,
  signal?: AbortSignal,
): Promise<Workspace> {
  const dir = path.join(workRoot, runId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (!project.repoUrl) return { dir, repo: false };
  const res = await git(
    [
      "-c",
      `http.lowSpeedLimit=${CLONE_LOW_SPEED.bytesPerSecond}`,
      "-c",
      `http.lowSpeedTime=${CLONE_LOW_SPEED.seconds}`,
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
    {},
    signal,
  );
  if (signal?.aborted) throw new Error("the clone was stopped before it finished");
  if (res.code !== 0) {
    throw new Error(
      `git clone failed: ${redactGit(res.stderr).trim().split("\n").at(-1) ?? "unknown error"}`,
    );
  }
  // Never leave the credential in the checkout.
  if (gitToken) await git(["remote", "set-url", "origin", project.repoUrl], dir);
  return { dir, repo: true, gitConfig: await readFile(path.join(dir, ".git", "config"), "utf8") };
}

/**
 * Before the harvest runs git in the changed checkout: .git must still be the clone's directory, and its
 * config goes back to what the clone wrote, so a filter, textconv, fsmonitor or include the run added
 * never runs. A .git the run replaced cannot be read back safely, so the harvest refuses it.
 */
async function restoreGitDir(ws: Workspace): Promise<void> {
  const gitDir = path.join(ws.dir, ".git");
  const st = await lstat(gitDir).catch(() => null);
  const shared = await lstat(path.join(gitDir, "commondir")).catch(() => null);
  if (!st?.isDirectory() || shared)
    throw new Error(
      "the run replaced the repository's .git directory, so its changes cannot be read back for review",
    );
  if (ws.gitConfig === undefined) return;
  const config = path.join(gitDir, "config");
  // Removed first: a symlink the run left there must not redirect the write.
  await rm(config, { force: true });
  await writeFile(config, ws.gitConfig, "utf8");
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
  /** Files whose changes did not fit in the diff the board takes, so the review does not show them. */
  diffOmitted: string[];
}

/**
 * The diff within `maxBytes` as the board counts them (UTF-8), in whole files: a file that does not fit
 * is left out and named, never cut inside a hunk, so the review never shows (and a merge never applies)
 * half a change.
 */
export function fitDiff(diffText: string, maxBytes: number): { text: string; omitted: string[] } {
  if (Buffer.byteLength(diffText, "utf8") <= maxBytes) return { text: diffText, omitted: [] };
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const file of diffText.split(/^(?=diff --git )/m).filter(Boolean)) {
    const bytes = Buffer.byteLength(file, "utf8");
    if (used + bytes <= maxBytes) {
      kept.push(file);
      used += bytes;
    } else omitted.push(parseUnifiedDiff(file)[0]?.path || file.split("\n", 1)[0]!);
  }
  return { text: kept.join(""), omitted };
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
    diffOmitted: [],
  };
  if (ws.repo) await restoreGitDir(ws);
  out.handover =
    clip((await readText(path.join(ws.dir, HANDOVER_FILE), maxBytes))?.trim() ?? "", 4000) || null;
  out.blocked = clip((await readText(path.join(ws.dir, BLOCKED_FILE), maxBytes))?.trim() ?? "", 1000) || null;

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
    const diff = await git(
      ["diff", "--cached", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv"],
      ws.dir,
    );
    if (diff.code === 0) diffText = diff.stdout;
  } else {
    diffText = out.artifacts
      .filter((a) => a.kind !== "handover" && a.kind !== "diff")
      .map((a) =>
        a.encoding === "base64" ? renderBinaryFileDiff(a.path) : renderNewFileDiff(a.path, a.content),
      )
      .join("");
  }
  const fitted = fitDiff(diffText, maxBytes);
  out.diffOmitted = fitted.omitted;
  if (fitted.text.trim()) {
    out.artifacts.push({ path: "changes.diff", kind: "diff", content: fitted.text, encoding: "utf8" });
  }
  return out;
}
