// A rework run starts from the round the reviewer sent back: that round's diff, checked against the
// sha256 the review recorded, applied to the fresh clone before the engine starts. Uncommitted, so the
// harvest still diffs against the base branch and the next round carries the whole change, which keeps
// the review's hunks and the pull request right. git apply checks it all before it writes: when the base
// branch moved and any part no longer applies, the clone stays as it was and the run says which files, and
// what it wrote before it failed to write the rest is undone. It writes nothing outside the clone, into
// .git or through a link; and a round that would leave a link behind, or
// whose diff makes one or changes one the repository holds, is undone, so the engine never starts with one
// the run did not make (the harvest refuses links anyway).
// The clone is read whole for that, a submodule's folder included: git status and git clean never look
// inside one, and a clone leaves it empty. A round that copies or renames a file is refused before it is
// applied: the harvest diffs with --no-renames, so a real round never does, and a copy is how a link the
// repository holds would land where git does not look.

import { lstat, mkdir, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseUnifiedDiff, sha256Hex, type RunCompleteInput } from "@rosterdock/shared";
import { clip } from "./text.js";
import { git, redactGit, type Workspace } from "./workspace.js";

/** The run spec's `rework`: the round sent back, its diff, and what the review recorded about it. */
export interface Rework {
  round: number;
  diffSha256: string;
  /** The commit the round's diff was taken against. */
  baseSha: string | null;
  diff: string;
}

export type ReworkStart =
  { round: number; applied: true; files: number } | { round: number; applied: false; reason: string };

/** Inside .git, so the diff waiting for git apply is never part of the run's own. */
const PATCH_FILE = "rosterdock-rework.diff";
const MAX_REASON_CHARS = 300;

function names(paths: string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/**
 * Why git apply refused, in a phrase: the files it names (its English messages; anything else is
 * quoted), binary files apart, since the review's diff carries no bytes for them.
 */
export function whyNotApplied(stderr: string, round: number, branch: string, moved: boolean): string {
  const binary = new Set<string>();
  const files = new Set<string>();
  for (const line of stderr.split("\n")) {
    const bin = /^error: cannot apply binary patch to '(.+)' without full index line$/.exec(line);
    if (bin) binary.add(bin[1]!);
    const file =
      /^error: (.+?): (?:patch does not apply|already exists in working directory|No such file or directory)$/.exec(
        line,
      );
    if (file) files.add(file[1]!);
  }
  const conflicts = [...files].filter((f) => !binary.has(f));
  const parts: string[] = [];
  if (conflicts.length)
    parts.push(
      moved
        ? `${names(conflicts)} changed on ${branch} since round ${round}`
        : `${names(conflicts)} did not apply`,
    );
  if (binary.size)
    parts.push(
      `${names([...binary])} ${binary.size === 1 ? "is a binary file" : "are binary files"}, which the review's diff does not carry`,
    );
  if (!parts.length) {
    const first = stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    parts.push(`git could not apply them (${redactGit(first ?? "no message").replace(/^error: /, "")})`);
  }
  const reason = parts.join("; ");
  return clip(reason, MAX_REASON_CHARS, "…");
}

/** What the engine reads at the end of its brief when the round did not carry over (the pack says it may). */
export function freshStartBrief(start: Extract<ReworkStart, { applied: false }>, branch: string): string {
  return [
    "## Starting point",
    `Round ${start.round}'s changes did not carry over: ${start.reason}. Your working directory is a clean clone of the current ${branch}, without them. Make the change again on it, addressing the comments above, and say in your handover that you started over.`,
  ].join("\n");
}

/** The completion tells the board how the run started; a fresh start leads the run's handover. */
export function withRework(
  completion: RunCompleteInput,
  start: ReworkStart,
  branch: string,
): RunCompleteInput {
  const rework = start.applied
    ? { round: start.round, applied: true }
    : { round: start.round, applied: false, reason: start.reason };
  if (start.applied || completion.status !== "completed") return { ...completion, rework };
  const note = `Started from a fresh copy of ${branch}: round ${start.round}'s changes did not carry over (${start.reason}).`;
  return {
    ...completion,
    rework,
    // fitCompletion cuts it to what the board takes.
    summary: `${note}${completion.summary ? ` ${completion.summary}` : ""}`,
  };
}

/**
 * What the apply left as a symbolic link: every path git status lists after it, ignored ones included
 * (a fresh clone has none of its own), checked with lstat. Null when git cannot say.
 */
async function linksLeft(ws: Workspace): Promise<string[] | null> {
  const status = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--no-renames"],
    ws.dir,
  );
  if (status.code !== 0) return null;
  const links: string[] = [];
  for (const entry of status.stdout.split("\0")) {
    const rel = entry.slice(3);
    if (rel && (await lstat(path.join(ws.dir, rel)).catch(() => null))?.isSymbolicLink()) links.push(rel);
  }
  return links;
}

