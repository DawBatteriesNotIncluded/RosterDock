// What follows a decision. Request changes restarts the author with the
// comments in their pack (a fresh task run; the pack renderer adds the review
// section). Kept apart from the service so the routes and the board tools
// share one path.

import { parseUnifiedDiff, payloadSha256, sha256Hex, type ActorRef, type DiffFile } from "@rosterdock/shared";
import type { Db } from "../db/pool.js";
import { openChange, type GitHosts } from "../git/hosts.js";
import { artifactBytes, artifactText } from "../storage/artifacts.js";
import type { ObjectStore } from "../storage/s3.js";
import { HttpError } from "../http-error.js";
import { mutate } from "../mutate.js";
import type { RunQueue } from "../queue.js";
import { dispatchRun } from "../runs/service.js";
import type { BinaryDetail } from "./checks.js";
import type { PullRequestRow, ReviewFileRow, ReviewRow } from "./service.js";
import { MAX_REVIEW_ROUNDS } from "../peter/replan.js";

export interface Restarted {
  runId: string | null;
  /** Why the author was not restarted; the review still waits with changes requested. */
  reason: string | null;
}

/**
 * The same value, field by field, a field left undefined the same as one left out (as JSON, and so the stored
 * rows, has it). Stops at the first difference and copies nothing: a near-cap diff is a million lines.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let fields = 0;
  for (const k in x) {
    if (x[k] === undefined) continue;
    if (!same(x[k], y[k])) return false;
    fields++;
  }
  for (const k in y) if (y[k] !== undefined) fields--;
  return fields === 0;
}

/**
 * The files the review approved: the rows its round stored, which the round's diff, read again, must still read
 * as. Where an older parser stored a diff otherwise than it reads, neither is what the review showed and the
 * secrets check scanned whole, so nothing is merged: a new round reads it again. A reason where it is refused.
 */
async function approvedFiles(
  db: Db,
  store: ObjectStore | null,
  review: ReviewRow,
  round: number,
): Promise<DiffFile[] | string> {
  if (review.round !== round)
    return `the review has moved on to round ${review.round} since round ${round} was approved`;
  const rows = (
    await db.query<ReviewFileRow>(
      "SELECT * FROM review_files WHERE review_id = $1 AND round = $2 ORDER BY position",
      [review.id, round],
    )
  ).rows.map<DiffFile>((f) => ({
    path: f.path,
    status: f.status,
    binary: f.is_binary,
    additions: f.additions,
    deletions: f.deletions,
    hunks: f.hunks,
  }));
  const art = (
    await db.query<{ content: string | null; object_key: string | null }>(
      "SELECT content, object_key FROM artifacts WHERE run_id = $1 AND kind = 'diff'",
      [review.run_id],
    )
  ).rows[0];
  // A round opened from no diff shows nothing, and hashes as the empty one.
  const text = art ? await artifactText(store, art) : "";
  if (text === null) return "the review's diff could not be read from the object store";
  if (sha256Hex(text) !== review.diff_sha256)
    return "the review's diff no longer matches the sha256 it was opened with";
  let files: DiffFile[];
  try {
    files = parseUnifiedDiff(text);
  } catch (err) {
    return `the review's diff could not be read: ${(err as Error).message}`;
  }
  const shown = (f: DiffFile) => [f.path, f.status, f.binary, f.additions, f.deletions, f.hunks];
  if (files.length !== rows.length || files.some((f, i) => !same(shown(f), shown(rows[i]!))))
    return "the review's diff reads otherwise than the files the review showed (an older board read it): veto the approval and request changes, for a round this board reads";
  return rows;
}

/**
 * A binary file in the diff travels as the bytes the run reported under that path, base64 by path: only as the
 * bytes its review's secrets check scanned, by their sha256, and only where a person approved (as the payload
 * says), as the review shows none of them. One the run sent no bytes for is left out, and the provider refuses the change naming it.
 * A reason where they are refused.
 */
async function approvedBinaries(
  db: Db,
  store: ObjectStore | null,
  review: ReviewRow,
  payload: { round: number; approvedBy?: ActorRef },
  files: DiffFile[],
): Promise<Record<string, string> | string> {
  const round = payload.round;
  const binaries: Record<string, string> = {};
  const wanted = files.filter((f) => f.binary && f.status !== "deleted");
  if (!wanted.length) return binaries;
  const scanned = ((
    await db.query<{ detail: Partial<BinaryDetail> }>(
      "SELECT detail FROM review_checks WHERE review_id = $1 AND round = $2 AND kind = 'secrets'",
      [review.id, round],
    )
  ).rows[0]?.detail ?? {}) as Partial<BinaryDetail>;
  for (const f of wanted) {
    // Who approved, as the payload bound by sha256 says: not the review as it stands now.
    if (payload.approvedBy?.kind !== "user")
      return `${f.path} is binary, which the review cannot show: only a person approves it`;
    const bound = scanned.binaries?.find((b) => b.path === f.path);
    if (!bound) {
      if (scanned.unshown?.includes(f.path)) continue;
      return `the review did not scan the bytes of ${f.path} (an older board opened it): veto the approval and request changes, for a round this board reads`;
    }
    const art = (
      await db.query<{ content: string | null; object_key: string | null; encoding: string | null }>(
        "SELECT content, object_key, encoding FROM artifacts WHERE run_id = $1 AND path = $2",
        [review.run_id, f.path],
      )
    ).rows[0];
    const bytes = art ? await artifactBytes(store, art) : null;
    if (!bytes || sha256Hex(bytes) !== bound.sha256)
      return `the bytes of ${f.path} are not the ones its review scanned`;
    binaries[f.path] = bytes.toString("base64");
  }
  return binaries;
}

