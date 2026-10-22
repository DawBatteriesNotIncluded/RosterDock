// The review object. One review per task, advanced a round each time the
// author's task run completes: the run's diff artifact is parsed into files
// and hunks, checks run, a reviewer teammate is picked and given a run of kind
// `review`. Comments anchor to file, hunk and line. Request changes sends the
// author back with the comments in the pack; approve is the one path to Done;
// humans can veto. Every change is a mutation with events.

import {
  type AssignReviewerInput,
  diffStats,
  DiffError,
  parseUnifiedDiff,
  payloadSha256,
  sha256Hex,
  type ActorRef,
  type Criterion,
  type DiffFile,
  type DiffHunk,
  type ReviewCommentInput,
  type ReviewScoreInput,
  type ReviewStatus,
  type Role,
  type RunCompleteInput,
} from "@rosterdock/shared";
import { describeActor } from "../actors.js";
import type { Db, Queryable } from "../db/pool.js";
import { closeChange, parseRepo, type GitHosts, type RepoRef } from "../git/hosts.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate, type MutationContext } from "../mutate.js";
import type { RunQueue } from "../queue.js";
import { artifactBytes, artifactText } from "../storage/artifacts.js";
import { extractSourceUrls, type SourceFetcher } from "./sources.js";
import type { ObjectStore } from "../storage/s3.js";
import { STATUS_LABEL, type TaskRow } from "../tasks/service.js";
import {
  BINARY_SCAN_BYTES,
  BLOCKING_CHECKS,
  evaluationCheck,
  outputsCheck,
  scanBinary,
  scoreCriteria,
  secretsCheck,
  sourcesCheck,
  testsCheck,
  type BinaryDetail,
  type CheckResult,
  type ScannedBinary,
  type CriterionScore,
} from "./checks.js";

export interface ReviewRow {
  id: string;
  company_id: string;
  task_id: string;
  run_id: string;
  round: number;
  author_kind: "user" | "teammate";
  author_id: string;
  reviewer_kind: "user" | "teammate" | null;
  reviewer_id: string | null;
  status: ReviewStatus;
  diff_sha256: string;
  base_sha: string | null;
  scores: CriterionScore[] | null;
  summary: string | null;
  decided_at: Date | null;
  decided_by_kind: "user" | "teammate" | null;
  decided_by_id: string | null;
  opened_at: Date;
  created_at: Date;
  updated_at: Date;
  // Joined for listings.
  task_number?: number;
  task_title?: string;
  project_id?: string;
  task_status?: string;
  author_name?: string | null;
  reviewer_name?: string | null;
  files_count?: number;
  additions?: number;
  deletions?: number;
  open_comments?: number;
}

