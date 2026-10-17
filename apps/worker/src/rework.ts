// A rework run starts from the round the reviewer sent back: that round's diff, checked against the
// sha256 the review recorded, applied to the fresh clone before the engine starts. Uncommitted, so the
// harvest still diffs against the base branch and the next round carries the whole change, which keeps
// the review's hunks and the pull request right. git apply is all or nothing: when the base branch moved
// and any part no longer applies, the clone stays as it was and the run says which files.

import { rm, writeFile } from "node:fs/promises";
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
  const patch = path.join(ws.dir, ".git", PATCH_FILE);
  await writeFile(patch, rework.diff, "utf8");
  const res = await git(["apply", "--whitespace=nowarn", patch], ws.dir);
  await rm(patch, { force: true });
  if (res.code === 0) return { round, applied: true, files: parseUnifiedDiff(rework.diff).length };
  const head = (await git(["rev-parse", "HEAD"], ws.dir)).stdout.trim();
  const moved = rework.baseSha !== null && head !== "" && head !== rework.baseSha;
  return { round, applied: false, reason: whyNotApplied(res.stderr, round, branch, moved) };
}