/** The paths `git apply --numstat -z` names: one per file, or a rename's two after an empty one. */
function numstatPaths(out: string): string[] {
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const m = /^(?:\d+|-)\t(?:\d+|-)\t(.*)$/s.exec(fields[i]!);
    if (!m) continue;
    if (m[1]) paths.push(m[1]);
    else {
      paths.push(...fields.slice(i + 1, i + 3));
      i += 2;
    }
  }
  return paths;
}

/**
 * What the diff makes a symbolic link (mode 120000), as git apply reads it, and the links the repository holds
 * that it changes in place, by their mode in HEAD's tree: a diff need not spell a link's mode (no index line,
 * another mode, the mode spelled otherwise), and git apply then takes it from the diff or from the file on
 * disk. Where the clone has no symlink support (Windows, core.symlinks false) that file is a plain one holding
 * the link's target, and git writes a new target into it, which linksLeft never sees. A link the diff deletes
 * (or replaces with a file: a delete, then a new file) is not one. What the diff names is read with what the
 * index calls what the apply changed, and compared without case where the file system ignores it (Windows,
 * macOS: core.ignorecase), which takes `L` for the link `l`. Null when git cannot say.
 */
async function linksDeclared(
  ws: Workspace,
  patch: string,
  fold: (p: string) => string,
): Promise<string[] | null> {
  const [summary, numstat, tree, modified] = await Promise.all([
    git(["apply", "--summary", patch], ws.dir),
    git(["apply", "--numstat", "-z", patch], ws.dir),
    git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], ws.dir),
    git(["ls-files", "--modified", "-z"], ws.dir),
  ]);
  if (summary.code !== 0 || numstat.code !== 0 || tree.code !== 0 || modified.code !== 0) return null;
  const made: string[] = [];
  const deleted = new Set<string>();
  for (const line of summary.stdout.split("\n")) {
    const link = /^ (?:create mode 120000|mode change \d+ => 120000) (.+)$/.exec(line);
    if (link) made.push(link[1]!);
    const gone = /^ delete mode \d+ (.+)$/.exec(line);
    if (gone) deleted.add(fold(gone[1]!));
  }
  const committed = new Set(
    tree.stdout.split("\0").flatMap((entry) => {
      const link = /^120000 \S+ [0-9a-f]+\t(.+)$/s.exec(entry);
      return link ? [fold(link[1]!)] : [];
    }),
  );
  // One name a path: the index's own where it has one (`l`, where the diff said `L`).
  const touched = new Map<string, string>();
  for (const p of [...numstatPaths(numstat.stdout), ...modified.stdout.split("\0").filter(Boolean)])
    touched.set(fold(p), p);
  const changed = [...touched].filter(([at]) => committed.has(at) && !deleted.has(at)).map(([, p]) => p);
  return [...made, ...changed];
}

/**
 * A path as the clone compares it: folded where the file system ignores case (Windows, macOS:
 * core.ignorecase), so `L` and `l` are one. A match is a refusal, so folding more is the safe side.
 */
async function caseFold(ws: Workspace): Promise<(p: string) => string> {
  const ignorecase = await git(["config", "--bool", "core.ignorecase"], ws.dir);
  return ignorecase.stdout.trim() === "true" ? (p) => p.toLowerCase() : (p) => p;
}

/** Where a diff copies or renames files to (or from, where it names no destination). */
function copiedOrRenamed(diff: string): string[] {
  const moved = [...diff.matchAll(/^(?:copy|rename) (from|to|old|new) (.+)$/gm)];
  const to = moved.filter((m) => m[1] === "to" || m[1] === "new");
  return (to.length ? to : moved).map((m) => m[2]!);
}

/**
 * Every symbolic link in the clone, by its path, with its target: every folder read, .git apart, where git
 * status would list nothing inside a submodule's. Null when a folder cannot be read.
 */
async function linksOnDisk(dir: string): Promise<Map<string, string> | null> {
  const links = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (!rel && entry.name === ".git") continue;
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) links.set(at, await readlink(path.join(dir, at)));
      else if (entry.isDirectory()) await walk(at);
    }
  };
  try {
    await walk("");
    return links;
  } catch {
    return null;
  }
}