export interface ReviewFileRow {
  id: string;
  review_id: string;
  round: number;
  position: number;
  path: string;
  status: "added" | "modified" | "deleted";
  is_binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ReviewCommentRow {
  id: string;
  review_id: string;
  round: number;
  file_path: string;
  hunk_index: number;
  line_new: number | null;
  line_old: number | null;
  author_kind: "user" | "teammate";
  author_id: string;
  body: string;
  resolved: boolean;
  created_at: Date;
  author_name?: string | null;
}

export interface ReviewCheckRow {
  id: string;
  review_id: string;
  round: number;
  kind: CheckResult["kind"];
  ok: boolean | null;
  title: string;
  detail: Record<string, unknown>;
  created_at: Date;
}

export interface ReviewDecisionRow {
  id: string;
  review_id: string;
  round: number;
  decider_kind: "user" | "teammate";
  decider_id: string;
  decision: "approve" | "request_changes" | "veto";
  note: string | null;
  created_at: Date;
  decider_name?: string | null;
}

export interface PullRequestRow {
  id: string;
  company_id: string;
  review_id: string;
  task_id: string;
  provider: string;
  repo: string;
  base_branch: string;
  head_branch: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  status: "proposed" | "opened" | "failed" | "closed";
  number: number | null;
  url: string | null;
  error: string | null;
  created_at: Date;
  executed_at: Date | null;
  closed_at: Date | null;
}

export const REVIEW_SELECT = `
  SELECT r.*, t.number AS task_number, t.title AS task_title, t.project_id, t.status AS task_status,
    CASE r.author_kind WHEN 'user' THEN au.name ELSE at.name END AS author_name,
    CASE r.reviewer_kind WHEN 'user' THEN ru.name ELSE rt.name END AS reviewer_name,
    (SELECT count(*)::int FROM review_files f WHERE f.review_id = r.id AND f.round = r.round) AS files_count,
    (SELECT coalesce(sum(f.additions), 0)::int FROM review_files f WHERE f.review_id = r.id AND f.round = r.round) AS additions,
    (SELECT coalesce(sum(f.deletions), 0)::int FROM review_files f WHERE f.review_id = r.id AND f.round = r.round) AS deletions,
    (SELECT count(*)::int FROM review_comments c WHERE c.review_id = r.id AND c.round = r.round AND NOT c.resolved) AS open_comments
  FROM reviews r
  JOIN tasks t ON t.id = r.task_id
  LEFT JOIN users au ON r.author_kind = 'user' AND au.id = r.author_id
  LEFT JOIN teammates at ON r.author_kind = 'teammate' AND at.id = r.author_id
  LEFT JOIN users ru ON r.reviewer_kind = 'user' AND ru.id = r.reviewer_id
  LEFT JOIN teammates rt ON r.reviewer_kind = 'teammate' AND rt.id = r.reviewer_id`;

export function reviewToJson(row: ReviewRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    taskId: row.task_id,
    taskNumber: row.task_number ?? null,
    taskTitle: row.task_title ?? null,
    taskStatus: row.task_status ?? null,
    projectId: row.project_id ?? null,
    runId: row.run_id,
    round: row.round,
    author: { kind: row.author_kind, id: row.author_id, name: row.author_name ?? null },
    reviewer:
      row.reviewer_kind && row.reviewer_id
        ? { kind: row.reviewer_kind, id: row.reviewer_id, name: row.reviewer_name ?? null }
        : null,
    status: row.status,
    diffSha256: row.diff_sha256,
    baseSha: row.base_sha,
    scores: row.scores,
    summary: row.summary,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedBy:
      row.decided_by_kind && row.decided_by_id ? { kind: row.decided_by_kind, id: row.decided_by_id } : null,
    fileCount: row.files_count ?? 0,
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
    openComments: row.open_comments ?? 0,
    openedAt: row.opened_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function fileToJson(row: ReviewFileRow) {
  return {
    id: row.id,
    path: row.path,
    status: row.status,
    binary: row.is_binary,
    additions: row.additions,
    deletions: row.deletions,
    hunks: row.hunks,
  };
}

export function commentToJson(row: ReviewCommentRow) {
  return {
    id: row.id,
    round: row.round,
    file: row.file_path,
    hunk: row.hunk_index,
    line: row.line_new,
    oldLine: row.line_old,
    author: { kind: row.author_kind, id: row.author_id, name: row.author_name ?? null },
    body: row.body,
    resolved: row.resolved,
    createdAt: row.created_at.toISOString(),
  };
}

export function checkToJson(row: ReviewCheckRow) {
  return { id: row.id, round: row.round, kind: row.kind, ok: row.ok, title: row.title, detail: row.detail };
}

export function decisionToJson(row: ReviewDecisionRow) {
  return {
    id: row.id,
    round: row.round,
    by: { kind: row.decider_kind, id: row.decider_id, name: row.decider_name ?? null },
    decision: row.decision,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

export function pullRequestToJson(row: PullRequestRow) {
  return {
    id: row.id,
    reviewId: row.review_id,
    provider: row.provider,
    repo: row.repo,
    baseBranch: row.base_branch,
    headBranch: row.head_branch,
    payloadSha256: row.payload_sha256,
    status: row.status,
    number: row.number,
    url: row.url,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    executedAt: row.executed_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

export async function loadReview(
  db: Queryable,
  companyId: string,
  reviewId: string,
  forUpdate = false,
): Promise<ReviewRow> {
  const res = await db.query<ReviewRow>(
    `${REVIEW_SELECT} WHERE r.id = $1 AND r.company_id = $2${forUpdate ? " FOR UPDATE OF r" : ""}`,
    [reviewId, companyId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("review");
  return row;
}

export async function reviewForTask(
  db: Queryable,
  companyId: string,
  taskId: string,
): Promise<ReviewRow | null> {
  const res = await db.query<ReviewRow>(`${REVIEW_SELECT} WHERE r.task_id = $1 AND r.company_id = $2`, [
    taskId,
    companyId,
  ]);
  return res.rows[0] ?? null;
}

export async function listReviews(
  db: Queryable,
  companyId: string,
  statuses: ReviewStatus[] | null,
): Promise<ReviewRow[]> {
  const params: unknown[] = [companyId];
  let where = "r.company_id = $1";
  if (statuses?.length) {
    params.push(statuses);
    where += ` AND r.status = ANY($${params.length}::text[])`;
  }
  const res = await db.query<ReviewRow>(`${REVIEW_SELECT} WHERE ${where} ORDER BY r.updated_at DESC`, params);
  return res.rows;
}

export async function listFiles(
  db: Queryable,
  review: Pick<ReviewRow, "id" | "round">,
): Promise<ReviewFileRow[]> {
  return (
    await db.query<ReviewFileRow>(
      "SELECT * FROM review_files WHERE review_id = $1 AND round = $2 ORDER BY position",
      [review.id, review.round],
    )
  ).rows;
}

const COMMENT_SELECT = `
  SELECT c.*, CASE c.author_kind WHEN 'user' THEN u.name ELSE t.name END AS author_name
  FROM review_comments c
  LEFT JOIN users u ON c.author_kind = 'user' AND u.id = c.author_id
  LEFT JOIN teammates t ON c.author_kind = 'teammate' AND t.id = c.author_id`;

export async function listComments(
  db: Queryable,
  reviewId: string,
  round?: number,
): Promise<ReviewCommentRow[]> {
  const params: unknown[] = [reviewId];
  let where = "c.review_id = $1";
  if (round !== undefined) {
    params.push(round);
    where += ` AND c.round = $${params.length}`;
  }
  return (await db.query<ReviewCommentRow>(`${COMMENT_SELECT} WHERE ${where} ORDER BY c.created_at`, params))
    .rows;
}

export async function listChecks(
  db: Queryable,
  review: Pick<ReviewRow, "id" | "round">,
): Promise<ReviewCheckRow[]> {
  return (
    await db.query<ReviewCheckRow>(
      "SELECT * FROM review_checks WHERE review_id = $1 AND round = $2 ORDER BY kind",
      [review.id, review.round],
    )
  ).rows;
}

export async function listDecisions(db: Queryable, reviewId: string): Promise<ReviewDecisionRow[]> {
  return (
    await db.query<ReviewDecisionRow>(
      `SELECT d.*, CASE d.decider_kind WHEN 'user' THEN u.name ELSE t.name END AS decider_name
       FROM review_decisions d
       LEFT JOIN users u ON d.decider_kind = 'user' AND u.id = d.decider_id
       LEFT JOIN teammates t ON d.decider_kind = 'teammate' AND t.id = d.decider_id
       WHERE d.review_id = $1 ORDER BY d.created_at`,
      [reviewId],
    )
  ).rows;
}

export async function listPullRequests(db: Queryable, reviewId: string): Promise<PullRequestRow[]> {
  return (
    await db.query<PullRequestRow>(
      "SELECT * FROM pull_requests WHERE review_id = $1 ORDER BY created_at DESC",
      [reviewId],
    )
  ).rows;
}

/** The full review: files with hunks, comments, checks, decisions and pull requests. */
export async function reviewDetail(db: Queryable, companyId: string, reviewId: string) {
  const review = await loadReview(db, companyId, reviewId);
  const [files, comments, checks, decisions, prs, task] = await Promise.all([
    listFiles(db, review),
    listComments(db, review.id),
    listChecks(db, review),
    listDecisions(db, review.id),
    listPullRequests(db, review.id),
    db.query<{ criteria: Criterion[]; declared_outputs: string[]; work_kind: "build" | "research" }>(
      "SELECT criteria, declared_outputs, work_kind FROM tasks WHERE id = $1",
      [review.task_id],
    ),
  ]);
  return {
    ...reviewToJson(review),
    criteria: task.rows[0]?.criteria ?? [],
    declaredOutputs: task.rows[0]?.declared_outputs ?? [],
    workKind: task.rows[0]?.work_kind ?? "build",
    files: files.map(fileToJson),
    comments: comments.map(commentToJson),
    checks: checks.map(checkToJson),
    decisions: decisions.map(decisionToJson),
    pullRequests: prs.map(pullRequestToJson),
  };
}

export type ReviewDetail = Awaited<ReturnType<typeof reviewDetail>>;

/**
 * Who reviews: a teammate whose role says so (reviewer, verifier, QA), never
 * the author, from the task's department first. Null leaves it to people.
 */
export async function pickReviewer(
  db: Queryable,
  companyId: string,
  departmentId: string | null,
  author: ActorRef,
): Promise<{ id: string; name: string } | null> {
  const res = await db.query<{ id: string; name: string; in_department: boolean }>(
    `SELECT t.id, t.name,
       EXISTS (SELECT 1 FROM department_members m WHERE m.teammate_id = t.id AND m.department_id = $2) AS in_department
     FROM teammates t
     WHERE t.company_id = $1 AND t.role ~* '(review|verif|\\mqa\\M|quality)'
       AND NOT ($3 = 'teammate' AND t.id = $4)
     ORDER BY in_department DESC, t.created_at`,
    [companyId, departmentId, author.kind, author.id],
  );
  const row = res.rows[0];
  return row ? { id: row.id, name: row.name } : null;
}

async function upsertCheck(
  ctx: MutationContext,
  review: Pick<ReviewRow, "id" | "round" | "company_id">,
  c: CheckResult,
) {
  await ctx.client.query(
    `INSERT INTO review_checks (company_id, review_id, round, kind, ok, title, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (review_id, round, kind) DO UPDATE SET ok = EXCLUDED.ok, title = EXCLUDED.title, detail = EXCLUDED.detail, created_at = now()`,
    [review.company_id, review.id, review.round, c.kind, c.ok, c.title, JSON.stringify(c.detail)],
  );
}

export interface OpenedReview {
  review: ReviewRow;
  reviewerTeammateId: string | null;
}

/**
 * Open (or advance) the review of a task from a run that just completed.
 * Runs inside the completion's transaction. The diff is the run's `diff`
 * artifact; without one the review opens with no files, which the reviewer
 * can send back.
 */
/**
 * Scan a completed run's binary files for its review, before the transaction that opens it: the bytes a pull
 * request would write for each file its diff calls binary, a file at a time, the board's other work let in
 * between, and no more than BINARY_SCAN_BYTES of them (past it, only their sha256). Empty where the diff cannot
 * be read; the review then shows none of it.
 */
export async function scanRunBinaries(
  db: Queryable,
  store: ObjectStore | null,
  runId: string,
  /** How many of their bytes are scanned; a test's is smaller. */
  budget = BINARY_SCAN_BYTES,
): Promise<Map<string, ScannedBinary>> {
  const scanned = new Map<string, ScannedBinary>();
  const diff = (
    await db.query<{ content: string | null; object_key: string | null }>(
      "SELECT content, object_key FROM artifacts WHERE run_id = $1 AND kind = 'diff'",
      [runId],
    )
  ).rows[0];
  const text = diff ? await artifactText(store, diff) : null;
  let files: DiffFile[] = [];
  try {
    files = text ? parseUnifiedDiff(text) : [];
  } catch (err) {
    if (!(err instanceof DiffError)) throw err;
  }
  for (const f of files) {
    if (!f.binary || f.status === "deleted" || scanned.has(f.path)) continue;
    const row = (
      await db.query<{ content: string | null; object_key: string | null; encoding: string | null }>(
        "SELECT content, object_key, encoding FROM artifacts WHERE run_id = $1 AND path = $2",
        [runId, f.path],
      )
    ).rows[0];
    const bytes = row ? await artifactBytes(store, row) : null;
    const scan = bytes === null || bytes.length <= budget;
    if (bytes && scan) budget -= bytes.length;
    scanned.set(f.path, scanBinary(f.path, bytes, scan));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return scanned;
}

export async function openReviewRound(
  ctx: MutationContext,
  run: { id: string; task_id: string; teammate_id: string; base_sha: string | null },
  task: Pick<TaskRow, "id" | "number" | "title" | "department_id" | "declared_outputs" | "criteria"> & {
    work_kind?: "build" | "research";
  },
  completion: Pick<RunCompleteInput, "checks">,
  store: ObjectStore | null = null,
  /** Fetches the sources a research document cites; null when the board does not reach the web. */
  sources: SourceFetcher | null = null,
  /** The run's binary files, scanned before the transaction (scanRunBinaries), by path. */
  scanned: Map<string, ScannedBinary> = new Map(),
): Promise<OpenedReview> {
  const rows = await ctx.client.query<{
    path: string;
    kind: string;
    content: string | null;
    object_key: string | null;
  }>("SELECT path, kind, content, object_key FROM artifacts WHERE run_id = $1", [run.id]);
  // The diff and the documents are read whole, from the row or the store; other kinds only by path.
  const artifacts = {
    rows: await Promise.all(
      rows.rows.map(async (a) => ({
        path: a.path,
        kind: a.kind,
        content: a.kind === "diff" || a.kind === "document" ? await artifactText(store, a) : a.content,
      })),
    ),
  };
  const diffText = artifacts.rows.find((a) => a.kind === "diff")?.content ?? "";
  // A diff the parser cannot read whole opens a review with none of it, and a secrets check that says why.
  let files: DiffFile[] = [];
  let unread: string | undefined;
  try {
    files = parseUnifiedDiff(diffText);
  } catch (err) {
    if (!(err instanceof DiffError)) throw err;
    unread = err.message;
  }
  const author: ActorRef = { kind: "teammate", id: run.teammate_id };
  const existing = (
    await ctx.client.query<ReviewRow>("SELECT * FROM reviews WHERE task_id = $1 FOR UPDATE", [task.id])
  ).rows[0];
  let reviewer: { kind: "user" | "teammate"; id: string; name: string | null } | null = null;
  if (existing?.reviewer_kind && existing.reviewer_id) {
    reviewer = { kind: existing.reviewer_kind, id: existing.reviewer_id, name: null };
  } else {
    const picked = await pickReviewer(ctx.client, ctx.companyId, task.department_id, author);
    if (picked) reviewer = { kind: "teammate", id: picked.id, name: picked.name };
  }
  const diffSha = sha256Hex(diffText);
  let review: ReviewRow;
  if (existing) {
    review = (
      await ctx.client.query<ReviewRow>(
        `UPDATE reviews SET run_id = $2, round = round + 1, status = 'open', diff_sha256 = $3, base_sha = $4,
           reviewer_kind = $5, reviewer_id = $6, scores = NULL, summary = NULL, decided_at = NULL,
           decided_by_kind = NULL, decided_by_id = NULL, opened_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [existing.id, run.id, diffSha, run.base_sha, reviewer?.kind ?? null, reviewer?.id ?? null],
      )
    ).rows[0]!;
  } else {
    review = (
      await ctx.client.query<ReviewRow>(
        `INSERT INTO reviews (company_id, task_id, run_id, author_kind, author_id, reviewer_kind, reviewer_id, diff_sha256, base_sha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          ctx.companyId,
          task.id,
          run.id,
          author.kind,
          author.id,
          reviewer?.kind ?? null,
          reviewer?.id ?? null,
          diffSha,
          run.base_sha,
        ],
      )
    ).rows[0]!;
  }
  for (const [i, f] of files.entries()) {
    await ctx.client.query(
      `INSERT INTO review_files (company_id, review_id, round, position, path, status, is_binary, additions, deletions, hunks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ctx.companyId,
        review.id,
        review.round,
        i,
        f.path,
        f.status,
        f.binary,
        f.additions,
        f.deletions,
        JSON.stringify(f.hunks),
      ],
    );
  }
  // A binary file's bytes, as a pull request would write them, scanned before this transaction
  // (scanRunBinaries): one it did not reach is not scanned, and has no sha256 a pull request could hold.
  const binaries = files
    .filter((f) => f.binary && f.status !== "deleted")
    .map((f) => scanned.get(f.path) ?? { path: f.path, sha256: null, lines: [], chars: 0, scanned: false });
  const checks: CheckResult[] = [
    secretsCheck(files, unread, binaries),
    outputsCheck(
      task.declared_outputs ?? [],
      artifacts.rows.filter((a) => a.kind !== "diff" && a.kind !== "handover").map((a) => a.path),
      files,
    ),
  ];
  const tests = completion.checks?.find((c) => c.kind === "tests");
  if (tests) checks.push(testsCheck(tests));
  // Research: the documents are the deliverable; they cite their sources, and the sources answer.
  if (task.work_kind === "research") {
    const documents = artifacts.rows.filter((a) => a.kind === "document");
    const urls = sources ? extractSourceUrls(documents) : [];
    const fetched = sources && urls.length ? await sources.fetch(urls) : null;
    checks.push(sourcesCheck(documents, fetched));
  }
  const evaluation = evaluationCheck(task.criteria ?? [], null);
  if (evaluation) checks.push(evaluation);
  for (const c of checks) await upsertCheck(ctx, review, c);

  const stats = diffStats(files);
  const authorName = (await describeActor(ctx.client, ctx.companyId, author))?.name ?? null;
  const reviewerName =
    reviewer?.name ??
    (reviewer ? ((await describeActor(ctx.client, ctx.companyId, reviewer))?.name ?? null) : null);
  await ctx.emit(
    "review.opened",
    { kind: "review", id: review.id },
    {
      taskId: task.id,
      number: task.number,
      title: task.title,
      round: review.round,
      files: stats.files,
      additions: stats.additions,
      deletions: stats.deletions,
      authorId: author.id,
      authorName,
      reviewer: reviewer ? { kind: reviewer.kind, id: reviewer.id, name: reviewerName } : null,
      checks: checks.map((c) => ({ kind: c.kind, ok: c.ok, title: c.title })),
    },
  );
  return { review, reviewerTeammateId: reviewer?.kind === "teammate" ? reviewer.id : null };
}

/** Where a comment lands: the file and hunk must exist in the current round; a line must be in the hunk. */
async function resolveAnchor(client: Queryable, review: ReviewRow, input: ReviewCommentInput) {
  const file = (
    await client.query<ReviewFileRow>(
      "SELECT * FROM review_files WHERE review_id = $1 AND round = $2 AND path = $3",
      [review.id, review.round, input.file],
    )
  ).rows[0];
  if (!file) throw new HttpError(422, `${input.file} is not in this review`);
  const hunk = file.hunks[input.hunk];
  if (!hunk)
    throw new HttpError(422, `${input.file} has ${file.hunks.length} hunks; there is no hunk ${input.hunk}`);
  if (input.line !== undefined && !hunk.lines.some((l) => l.new === input.line))
    throw new HttpError(422, `hunk ${input.hunk} of ${input.file} has no new line ${input.line}`);
  if (input.oldLine !== undefined && !hunk.lines.some((l) => l.old === input.oldLine))
    throw new HttpError(422, `hunk ${input.hunk} of ${input.file} has no old line ${input.oldLine}`);
  return { file, hunk };
}

export async function addComment(
  db: Db,
  companyId: string,
  actor: ActorRef,
  reviewId: string,
  input: ReviewCommentInput,
): Promise<ReviewCommentRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const review = await loadReview(ctx.client, companyId, reviewId, true);
    if (review.status === "approved") throw new HttpError(409, "this review is approved; veto it to reopen");
    const { hunk } = await resolveAnchor(ctx.client, review, input);
    const inserted = await ctx.client.query<{ id: string }>(
      `INSERT INTO review_comments (company_id, review_id, round, file_path, hunk_index, line_new, line_old, author_kind, author_id, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        companyId,
        review.id,
        review.round,
        input.file,
        input.hunk,
        input.line ?? null,
        input.oldLine ?? null,
        actor.kind,
        actor.id,
        input.body,
      ],
    );
    const author = await describeActor(ctx.client, companyId, actor);
    await ctx.emit(
      "review.commented",
      { kind: "review", id: review.id },
      {
        taskId: review.task_id,
        number: review.task_number,
        title: review.task_title,
        round: review.round,
        commentId: inserted.rows[0]!.id,
        file: input.file,
        hunk: hunk.header,
        line: input.line ?? input.oldLine ?? null,
        authorName: author?.name ?? null,
        preview: input.body.slice(0, 140),
      },
    );
    await ctx.client.query("UPDATE reviews SET updated_at = now() WHERE id = $1", [review.id]);
    return (
      await ctx.client.query<ReviewCommentRow>(`${COMMENT_SELECT} WHERE c.id = $1`, [inserted.rows[0]!.id])
    ).rows[0]!;
  });
  return result;
}

export async function resolveComment(
  db: Db,
  companyId: string,
  actor: ActorRef,
  reviewId: string,
  commentId: string,
): Promise<ReviewCommentRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const review = await loadReview(ctx.client, companyId, reviewId, true);
    const res = await ctx.client.query(
      "UPDATE review_comments SET resolved = true WHERE id = $1 AND review_id = $2 AND NOT resolved",
      [commentId, review.id],
    );
    if (!res.rowCount) {
      const exists = await ctx.client.query(
        "SELECT 1 FROM review_comments WHERE id = $1 AND review_id = $2",
        [commentId, review.id],
      );
      if (!exists.rowCount) throw notFound("comment");
    }
    const who = await describeActor(ctx.client, companyId, actor);
    await ctx.emit(
      "review.commented",
      { kind: "review", id: review.id },
      {
        taskId: review.task_id,
        number: review.task_number,
        round: review.round,
        commentId,
        action: "resolved",
        authorName: who?.name ?? null,
      },
    );
    return (await ctx.client.query<ReviewCommentRow>(`${COMMENT_SELECT} WHERE c.id = $1`, [commentId]))
      .rows[0]!;
  });
  return result;
}

/**
 * Who may decide: never the author; a teammate only as the assigned reviewer;
 * a person with a deciding role (the route guard already checked the matrix).
 */
export function assertCanDecide(review: ReviewRow, actor: ActorRef, role: Role): void {
  if (review.author_kind === actor.kind && review.author_id === actor.id)
    throw new HttpError(403, "the author cannot decide their own review");
  if (actor.kind === "teammate") {
    if (review.reviewer_kind !== "teammate" || review.reviewer_id !== actor.id)
      throw new HttpError(403, "only the assigned reviewer teammate can decide this review");
    return;
  }
  if (!["owner", "admin", "reviewer"].includes(role))
    throw new HttpError(403, `role ${role} may not decide reviews`);
}

export async function scoreReview(
  db: Db,
  companyId: string,
  actor: ActorRef,
  role: Role,
  reviewId: string,
  input: ReviewScoreInput,
): Promise<ReviewRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const review = await loadReview(ctx.client, companyId, reviewId, true);
    assertCanDecide(review, actor, role);
    if (review.status === "approved") throw new HttpError(409, "this review is approved");
    const task = (
      await ctx.client.query<{ criteria: Criterion[] }>("SELECT criteria FROM tasks WHERE id = $1", [
        review.task_id,
      ])
    ).rows[0]!;
    if (!task.criteria?.length) throw new HttpError(422, "this task has no acceptance criteria to score");
    let scores: CriterionScore[];
    try {
      scores = scoreCriteria(task.criteria, input.scores);
    } catch (err) {
      throw new HttpError(422, (err as Error).message);
    }
    // Merge with earlier scores for other criteria.
    const merged = new Map<number, CriterionScore>();
    for (const s of review.scores ?? []) merged.set(s.index, s);
    for (const s of scores) merged.set(s.index, s);
    const all = [...merged.values()].sort((a, b) => a.index - b.index);
    const check = evaluationCheck(task.criteria, all)!;
    await upsertCheck(ctx, review, check);
    const updated = (
      await ctx.client.query<ReviewRow>(
        "UPDATE reviews SET scores = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [review.id, JSON.stringify(all)],
      )
    ).rows[0]!;
    const who = await describeActor(ctx.client, companyId, actor);
    await ctx.emit(
      "review.scored",
      { kind: "review", id: review.id },
      {
        taskId: review.task_id,
        number: review.task_number,
        title: review.task_title,
        round: review.round,
        scorerName: who?.name ?? null,
        score: check.detail.score,
        ok: check.ok,
        title_: check.title,
      },
    );
    return updated;
  });
  return loadReview(db, companyId, result.id);
}

async function recordDecision(
  ctx: MutationContext,
  review: ReviewRow,
  actor: ActorRef,
  decision: ReviewDecisionRow["decision"],
  note: string | null,
) {
  await ctx.client.query(
    "INSERT INTO review_decisions (company_id, review_id, round, decider_kind, decider_id, decision, note) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [ctx.companyId, review.id, review.round, actor.kind, actor.id, decision, note],
  );
}

/** Changes requested: the review waits for the author's next round. The caller restarts the author. */
export async function requestChanges(
  db: Db,
  companyId: string,
  actor: ActorRef,
  role: Role,
  reviewId: string,
  input: { summary?: string },
): Promise<ReviewRow> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const review = await loadReview(ctx.client, companyId, reviewId, true);
    assertCanDecide(review, actor, role);
    if (review.status !== "open")
      throw new HttpError(409, `this review is ${review.status.replace("_", " ")}`);
    const updated = (
      await ctx.client.query<ReviewRow>(
        `UPDATE reviews SET status = 'changes_requested', summary = $2, decided_at = now(), decided_by_kind = $3, decided_by_id = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [review.id, input.summary ?? null, actor.kind, actor.id],
      )
    ).rows[0]!;
    await recordDecision(ctx, review, actor, "request_changes", input.summary ?? null);
    const who = await describeActor(ctx.client, companyId, actor);
    await ctx.emit(
      "review.changes_requested",
      { kind: "review", id: review.id },
      {
        taskId: review.task_id,
        number: review.task_number,
        title: review.task_title,
        round: review.round,
        reviewerName: who?.name ?? null,
        authorId: review.author_id,
        authorName: review.author_name ?? null,
        openComments: review.open_comments ?? 0,
        summary: input.summary ?? null,
      },
    );
    return updated;
  });
  return loadReview(db, companyId, result.id);
}

/**
 * A task as the git host shows it. Never a bare `#N`: GitHub and GitLab link
 * that to the repository's own issue or pull request N, not to the task.
 */
function changeTitle(task: { number: number; title: string }): string {
  return `Task ${task.number}: ${task.title}`;
}

/**
 * Where approving the review opens a pull request: build work on a project whose repository is on a host the
 * board opens changes on, from a run that recorded a base sha. Null where it opens none.
 */
async function pullRequestTarget(
  db: Queryable,
  review: Pick<ReviewRow, "task_id" | "base_sha">,
  hosts: GitHosts | null,
): Promise<{ repo: RepoRef; project: { default_branch: string } } | null> {
  const project = (
    await db.query<{ repo_url: string | null; default_branch: string; work_kind: string }>(
      `SELECT p.repo_url, p.default_branch, t.work_kind FROM projects p JOIN tasks t ON t.project_id = p.id
       WHERE t.id = $1`,
      [review.task_id],
    )
  ).rows[0];
  const repo = parseRepo(project?.repo_url, hosts);
  if (!project || project.work_kind !== "build" || !repo || !review.base_sha) return null;
  return { repo, project };
}

/**
 * The pull request an approval proposes: the exact payload the provider will
 * execute, bound by sha256. Only for build work on a project whose repository
 * is on a host the board opens changes on, and whose run recorded a base sha:
 * research documents are delivered on the board. Executed by the caller after
 * the transaction commits.
 */
async function proposePullRequest(
  ctx: MutationContext,
  review: ReviewRow,
  task: { number: number; title: string },
  approver: ActorRef,
  approverName: string | null,
  summary: string | null,
  target: Awaited<ReturnType<typeof pullRequestTarget>>,
): Promise<string | null> {
  if (!target) return null;
  const { repo, project } = target;
  const checks = await listChecks(ctx.client, review);
  const body = [
    `RosterDock review of task ${task.number}, round ${review.round}, approved by ${approverName ?? "a reviewer"}.`,
    summary ? `\n> ${summary}` : "",
    "",
    "Checks:",
    ...checks.map((c) => `- ${c.ok === null ? "not run" : c.ok ? "ok" : "FAIL"}: ${c.title}`),
    "",
    `Diff sha256 ${review.diff_sha256}, base ${review.base_sha}. Merging needs a person.`,
  ].join("\n");
  const payload = {
    provider: repo.provider,
    path: repo.path,
    baseSha: review.base_sha,
    baseBranch: project.default_branch,
    headBranch: `rosterdock/task-${task.number}`,
    title: changeTitle(task),
    commitMessage: `${changeTitle(task)}\n\nReview ${review.id} round ${review.round}.`,
    body,
    reviewId: review.id,
    round: review.round,
    diffSha256: review.diff_sha256,
    /** Who approved: a binary file goes into the change only where a person did. */
    approvedBy: { kind: approver.kind, id: approver.id },
  };
  const sha = payloadSha256(payload);
  const inserted = await ctx.client.query<{ id: string }>(
    `INSERT INTO pull_requests (company_id, review_id, task_id, provider, repo, base_branch, head_branch, payload, payload_sha256)
     VALUES ($1, $2, $3, $9, $4, $5, $6, $7, $8) RETURNING id`,
    [
      ctx.companyId,
      review.id,
      review.task_id,
      repo.path,
      project.default_branch,
      payload.headBranch,
      JSON.stringify(payload),
      sha,
      repo.provider,
    ],
  );
  const id = inserted.rows[0]!.id;
  await ctx.emit(
    "pr.proposed",
    { kind: "pull_request", id },
    {
      reviewId: review.id,
      taskId: review.task_id,
      number: task.number,
      title: task.title,
      repo: repo.path,
      provider: repo.provider,
      headBranch: payload.headBranch,
      payloadSha256: sha,
    },
  );
  return id;
}

/** Approve: the one path to Done. Returns the proposed pull request to execute, if any. */
export async function approveReview(
  db: Db,
  companyId: string,
  actor: ActorRef,
  role: Role,
  reviewId: string,
  input: { summary?: string },
  hosts: GitHosts | null = null,
): Promise<{ review: ReviewRow; pullRequestId: string | null }> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const review = await loadReview(ctx.client, companyId, reviewId, true);
    assertCanDecide(review, actor, role);
    if (review.status === "approved") throw new HttpError(409, "this review is already approved");
    const task = (
      await ctx.client.query<{ status: string; number: number; title: string }>(
        "SELECT status, number, title FROM tasks WHERE id = $1 FOR UPDATE",
        [review.task_id],
      )
    ).rows[0]!;
    if (task.status === "doing")
      throw new HttpError(409, `#${task.number} is being worked on; wait for the run to finish`);
    // A credential in the diff or failing tests are a person's to wave through, never a teammate's.
    const checks = await listChecks(ctx.client, review);
    const overrode = checks
      .filter((c) => c.ok === false && BLOCKING_CHECKS.includes(c.kind))
      .map((c) => ({ kind: c.kind, title: c.title }));
    if (overrode.length && actor.kind === "teammate")
      throw new HttpError(
        409,
        `#${task.number} has a failed check a teammate cannot approve over (${overrode.map((c) => c.title).join("; ")}): request changes, or leave the decision to a person`,
      );
    // Nor binary files into a pull request: the review shows none of their bytes. Where the approval opens one
    // is read once, here, and the proposal below takes it.
    const target = await pullRequestTarget(ctx.client, review, hosts);
    const withBytes = (
      (checks.find((c) => c.kind === "secrets")?.detail ?? {}) as Partial<BinaryDetail>
    ).binaries?.map((b) => b.path);
    const binaries = target && withBytes?.length ? withBytes : [];
    const who = await describeActor(ctx.client, companyId, actor);
    if (binaries.length && actor.kind === "teammate") {
      // The teammate's approval is refused, and the review goes to people, who are told: no teammate reviews it
      // from here, so it reads "Needs your review" until a person decides.
      const named = `${binaries.slice(0, 5).join(", ")}${binaries.length > 5 ? ` and ${binaries.length - 5} more` : ""}`;
      await ctx.client.query(
        "UPDATE reviews SET reviewer_kind = NULL, reviewer_id = NULL, updated_at = now() WHERE id = $1",
        [review.id],
      );
      await ctx.emit(
        "review.needs_person",
        { kind: "review", id: review.id },
        {
          taskId: review.task_id,
          number: task.number,
          title: task.title,
          round: review.round,
          files: binaries,
          teammateName: who?.name ?? null,
        },
      );
      return {
        id: review.id,
        pullRequestId: null,
        refused: `#${task.number} would put binary files the review cannot show into a pull request (${named}): a person decides it now, and has been asked`,
      };
    }
    const updated = (
      await ctx.client.query<ReviewRow>(
        `UPDATE reviews SET status = 'approved', summary = $2, decided_at = now(), decided_by_kind = $3, decided_by_id = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [review.id, input.summary ?? null, actor.kind, actor.id],
      )
    ).rows[0]!;
    await recordDecision(ctx, review, actor, "approve", input.summary ?? null);
    const doneBy = {
      reviewId: review.id,
      round: review.round,
      by: { kind: actor.kind, id: actor.id, name: who?.name ?? null },
      at: new Date().toISOString(),
    };
    await ctx.client.query(
      "UPDATE tasks SET status = 'done', blocker = NULL, done_by = $2, active_run_id = NULL, updated_at = now() WHERE id = $1",
      [review.task_id, JSON.stringify(doneBy)],
    );
    const payload = {
      taskId: review.task_id,
      number: task.number,
      title: task.title,
      round: review.round,
      approverName: who?.name ?? null,
      authorId: review.author_id,
      authorName: review.author_name ?? null,
      summary: input.summary ?? null,
    };
    await ctx.emit(
      "review.approved",
      { kind: "review", id: review.id },
      {
        ...payload,
        ...(overrode.length ? { overrodeChecks: overrode } : {}),
        // A person's approval of binary files for the pull request, on the record.
        ...(binaries.length ? { binaryFiles: binaries } : {}),
      },
    );
    await ctx.emit(
      "task.moved",
      { kind: "task", id: review.task_id },
      { number: task.number, title: task.title, from: task.status, to: "done", toLabel: STATUS_LABEL.done },
    );
    await ctx.emit("task.done", { kind: "task", id: review.task_id }, { ...payload, doneBy });
    const pullRequestId = await proposePullRequest(
      ctx,
      updated,
      task,
      actor,
      who?.name ?? null,
      input.summary ?? null,
      target,
    );
    return { id: updated.id, pullRequestId, refused: null };
  });
  // Refused after the hand-over to people committed.
  if (result.refused) throw new HttpError(409, result.refused);
  return { review: await loadReview(db, companyId, result.id), pullRequestId: result.pullRequestId };
}

/** A person undoes an approval: the task goes back to In review with the note. */
export async function vetoReview(
  db: Db,
  companyId: string,
  actor: ActorRef,
  reviewId: string,
  input: { note: string },
  /** Closes the change the approval opened; without hosts it is named and left. */
  hosts: GitHosts | null = null,
): Promise<ReviewRow> {
  if (actor.kind !== "user") throw new HttpError(403, "only a person can veto a review");
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const review = await loadReview(ctx.client, companyId, reviewId, true);
    if (review.status !== "approved") throw new HttpError(409, "only an approved review can be vetoed");
    const task = (
      await ctx.client.query<{ status: string; number: number; title: string }>(
        "SELECT status, number, title FROM tasks WHERE id = $1 FOR UPDATE",
        [review.task_id],
      )
    ).rows[0]!;
    const updated = (
      await ctx.client.query<ReviewRow>(
        `UPDATE reviews SET status = 'open', summary = $2, decided_at = now(), decided_by_kind = $3, decided_by_id = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [review.id, input.note, actor.kind, actor.id],
      )
    ).rows[0]!;
    await recordDecision(ctx, review, actor, "veto", input.note);
    await ctx.client.query(
      "UPDATE tasks SET status = 'review', done_by = NULL, updated_at = now() WHERE id = $1",
      [review.task_id],
    );
    const who = await describeActor(ctx.client, companyId, actor);
    await ctx.emit(
      "review.vetoed",
      { kind: "review", id: review.id },
      {
        taskId: review.task_id,
        number: task.number,
        title: task.title,
        round: review.round,
        vetoedByName: who?.name ?? null,
        authorId: review.author_id,
        note: input.note,
        pullRequests: (await listPullRequests(ctx.client, review.id))
          .filter((p) => p.status === "opened")
          .map((p) => ({ number: p.number, url: p.url })),
      },
    );
    await ctx.emit(
      "task.moved",
      { kind: "task", id: review.task_id },
      {
        number: task.number,
        title: task.title,
        from: task.status,
        to: "review",
        toLabel: STATUS_LABEL.review,
      },
    );
    return updated;
  });
  // The pull request the approval opened is closed with the note; the branch stays for a person.
  if (hosts) await closeOpenedPullRequests(db, hosts, companyId, actor, result, input.note);
  return loadReview(db, companyId, result.id);
}

export { type RunQueue };

export interface AssignedReviewer {
  review: ReviewRow;
  previous: { kind: "user" | "teammate"; id: string; name: string | null } | null;
  /** Set when the review is open and the new reviewer is a teammate: they get a review run. */
  reviewerTeammateId: string | null;
}

/**
 * Hand the review to a teammate or a person, or take it, or clear it so
 * people decide. Never the author; a person only with the reviewer role or
 * above; not after approval. The caller stops and starts the review runs.
 */
export async function assignReviewer(
  db: Db,
  companyId: string,
  actor: ActorRef,
  reviewId: string,
  input: AssignReviewerInput,
): Promise<AssignedReviewer> {
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const review = await loadReview(ctx.client, companyId, reviewId, true);
    if (review.status === "approved") throw new HttpError(409, "the review is approved");
    let next: { kind: "user" | "teammate"; id: string; name: string | null } | null = null;
    if (input.reviewer) {
      if (input.reviewer.kind === review.author_kind && input.reviewer.id === review.author_id)
        throw new HttpError(422, "the author cannot review their own work");
      if (input.reviewer.kind === "teammate") {
        const t = (
          await ctx.client.query<{ id: string; name: string }>(
            "SELECT id, name FROM teammates WHERE id = $1 AND company_id = $2",
            [input.reviewer.id, companyId],
          )
        ).rows[0];
        if (!t) throw new HttpError(422, "no such teammate in this company");
        next = { kind: "teammate", id: t.id, name: t.name };
      } else {
        const u = (
          await ctx.client.query<{ id: string; name: string; role: string }>(
            `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.company_id = $1 AND m.user_id = $2`,
            [companyId, input.reviewer.id],
          )
        ).rows[0];
        if (!u) throw new HttpError(422, "no such member in this company");
        if (!["owner", "admin", "reviewer"].includes(u.role))
          throw new HttpError(422, `${u.name} may not review (role ${u.role})`);
        next = { kind: "user", id: u.id, name: u.name };
      }
    }
    const previous =
      review.reviewer_kind && review.reviewer_id
        ? { kind: review.reviewer_kind, id: review.reviewer_id, name: review.reviewer_name ?? null }
        : null;
    if (previous?.kind === next?.kind && previous?.id === next?.id)
      return { review, previous, reviewerTeammateId: null };
    const updated = (
      await ctx.client.query<ReviewRow>(
        "UPDATE reviews SET reviewer_kind = $2, reviewer_id = $3, updated_at = now() WHERE id = $1 RETURNING *",
        [review.id, next?.kind ?? null, next?.id ?? null],
      )
    ).rows[0]!;
    const who = await describeActor(ctx.client, companyId, actor);
    await ctx.emit(
      "review.reassigned",
      { kind: "review", id: review.id },
      {
        taskId: review.task_id,
        number: review.task_number,
        title: review.task_title,
        round: review.round,
        authorId: review.author_id,
        reviewer: next,
        previous,
        byName: who?.name ?? null,
      },
    );
    return {
      review: { ...review, ...updated, reviewer_name: next?.name ?? null },
      previous,
      reviewerTeammateId: review.status === "open" && next?.kind === "teammate" ? next.id : null,
    };
  });
  return result;
}