/**
 * Execute a proposed pull request: the stored payload must still hash to the
 * sha256 it was approved with, then the provider opens it. The outcome, opened
 * or failed with the reason, is recorded and announced; nothing is retried
 * without a person.
 */
export async function executePullRequest(
  db: Db,
  hosts: GitHosts,
  companyId: string,
  pullRequestId: string,
  /** Where a binary artifact over the inline limit is read from. */
  store: ObjectStore | null = null,
): Promise<PullRequestRow> {
  const row = (
    await db.query<PullRequestRow>("SELECT * FROM pull_requests WHERE id = $1 AND company_id = $2", [
      pullRequestId,
      companyId,
    ])
  ).rows[0];
  if (!row) throw new HttpError(404, "pull request not found");
  if (row.status !== "proposed") return row;
  const payload = row.payload as {
    /** github or gitlab; rows from before the second host carry owner and repo instead of path. */
    provider?: string;
    path?: string;
    owner?: string;
    repo?: string;
    baseSha: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
    commitMessage: string;
    reviewId: string;
    round: number;
    /** Who approved; rows from before carry none. */
    approvedBy?: ActorRef;
  };
  const actor: ActorRef = { kind: "user", id: "00000000-0000-4000-8000-000000000000" };
  const review = (await db.query<ReviewRow>("SELECT * FROM reviews WHERE id = $1", [row.review_id])).rows[0];
  const decider: ActorRef =
    review?.decided_by_kind && review.decided_by_id
      ? { kind: review.decided_by_kind, id: review.decided_by_id }
      : actor;
  let outcome: { number: number; url: string } | null = null;
  let error: string | null = null;
  if (payloadSha256(row.payload) !== row.payload_sha256) {
    error = "the pull request payload no longer matches the sha256 it was approved with";
  } else if (!review) {
    error = "the review this pull request was approved in is gone";
  } else if (review.status !== "approved") {
    error = "the review is no longer approved: a person vetoed it before the pull request was opened";
  } else {
    // Whatever fails from here, the store included, fails the pull request and says why.
    try {
      // On the commit the run's clone was at, and no other: one the run checked out, or committed, would carry
      // into the pull request what its review never showed.
      const cloned =
        (
          await db.query<{ cloned_sha: string | null }>("SELECT cloned_sha FROM runs WHERE id = $1", [
            review.run_id,
          ])
        ).rows[0]?.cloned_sha ?? null;
      const files =
        cloned === null
          ? "the run recorded no commit its clone was at (an older worker ran it): veto the approval and request changes, for a round this board reads"
          : cloned !== payload.baseSha
            ? `the run's changes stand on ${payload.baseSha.slice(0, 12)}, not on ${cloned.slice(0, 12)}, the commit it was cloned at: the pull request would carry commits its review never showed`
            : await approvedFiles(db, store, review, payload.round);
      if (typeof files === "string") {
        error = files;
      } else {
        const binaries = await approvedBinaries(db, store, review, payload, files);
        if (typeof binaries === "string") throw new Error(binaries);
        outcome = await openChange(
          hosts,
          payload.provider ?? row.provider,
          payload.path ?? `${payload.owner}/${payload.repo}`,
          { ...payload, files, binaries },
        );
      }
    } catch (err) {
      error = (err as Error).message.slice(0, 2000);
    }
  }
  const { result } = await mutate(db, companyId, decider, async (ctx) => {
    const updated = (
      await ctx.client.query<PullRequestRow>(
        `UPDATE pull_requests SET status = $2, number = $3, url = $4, error = $5, executed_at = now() WHERE id = $1 RETURNING *`,
        [row.id, outcome ? "opened" : "failed", outcome?.number ?? null, outcome?.url ?? null, error],
      )
    ).rows[0]!;
    const task = (
      await ctx.client.query<{ number: number; title: string }>(
        "SELECT number, title FROM tasks WHERE id = $1",
        [row.task_id],
      )
    ).rows[0];
    await ctx.emit(
      outcome ? "pr.opened" : "pr.failed",
      { kind: "pull_request", id: row.id },
      {
        reviewId: row.review_id,
        taskId: row.task_id,
        number: task?.number,
        title: task?.title,
        repo: row.repo,
        provider: row.provider,
        headBranch: row.head_branch,
        prNumber: outcome?.number ?? null,
        url: outcome?.url ?? null,
        error,
      },
    );
    return updated;
  });
  return result;
}

export async function restartAuthor(
  db: Db,
  queue: RunQueue,
  companyId: string,
  actor: ActorRef,
  review: Pick<ReviewRow, "task_id" | "round" | "reviewer_name" | "open_comments">,
): Promise<Restarted> {
  // A teammate reviewer and its author could send the work back and forth for ever: at the cap the author
  // waits and Peter's loop puts the goal in front of a person. A person asking for another round gets it.
  if (actor.kind === "teammate" && review.round >= MAX_REVIEW_ROUNDS)
    return {
      runId: null,
      reason: `the review has gone ${review.round} rounds without approval; a person decides it now`,
    };
  try {
    const run = await dispatchRun(db, queue, companyId, actor, review.task_id, {
      note: `${review.reviewer_name ?? "The reviewer"} requested changes in review round ${review.round}; address the comments in your pack.`,
    });
    return { runId: run.id, reason: null };
  } catch (err) {
    return { runId: null, reason: err instanceof HttpError ? err.message : String(err) };
  }
}
