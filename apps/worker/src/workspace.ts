// One ephemeral directory per run. With a repository: shallow clone, run, then
// capture the diff. Without: an empty directory the outputs land in.
// The git token, when present, goes into the clone URL only, on the hosts it is
// meant for, and is never logged or written to the board. git itself sees none
// of the worker's environment and no config but the clone's own: the harvest
// runs git in a checkout the run has just changed, and a filter, an fsmonitor
// or a hook the run wrote into it would otherwise run with the worker's
// credentials.

import { spawn } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isTreePath,
  parseUnifiedDiff,
  renderBinaryFileDiff,
  renderNewFileDiff,
  type RunArtifactInput,
} from "@rosterdock/shared";
import { killTree } from "./kill.js";
import { clip } from "./text.js";

// Windows looks for a program in the directory it starts in before PATH, and the worker starts git and the
// engine in a run's directory: a git.exe or claude.exe the repository holds would run in their place. With
// this set, Windows and the libuv under Node look on PATH only, for every program this process starts.
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";

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

/** Where programs live, the temp directory, the locale (whose messages LC_ALL=C sets to English): all git needs. */
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

/**
 * The global config git reads: none. Not os.devNull, which is \\.\nul on Windows and a path Git for Windows
 * refuses to read config from; it takes /dev/null as the null device itself.
 */
export const GIT_NO_CONFIG = "/dev/null";

/**
 * git's environment: the keys above, no prompt, and no system or global config (a credential helper, an include, a
 * ~/.gitconfig an earlier run wrote). Its messages in English (LC_ALL=C), whatever the worker's locale: the worker
 * reads some of them (a folder git could not open, why a patch did not apply).
 */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of GIT_ENV_KEYS) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  return {
    ...out,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_NO_CONFIG,
  };
}

/**
 * What a caller's extra environment may set: an identity, nothing else of git's. GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE or GIT_CONFIG_PARAMETERS (which git exports to the commands a rebase or a hook runs)
 * would point git at another repository, or configure it.
 */
const GIT_KEY_ALLOWED = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/;

/**
 * Every command: no fsmonitor and no hooks, whatever the repository's config says. Hooks are looked for under
 * the null device, where no file can be: on Windows too (`\\.\nul`), though git refuses it as a config file.
 */