async function closeOpenedPullRequests(
  db: Db,
  hosts: GitHosts,
  companyId: string,
  actor: ActorRef,
  review: ReviewRow,
  note: string,
): Promise<void> {
  const opened = (await listPullRequests(db, review.id)).filter((p) => p.status === "opened" && p.number);
  for (const pr of opened) {
    let error: string | null = null;
    try {
      await closeChange(hosts, pr.provider, pr.repo, pr.number!, `Vetoed on the RosterDock board: ${note}`);
    } catch (err) {
      error = (err as Error).message.slice(0, 1000);
    }
    await mutate(db, companyId, actor, async (ctx) => {
      if (!error)
        await ctx.client.query(
          "UPDATE pull_requests SET status = 'closed', closed_at = now() WHERE id = $1",
          [pr.id],
        );
      else await ctx.client.query("UPDATE pull_requests SET error = $2 WHERE id = $1", [pr.id, error]);
      const task = (
        await ctx.client.query<{ number: number; title: string }>(
          "SELECT number, title FROM tasks WHERE id = $1",
          [pr.task_id],
        )
      ).rows[0];
      await ctx.emit(
        "pr.closed",
        { kind: "pull_request", id: pr.id },
        {
          reviewId: review.id,
          taskId: pr.task_id,
          number: task?.number,
          title: task?.title,
          repo: pr.repo,
          provider: pr.provider,
          prNumber: pr.number,
          url: pr.url,
          ok: !error,
          error,
        },
      );
    });
  }
}