/** The links in the clone that it did not hold `before` (the repository's own) or that point elsewhere now. */
async function linksMade(dir: string, before: Map<string, string>): Promise<string[] | null> {
  const now = await linksOnDisk(dir);
  return now && [...now].filter(([at, target]) => before.get(at) !== target).map(([at]) => at);
}

/**
 * Back to the clean clone: tracked files as committed, the rest removed (git removes a link, never its
 * target), and each submodule's folder empty again, as the clone left it (it never fetches one). Checked
 * after: a link the clone did not hold before means the clone is not clean, and the run goes no further.
 */
async function undoApply(ws: Workspace, before: Map<string, string>): Promise<void> {
  const failed = new Error("the previous round's changes could not be undone in the clone");
  const reset = await git(["reset", "--hard", "--quiet"], ws.dir);
  const clean = await git(["clean", "-ffdxq"], ws.dir);
  const index = await git(["ls-files", "--stage", "-z"], ws.dir);
  if (reset.code !== 0 || clean.code !== 0 || index.code !== 0) throw failed;
  for (const entry of index.stdout.split("\0")) {
    const sub = /^160000 [0-9a-f]+ \d\t(.+)$/s.exec(entry)?.[1];
    if (!sub) continue;
    // The folders on its way are the clone's own, never a link (reset put them back), so nothing outside
    // is touched; rm removes a link it meets inside, never what it points at.
    let at = ws.dir;
    for (const part of sub.split("/").slice(0, -1)) {
      at = path.join(at, part);
      if (!(await lstat(at).catch(() => null))?.isDirectory()) throw failed;
    }
    await rm(path.join(ws.dir, sub), { recursive: true, force: true });
    await mkdir(path.join(ws.dir, sub));
  }
  if ((await linksMade(ws.dir, before))?.length !== 0) throw failed;
}

function linksReason(links: string[]): string {
  return clip(
    `${names(links)} ${links.length === 1 ? "is a symbolic link" : "are symbolic links"}, which a rework run does not carry over`,
    MAX_REASON_CHARS,
    "…",
  );
}

/** Apply the round sent back to the run's fresh clone (of a repository), or say why the run starts from the clean clone. */
export async function applyPreviousRound(
  ws: Workspace,
  rework: Rework,
  branch: string,
): Promise<ReworkStart> {
  const { round } = rework;
  if (sha256Hex(rework.diff) !== rework.diffSha256)
    return {
      round,
      applied: false,
      reason: `the changes the board sent do not match its record of round ${round}`,
    };
  const copies = copiedOrRenamed(rework.diff);
  if (copies.length)
    return {
      round,
      applied: false,
      reason: clip(
        `${names(copies)} ${copies.length === 1 ? "is a copy or a rename" : "are copies or renames"} of another file, which a rework run does not carry over`,
        MAX_REASON_CHARS,
        "…",
      ),
    };
  const before = await linksOnDisk(ws.dir);
  if (!before) return { round, applied: false, reason: "the clone could not be read to check them" };
  const patch = path.join(ws.dir, ".git", PATCH_FILE);
  await writeFile(patch, rework.diff, "utf8");
  const res = await git(["apply", "--whitespace=nowarn", patch], ws.dir);
  const fold = await caseFold(ws);
  const [left, declared, made] =
    res.code === 0
      ? await Promise.all([linksLeft(ws), linksDeclared(ws, patch, fold), linksMade(ws.dir, before)])
      : [null, null, null];
  await rm(patch, { force: true });
  if (res.code === 0) {
    // Each link once, by the index's name where git has one (`l`, though the diff or the disk says `L`).
    const named = new Map<string, string>();
    for (const p of [...(made ?? []), ...(left ?? []), ...(declared ?? [])]) named.set(fold(p), p);
    const links = left && declared && made && [...named.values()].sort();
    if (links?.length === 0) return { round, applied: true, files: parseUnifiedDiff(rework.diff).length };
    await undoApply(ws, before);
    return {
      round,
      applied: false,
      reason: links ? linksReason(links) : "git could not list what they changed",
    };
  }
  // git apply checks everything first, but can still fail while writing (a new file under a path that is a file),
  // with what it wrote before still there: a link among it, maybe. The run starts from the clean clone it is told of.
  await undoApply(ws, before);
  const head = (await git(["rev-parse", "HEAD"], ws.dir)).stdout.trim();
  const moved = rework.baseSha !== null && head !== "" && head !== rework.baseSha;
  return { round, applied: false, reason: whyNotApplied(res.stderr, round, branch, moved) };
}