const GIT_SAFE_ARGS = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`];

/**
 * Run git with gitEnvironment; `extraEnv` is for the worker's own tests (an author for a commit). An abort
 * kills git and the helpers it started (the network side of a clone is a process of its own): its process
 * group, or on Windows its process tree.
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
      env: {
        ...gitEnvironment(),
        ...Object.fromEntries(
          Object.entries(extraEnv).filter(([k]) => !k.startsWith("GIT_") || GIT_KEY_ALLOWED.test(k)),
        ),
      },
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
        if (process.platform === "win32") killTree(child);
        else if (group && child.pid) process.kill(-child.pid, "SIGKILL");
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

/** git as `git` runs it, its output as bytes: names git prints with -z need not be UTF-8. */
export function gitBytes(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", [...GIT_SAFE_ARGS, ...args], {
      cwd,
      env: gitEnvironment(),
      shell: false,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (err) =>
      resolve({ code: null, stdout: Buffer.concat(out), stderr: `${stderr}\n${err.message}` }),
    );
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
  });
}

/**
 * NUL-separated entries as git prints them with -z: those that decode as UTF-8, and, apart and spelled in ASCII
 * (`unz\x82.txt`), those that do not. Decoded loosely, every such name would be one and the same, U+FFFD where
 * its bytes were, and collide with the others.
 */
export function decodeNames(out: Buffer): { names: string[]; notUtf8: string[] } {
  // ignoreBOM: a name that starts with U+FEFF keeps it, as another without it is another file.
  const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const decoded = { names: [] as string[], notUtf8: [] as string[] };
  for (let at = 0, end = out.indexOf(0); end >= 0; at = end + 1, end = out.indexOf(0, at)) {
    const entry = out.subarray(at, end);
    try {
      decoded.names.push(strict.decode(entry));
    } catch {
      decoded.notUtf8.push(
        [...entry]
          // A backslash doubled, so `\\x82` the four characters reads apart from `\x82` the byte.
          .map((b) =>
            b === 0x5c
              ? "\\\\"
              : b >= 0x20 && b < 0x7f
                ? String.fromCharCode(b)
                : `\\x${b.toString(16).padStart(2, "0")}`,
          )
          .join(""),
      );
    }
  }
  return decoded;
}

/**
 * Why git said it failed, in its line: its error before any warning beside it (a line-ending one), the warning
 * where that is all it said, its last line otherwise. Credentials redacted.
 */
export function gitReason(stderr: string): string {
  const lines = redactGit(stderr).trim().split("\n");
  return (
    lines.find((l) => /^(?:error|fatal):/.test(l)) ??
    lines.find((l) => /^warning:/.test(l)) ??
    lines.at(-1) ??
    ""
  );
}

/** The fleet's git token and the hosts it is for (ROSTERDOCK_GIT_TOKEN, ROSTERDOCK_GIT_TOKEN_HOSTS). */
export interface GitCredential {
  token: string;
  /** Lower-case host names, with the port where it is not 443. A repository anywhere else gets no token. */
  hosts: readonly string[];
}

/** The clone URL with the token in it: https on one of the token's own hosts only. */
export function withToken(repoUrl: string, credential: GitCredential | null): string {
  if (!credential) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "https:" || u.username || !credential.hosts.includes(u.host)) return repoUrl;
    u.username = "x-access-token";
    u.password = credential.token;
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

/**
 * The run's directory, with the repository cloned into it. `signal` (Stop, the time limit, shutdown) ends the
 * clone; a clone that fails or is ended leaves no directory behind.
 */
export async function prepareWorkspace(
  workRoot: string,
  runId: string,
  project: { repoUrl: string | null; defaultBranch: string },
  credential: GitCredential | null,
  signal?: AbortSignal,
): Promise<Workspace> {
  const dir = path.join(workRoot, runId);
  // A git just stopped in it holds its files a moment on Windows (EBUSY).
  await removeTree(dir);
  await mkdir(dir, { recursive: true });
  if (!project.repoUrl) return { dir, repo: false };
  try {
    return await cloneInto(dir, { ...project, repoUrl: project.repoUrl }, credential, signal);
  } catch (err) {
    // A clone that failed or was stopped part-way leaves nothing: its .git/config holds the URL, token and all.
    // On Windows a git just ended by taskkill may hold its files past removeTree's window: the removal goes on
    // without holding the run's stop, until git lets go.
    await removeTree(dir).catch(() => {
      void removeTree(dir, 30_000).catch(() => {});
    });
    throw err;
  }
}

async function cloneInto(
  dir: string,
  project: { repoUrl: string; defaultBranch: string },
  credential: GitCredential | null,
  signal?: AbortSignal,
): Promise<Workspace> {
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
      withToken(project.repoUrl, credential),
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
  if (credential) await git(["remote", "set-url", "origin", project.repoUrl], dir);
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
  await removeTree(ws.dir);
}

/** What removing a file says while a process still holds it (Windows) or writes beside it. */
const BUSY = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/**
 * Remove a directory and everything in it, trying again while something in it is busy, for `withinMs` at
 * most once a try has failed (the first try takes as long as the tree does, a large node_modules seconds);
 * then throw what the last try threw. Windows removes no file a process still holds, such as a program
 * running from it. Node's own maxRetries retries at every level of the tree, so one file that stays held
 * kept a removal going for minutes. `remove` is for the worker's own tests.
 */
export async function removeTree(dir: string, withinMs = 2000, remove: typeof rm = rm): Promise<void> {
  let until: number | undefined;
  for (let wait = 50; ; wait = Math.min(wait * 2, 500)) {
    try {
      await remove(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      until ??= Date.now() + withinMs;
      if (!BUSY.has((err as NodeJS.ErrnoException).code ?? "") || Date.now() + wait > until) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export interface Harvest {
  artifacts: RunArtifactInput[];
  handover: string | null;
  blocked: string | null;
  missingOutputs: string[];
  /** Files never read: a symbolic link on the way, or a path out of the workspace. */
  refusedOutputs: string[];
  filesWritten: string[];
  /** HEAD of the clone the diff was taken against; null without a repository. */
  baseSha: string | null;
  /** Files whose changes did not fit in the diff the board takes, so the review does not show them. */
  diffOmitted: string[];
  /**
   * Why git could not read the changes back (a lock a git ended part-way left behind), so there is no diff: a
   * run that would complete fails with it rather than send part of its change for review. Null when it could.
   */
  unreadable: string | null;
}

/**
 * The diff within `maxBytes` as the board counts them (UTF-8), in whole files: a file that does not fit
 * is left out and named, never cut inside a hunk, so the review never shows (and a merge never applies)
 * half a change.
 */
/** A file's stanza by its path, or its first line where it cannot be read. */
function fileName(stanza: string): string {
  try {
    return parseUnifiedDiff(stanza)[0]?.path || stanza.split("\n", 1)[0]!;
  } catch {
    return stanza.split("\n", 1)[0]!;
  }
}

export function fitDiff(diffText: string, maxBytes: number): { text: string; omitted: string[] } {
  if (Buffer.byteLength(diffText, "utf8") <= maxBytes) return { text: diffText, omitted: [] };
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  // Split before a line that starts "diff --git", after a \n only: not after a U+2028 or a CR inside a line.
  for (const file of diffText.split(/(?<=\n)(?=diff --git )/).filter(Boolean)) {
    const bytes = Buffer.byteLength(file, "utf8");
    if (used + bytes <= maxBytes) {
      kept.push(file);
      used += bytes;
    } else omitted.push(fileName(file));
  }
  return { text: kept.join(""), omitted };
}

/**
 * How a checked file is opened: no link at the last step even if one appeared since the check (O_NOFOLLOW),
 * and a pipe swapped in never blocks the open (O_NONBLOCK). Windows has neither flag, so there the open
 * follows a link that appeared since, and the identity check after it is what refuses the file.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Whether the file opened is the file checked: the same device and file id. The id is compared whole (an
 * NTFS id does not fit in a number, and rounded it matches its neighbours) and is never one that names no
 * file, which would match any other: 0, or all ones (-1 as Node reads it), which ReFS (a Dev Drive) gives a
 * file whose id does not fit in 64 bits.
 */
export function sameFile(
  opened: { dev: bigint; ino: bigint },
  checked: { dev: bigint; ino: bigint },
): boolean {
  return opened.ino !== 0n && opened.ino !== -1n && opened.ino === checked.ino && opened.dev === checked.dev;
}

/**
 * A directory's device, by a handle on it. On Windows the harvest compares devices this way: with libuv 1.49
 * and 1.50 (Node 22.12 to 22.16, 23.1 to 23.11, 24.0 to 24.1), where Windows has GetFileInformationByName
 * (11 24H2, Server 2025), a stat by path reads the device from the wrong field (0 on NTFS), and a stat by
 * handle is right on every version.
 */
async function deviceOf(dir: string): Promise<bigint> {
  const handle = await open(dir, constants.O_RDONLY);
  try {
    return (await handle.stat({ bigint: true })).dev;
  } finally {
    await handle.close();
  }
}

/**
 * A file the run left, by its path in the workspace, read only as a regular file reached without a symbolic
 * link (a junction, on Windows) and inside the workspace. A run that leaves `report.md -> /proc/self/environ`,
 * or a linked directory on the way, would otherwise hand the worker's own environment (the database URL, its
 * token, the model keys) to the company as an artifact. Such a path goes into `refused` and is never opened.
 * Null: not there, not a regular file, or over the cap.
 */
async function readInWorkspace(
  root: string,
  rel: string,
  maxBytes: number,
  refused: string[],
): Promise<Buffer | null> {
  const inner = path.relative(root, path.join(root, rel));
  if (!inner) return null;
  if (inner === ".." || inner.startsWith(`..${path.sep}`) || path.isAbsolute(inner)) {
    refused.push(rel);
    return null;
  }
  try {
    // lstat every step, the file included: a link anywhere on the way is refused.
    let at = root;
    let last: BigIntStats | null = null;
    for (const part of inner.split(path.sep)) {
      at = path.join(at, part);
      last = await lstat(at, { bigint: true });
      if (last.isSymbolicLink()) {
        refused.push(rel);
        return null;
      }
    }
    if (!last?.isFile() || last.size > maxBytes) return null;
    const [realRoot, real] = await Promise.all([realpath(root), realpath(at)]);
    const within = path.relative(realRoot, real);
    if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      refused.push(rel);
      return null;
    }
    const handle = await open(at, READ_FLAGS);
    try {
      // The file opened must be the one checked above. On Windows its device is the workspace's, both read by
      // a handle (deviceOf); elsewhere the one lstat found.
      const opened = await handle.stat({ bigint: true });
      const dev = process.platform === "win32" ? await deviceOf(root) : last.dev;
      if (!sameFile(opened, { dev, ino: last.ino })) {
        refused.push(rel);
        return null;
      }
      const buf = await handle.readFile();
      return buf.length > maxBytes ? null : buf;
    } finally {
      await handle.close();
    }
  } catch (err) {
    // A link that appeared at the last step since the lstat.
    if ((err as NodeJS.ErrnoException).code === "ELOOP") refused.push(rel);
    return null;
  }
}

async function readText(
  root: string,
  rel: string,
  maxBytes: number,
  refused: string[],
): Promise<string | null> {
  const buf = await readInWorkspace(root, rel, maxBytes, refused);
  if (!buf || buf.includes(0)) return null; // binary
  return buf.toString("utf8");
}

/** A file as an artifact: text as it is, anything with a NUL byte as base64. Null over the cap or unreadable. */
async function readArtifact(
  root: string,
  rel: string,
  maxBytes: number,
  refused: string[],
): Promise<{ content: string; encoding: "utf8" | "base64" } | null> {
  const buf = await readInWorkspace(root, rel, maxBytes, refused);
  if (!buf) return null;
  return buf.includes(0)
    ? { content: buf.toString("base64"), encoding: "base64" }
    : { content: buf.toString("utf8"), encoding: "utf8" };
}

/**
 * Where git checks a link out as a plain file holding its target (core.symlinks false, as Git for Windows has
 * it), git add keeps the link's type for that file, whatever the run wrote in it (or staged itself), and the
 * diff would show the link pointing at the file's new contents. The run wrote a file there: each committed
 * link (HEAD's) still in the index as one, whose file is now a regular one with other contents, leaves the
 * index and comes back as that file, forced, since the add after this skips a path .gitignore matches. The
 * diff then shows the link replaced by the file, as on Linux, where this changes nothing. A link the run took
 * out of the index itself stays out: forced back, an ignored file it keeps locally would land in the diff.
 * Nothing is forced when the removal fails, and a failed add puts HEAD's entries back.
 */
async function unstageLinksMadeFiles(ws: Workspace): Promise<void> {
  const [tree, index, changed] = await Promise.all([
    git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], ws.dir),
    git(["ls-files", "--stage", "-z"], ws.dir),
    git(
      ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
      ws.dir,
    ),
  ]);
  if (tree.code !== 0 || index.code !== 0 || changed.code !== 0) return;
  const links = (out: string, entry: RegExp) =>
    new Set(out.split("\0").flatMap((e) => entry.exec(e)?.[1] ?? []));
  // ls-tree: mode, type, object, path; ls-files --stage: mode, object, stage, path.
  const committed = links(tree.stdout, /^120000 blob [0-9a-f]+\t(.+)$/s);
  const staged = links(index.stdout, /^120000 [0-9a-f]+ \d\t(.+)$/s);
  const differs = new Set(changed.stdout.split("\0"));
  const files: string[] = [];
  for (const link of committed) {
    // The handover and the blocked note stay out of the add, so out of this too.
    if (link === HANDOVER_FILE || link === BLOCKED_FILE || !staged.has(link) || !differs.has(link)) continue;
    if ((await lstat(path.join(ws.dir, link)).catch(() => null))?.isFile()) files.push(link);
  }
  if (!files.length) return;
  const literal = ["--literal-pathspecs"];
  const out = await git(
    // --force: an entry the run staged and then changed again ("staged content different from both the file and
    // the HEAD") is taken out too, not the whole list refused; --cached never touches the file itself.
    [...literal, "rm", "--cached", "--force", "--quiet", "--ignore-unmatch", "--", ...files],
    ws.dir,
  );
  if (out.code !== 0) return;
  const back = await git([...literal, "add", "--force", "--", ...files], ws.dir);
  if (back.code !== 0) await git([...literal, "reset", "--quiet", "--", ...files], ws.dir);
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
    refusedOutputs: [],
    filesWritten: [],
    baseSha: null,
    diffOmitted: [],
    unreadable: null,
  };
  if (ws.repo) await restoreGitDir(ws);
  const refused = out.refusedOutputs;
  out.handover = clip((await readText(ws.dir, HANDOVER_FILE, maxBytes, refused))?.trim() ?? "", 4000) || null;
  out.blocked = clip((await readText(ws.dir, BLOCKED_FILE, maxBytes, refused))?.trim() ?? "", 1000) || null;

  let candidates: string[];
  if (declaredOutputs.length) {
    candidates = declaredOutputs;
  } else if (ws.repo) {
    // -z: every name as it is (a space, a quote, a character git would escape); --no-renames: a moved file by its
    // new name, as the diff has it.
    const status = await gitBytes(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
      ws.dir,
    );
    // One whose name is not UTF-8 is left out here; the read-back below fails a run that would complete on it.
    const entries = decodeNames(status.stdout).names;
    // A path git calls deleted is not a file the run wrote, whatever is on disk there: a file the run took out of
    // the index and kept, ignored (a local .env), is listed only so. One it kept and git does not ignore is
    // listed again as untracked. A merge conflict's side (UD, DU) is a file the run may have resolved.
    const deleted = (xy: string) => xy.includes("D") && !xy.includes("U");
    candidates = entries
      .filter((entry) => entry.length > 3 && !deleted(entry.slice(0, 2)))
      .map((entry) => entry.slice(3))
      .filter((p) => p !== HANDOVER_FILE && p !== BLOCKED_FILE)
      .slice(0, MAX_UNDECLARED_FILES);
  } else {
    // By their bytes, as in a repository: a name that is not UTF-8 is left out, and fails a run that would
    // complete, where read loosely it would collide with another.
    const entries = await readdir(ws.dir, { withFileTypes: true, encoding: "buffer" });
    const files = entries.filter((e) => e.isFile());
    const { names, notUtf8 } = decodeNames(Buffer.concat(files.flatMap((e) => [e.name, Buffer.from([0])])));
    if (notUtf8.length)
      out.unreadable = `the run's changes could not be read back for review (a file's name is not UTF-8: ${notUtf8[0]})`;
    candidates = names
      .filter((n) => n !== HANDOVER_FILE && n !== BLOCKED_FILE)
      .slice(0, MAX_UNDECLARED_FILES);
  }
  for (const rel of candidates) {
    const read = await readArtifact(ws.dir, rel, maxBytes, refused);
    if (read === null) {
      if (declaredOutputs.includes(rel) && !refused.includes(rel)) out.missingOutputs.push(rel);
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
    await unstageLinksMadeFiles(ws);
    const add = await git(
      ["add", "-A", "--", ".", `:(exclude)${HANDOVER_FILE}`, `:(exclude)${BLOCKED_FILE}`],
      ws.dir,
    );
    // A folder git cannot open it passes over with a warning, and adds the rest: that is part of the change.
    const skipped = /^warning: could not open directory .*$/m.exec(add.stderr)?.[0];
    const staged = add.code === 0 && !skipped;
    // Every name the diff will carry, read as bytes: one that is not UTF-8 is no name the review can hold.
    const notUtf8 = staged
      ? decodeNames(
          (await gitBytes(["diff", "--cached", "--name-only", "-z", "--no-renames"], ws.dir)).stdout,
        ).notUtf8
      : [];
    if (notUtf8.length)
      out.unreadable = `the run's changes could not be read back for review (a file's name is not UTF-8: ${notUtf8[0]})`;
    else {
      const diff = staged
        ? await git(
            // core.quotePath false: a name past ASCII as it is; one with a quote or a control character is
            // still quoted, and parseUnifiedDiff reads it back.
            [
              "-c",
              "core.quotePath=false",
              "diff",
              "--cached",
              "--no-color",
              "--no-renames",
              "--no-ext-diff",
              "--no-textconv",
            ],
            ws.dir,
          )
        : { ...add, code: add.code || 1, stderr: skipped ?? add.stderr };
      // A part of the change the review would not show (an index.lock a git ended part-way left behind): no
      // diff, and the run that would complete fails with this rather than send half of it for review.
      if (diff.code === 0) diffText = diff.stdout;
      else {
        let why = gitReason(diff.stderr);
        // The worker's own folders are none of the run's business: the clone's path as git writes it, `.`.
        for (const at of await Promise.all([ws.dir, realpath(ws.dir).catch(() => ws.dir)]))
          for (const form of new Set([at, at.replace(/\\/g, "/")])) why = why.split(form).join(".");
        out.unreadable = `the run's changes could not be read back for review (git: ${why || "no message"})`;
      }
    }
  } else {
    // Each file once, under the name git would give it (a declared `./report.md` is report.md); one no tree
    // holds (a file named .git) is not in it.
    const rendered = new Set<string>();
    diffText = out.artifacts
      .filter((a) => a.kind !== "handover" && a.kind !== "diff")
      .flatMap((a) => {
        const name = path.posix.normalize(a.path);
        if (rendered.has(name) || !isTreePath(name)) return [];
        rendered.add(name);
        return [a.encoding === "base64" ? renderBinaryFileDiff(name) : renderNewFileDiff(name, a.content)];
      })
      .join("");
  }
  const fitted = fitDiff(diffText, maxBytes);
  out.diffOmitted = fitted.omitted;
  if (fitted.text.trim()) {
    out.artifacts.push({ path: "changes.diff", kind: "diff", content: fitted.text, encoding: "utf8" });
  }
  return out;
}
