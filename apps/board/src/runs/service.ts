// Run lifecycle: dispatch, claim, heartbeat, events, artifacts, completion,
// stop. Every state change is a mutation with events, so Activity and the
// task drawer are projections of the same stream.

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ARTIFACT_MAX_BYTES,
  blockerFor,
  sha256Hex,
  type BlockerInput,
  type BlockerRecord,
  type ActorRef,
  type Criterion,
  type RunArtifactInput,
  type RunCompleteInput,
  type RunEventInput,
  type RunStatus,
  type RunUsage,
  type SandboxPreset,
} from "@rosterdock/shared";
import type pg from "pg";
import { describeActor } from "../actors.js";
import { mintApiToken } from "../auth/tokens.js";
import type { Db, Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate, type MutationContext } from "../mutate.js";
import { artifactObjectKey, artifactText } from "../storage/artifacts.js";
import { lastRunStart, listInbox } from "../teammates/inbox.js";
import type { ObjectStore } from "../storage/s3.js";
import type { FetchedSource, SourceFetcher } from "../reviews/sources.js";
import { queueNameForPool } from "@rosterdock/shared";
import type { RunQueue } from "../queue.js";
import { costFor, totalTokens, usageModel } from "../budgets/cost.js";
import { alertOnBudgets, assertWithinBudgets, priceFor } from "../budgets/service.js";
import { effectiveToolbox, webNarrowingReason, webScope } from "../broker/policy.js";
import { narrowingReason } from "../broker/policy.js";
import { WEB_FETCH_TOOL } from "../web/read.js";
import { webCatalogEntry } from "../mcp/catalog.js";
import {
  listChecks,
  listComments,
  listFiles,
  openReviewRound,
  reviewForTask,
  scanRunBinaries,
  unscannedOnly,
  type OpenedReview,
} from "../reviews/service.js";
import {
  DEFAULT_RUN_TIMEOUT_SECONDS,
  MAX_CONVERSATION_MESSAGES,
  MAX_PACK_DIFF_CHARS,
  renderRunPack,
  runSpecHash,
  type RunSpec,
} from "./pack.js";
import { houseStyleFor } from "../styles/service.js";
import { settleWaitingOn } from "../tasks/waiting.js";
import { dependenciesForBrief } from "./outputs.js";

export const RUN_TOKEN_TTL_SECONDS = 8 * 3600;
/** Inbox lines a pack carries at most. */
export const MAX_INBOX_ITEMS = 20;
export const INLINE_ARTIFACT_MAX_BYTES = 512 * 1024;

/** The largest artifact this board takes: the inline limit, or the object store's cap when there is one. */
export function artifactLimit(store: ObjectStore | null): number {
  return store ? ARTIFACT_MAX_BYTES : INLINE_ARTIFACT_MAX_BYTES;
}

export interface RunRow {
  id: string;
  company_id: string;
  task_id: string;
  teammate_id: string;
  engine: string;
  model: string;
  status: RunStatus;
  attempt: number;
  job_id: string | null;
  worker_id: string | null;
  current_step: string | null;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  heartbeat_at: Date | null;
  stop_requested: boolean;
  summary: string | null;
  error: string | null;
  blocker: BlockerRecord | null;
  usage: Partial<RunUsage>;
  cost_minor_units: number | null;
  duration_ms: number | null;
  run_spec_hash: string | null;
  checkpoint: unknown | null;
  note: string | null;
  created_by_kind: "user" | "teammate";
  created_by_id: string;
  /** task: the assignee working the task. turn: a teammate answering a mention on it. */
  kind: RunKind;
  trigger_message_id: string | null;
  /** HEAD of the clone the diff was taken against. */
  base_sha: string | null;
  /** The commit its clone was at, reported before the engine ran (saveClonedSha). */
  cloned_sha: string | null;
  /** The worker pod's last sample: {cpuMillis, memoryBytes} (M6). */
  resources: { cpuMillis: number; memoryBytes: number } | null;
  /** The pg-boss queue the job is on: runs, or runs.<pool> for a department with a worker pool (M6). */
  queue_name: string;
  created_at: Date;
  updated_at: Date;
}

/** task: the assignee working the task. turn: answering a mention. review: reviewing the task's diff. */
export type RunKind = "task" | "turn" | "review";

export function runToJson(row: RunRow) {
  const u = row.usage ?? {};
  const usage: RunUsage = {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
  };
  return {
    id: row.id,
    companyId: row.company_id,
    taskId: row.task_id,
    teammateId: row.teammate_id,
    engine: row.engine,
    model: row.model,
    status: row.status,
    attempt: row.attempt,
    workerId: row.worker_id,
    currentStep: row.current_step,
    queuedAt: row.queued_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    stopRequested: row.stop_requested,
    summary: row.summary,
    error: row.error,
    blocker: row.blocker,
    usage,
    totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    costMinorUnits: row.cost_minor_units,
    durationMs: row.duration_ms,
    runSpecHash: row.run_spec_hash,
    createdBy: { kind: row.created_by_kind, id: row.created_by_id },
    /** Why this run was started: a person's note, a re-plan, an answer. */
    note: row.note,
    kind: row.kind,
    triggerMessageId: row.trigger_message_id,
    baseSha: row.base_sha,
    resources: row.resources ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/** The live run (queued, running or interrupted) a teammate has on a task, if any. */
export async function liveRunFor(db: Queryable, taskId: string, teammateId: string): Promise<RunRow | null> {
  const res = await db.query<RunRow>(
    "SELECT * FROM runs WHERE task_id = $1 AND teammate_id = $2 AND status IN ('queued', 'running', 'interrupted')",
    [taskId, teammateId],
  );
  return res.rows[0] ?? null;
}

export async function loadRun(db: Queryable, runId: string, forUpdate = false): Promise<RunRow> {
  const res = await db.query<RunRow>(`SELECT * FROM runs WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [
    runId,
  ]);
  const row = res.rows[0];
  if (!row) throw notFound("run");
  return row;
}

interface TaskForRun {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  project_id: string;
  department_id: string | null;
  goal_id: string | null;
  assignee_kind: string | null;
  assignee_id: string | null;
  declared_outputs: string[];
  criteria: Criterion[];
  active_run_id: string | null;
  work_kind: "build" | "research";
}

export interface DispatchInput {
  model?: string;
  note?: string;
  /** Set when a message (an answer to the assignee) started this run. */
  triggerMessageId?: string | null;
}

/** Start a run for a task. The assignee must be a teammate; one live run per task. */
export async function dispatchRun(
  db: Db,
  queue: RunQueue,
  companyId: string,
  actor: ActorRef,
  taskId: string,
  input: DispatchInput,
): Promise<RunRow> {
  const { result: run } = await mutate(db, companyId, actor, async (ctx) => {
    const t = await ctx.client.query<TaskForRun>(
      "SELECT * FROM tasks WHERE id = $1 AND company_id = $2 FOR UPDATE",
      [taskId, companyId],
    );
    const task = t.rows[0];
    if (!task) throw notFound("task");
    if (task.status === "done" || task.status === "cancelled")
      throw new HttpError(409, `#${task.number} is ${task.status}`);
    if (task.assignee_kind !== "teammate" || !task.assignee_id) {
      throw new HttpError(422, `#${task.number} needs a teammate as assignee before it can run`);
    }
    // One task run at a time; turns by other teammates may run alongside it.
    const active = await ctx.client.query<{ id: string; status: string }>(
      "SELECT id, status FROM runs WHERE task_id = $1 AND kind = 'task' AND status IN ('queued', 'running', 'interrupted')",
      [taskId],
    );
    if (active.rows[0]) {
      throw new HttpError(409, `#${task.number} already has a ${active.rows[0].status} run`, {
        blocker: blockerFor("lease_conflict"),
        runId: active.rows[0].id,
      });
    }
    const answering = await liveRunFor(ctx.client, taskId, task.assignee_id);
    if (answering) {
      throw new HttpError(409, `#${task.number}: the assignee is already answering on this task`, {
        blocker: blockerFor("lease_conflict"),
        runId: answering.id,
      });
    }
    const deps = await ctx.client.query<{ number: number; title: string; id: string }>(
      `SELECT t.id, t.number, t.title FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = $1 AND t.status <> 'done' ORDER BY t.number`,
      [taskId],
    );
    if (deps.rows[0]) {
      const first = deps.rows[0];
      throw new HttpError(409, `#${task.number} is waiting on #${first.number} ${first.title}`, {
        blocker: blockerFor("dependencies_unresolved", {
          waitingOn: { kind: "task", id: first.id, name: `#${first.number}` },
        }),
      });
    }
    const mate = await ctx.client.query<{ id: string; name: string; engine: string; model: string }>(
      "SELECT id, name, engine, model FROM teammates WHERE id = $1 AND company_id = $2",
      [task.assignee_id, companyId],
    );
    const teammate = mate.rows[0];
    if (!teammate) throw new HttpError(422, "assignee teammate is not in this company");
    const engine = await ctx.client.query<{ id: string; enabled: boolean }>(
      "SELECT id, enabled FROM engines WHERE id = $1",
      [teammate.engine],
    );
    if (!engine.rows[0]?.enabled) {
      throw new HttpError(409, `${teammate.name} runs on ${teammate.engine}, which is not available`, {
        blocker: blockerFor("adapter_unavailable"),
      });
    }
    await assertWithinBudgets(ctx.client, {
      companyId,
      departmentId: task.department_id,
      projectId: task.project_id,
      teammateId: teammate.id,
      goalId: task.goal_id,
    });
    const inserted = await ctx.client.query<RunRow>(
      `INSERT INTO runs (company_id, task_id, teammate_id, engine, model, note, created_by_kind, created_by_id, trigger_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        companyId,
        taskId,
        teammate.id,
        teammate.engine,
        input.model ?? teammate.model,
        input.note ?? null,
        actor.kind,
        actor.id,
        input.triggerMessageId ?? null,
      ],
    );
    const run = inserted.rows[0]!;
    const from = task.status;
    await ctx.client.query(
      "UPDATE tasks SET active_run_id = $2, status = 'doing', blocker = NULL, updated_at = now() WHERE id = $1",
      [taskId, run.id],
    );
    await ctx.emit(
      "run.queued",
      { kind: "run", id: run.id },
      {
        taskId,
        number: task.number,
        title: task.title,
        teammateId: teammate.id,
        teammateName: teammate.name,
        engine: run.engine,
        model: run.model,
        attempt: 1,
      },
    );
    if (from === "blocked")
      await ctx.emit(
        "task.unblocked",
        { kind: "task", id: taskId },
        { number: task.number, title: task.title },
      );
    if (from !== "doing") {
      await ctx.emit(
        "task.moved",
        { kind: "task", id: taskId },
        { number: task.number, title: task.title, from, to: "doing", toLabel: "In progress" },
      );
    }
    return run;
  });
  await enqueue(db, queue, run);
  return loadRun(db, run.id);
}

/**
 * Give a teammate a turn on a task they were mentioned on. The task's status
 * and assignee do not change: a turn is an answer, not taking the task over.
 */
export async function dispatchTurn(
  db: Db,
  queue: RunQueue,
  companyId: string,
  teammateId: string,
  taskId: string,
  trigger: { id: string; author_kind: "user" | "teammate"; author_id: string },
): Promise<RunRow> {
  const { result: run } = await mutate(
    db,
    companyId,
    { kind: trigger.author_kind, id: trigger.author_id },
    async (ctx) => {
      const t = await ctx.client.query<TaskForRun>(
        "SELECT * FROM tasks WHERE id = $1 AND company_id = $2 FOR UPDATE",
        [taskId, companyId],
      );
      const task = t.rows[0];
      if (!task) throw notFound("task");
      if (task.status === "done" || task.status === "cancelled")
        throw new HttpError(409, `#${task.number} is ${task.status}`);
      const live = await liveRunFor(ctx.client, taskId, teammateId);
      if (live) {
        throw new HttpError(409, `already ${live.status} on #${task.number}`, {
          blocker: blockerFor("lease_conflict"),
          runId: live.id,
        });
      }
      const mate = await ctx.client.query<{ id: string; name: string; engine: string; model: string }>(
        "SELECT id, name, engine, model FROM teammates WHERE id = $1 AND company_id = $2",
        [teammateId, companyId],
      );
      const teammate = mate.rows[0];
      if (!teammate) throw new HttpError(422, "teammate is not in this company");
      const engine = await ctx.client.query<{ enabled: boolean }>(
        "SELECT enabled FROM engines WHERE id = $1",
        [teammate.engine],
      );
      if (!engine.rows[0]?.enabled) {
        throw new HttpError(409, `${teammate.name} runs on ${teammate.engine}, which is not available`, {
          blocker: blockerFor("adapter_unavailable"),
        });
      }
      await assertWithinBudgets(ctx.client, {
        companyId,
        departmentId: task.department_id,
        projectId: task.project_id,
        teammateId: teammate.id,
        goalId: task.goal_id,
      });
      const inserted = await ctx.client.query<RunRow>(
        `INSERT INTO runs (company_id, task_id, teammate_id, engine, model, note, created_by_kind, created_by_id, kind, trigger_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'turn', $9) RETURNING *`,
        [
          companyId,
          taskId,
          teammate.id,
          teammate.engine,
          teammate.model,
          `Mentioned on #${task.number}; answer on the task.`,
          trigger.author_kind,
          trigger.author_id,
          trigger.id,
        ],
      );
      const run = inserted.rows[0]!;
      await ctx.emit(
        "run.queued",
        { kind: "run", id: run.id },
        {
          taskId,
          number: task.number,
          title: task.title,
          teammateId: teammate.id,
          teammateName: teammate.name,
          engine: run.engine,
          model: run.model,
          attempt: 1,
          kind: "turn",
          triggerMessageId: trigger.id,
        },
      );
      return run;
    },
  );
  await enqueue(db, queue, run);
  return loadRun(db, run.id);
}

/**
 * Give the reviewer teammate a run of kind `review` on the task under review.
 * Like a turn, it never moves the task; the decision tools do that.
 */
export async function dispatchReviewRun(
  db: Db,
  queue: RunQueue,
  companyId: string,
  review: { id: string; task_id: string; round: number; reviewer_id: string },
): Promise<RunRow> {
  const { result: run } = await mutate(
    db,
    companyId,
    { kind: "teammate", id: review.reviewer_id },
    async (ctx) => {
      const t = await ctx.client.query<TaskForRun>(
        "SELECT * FROM tasks WHERE id = $1 AND company_id = $2 FOR UPDATE",
        [review.task_id, companyId],
      );
      const task = t.rows[0];
      if (!task) throw notFound("task");
      if (task.status === "done" || task.status === "cancelled")
        throw new HttpError(409, `#${task.number} is ${task.status}`);
      const live = await liveRunFor(ctx.client, review.task_id, review.reviewer_id);
      if (live) {
        throw new HttpError(409, `already ${live.status} on #${task.number}`, {
          blocker: blockerFor("lease_conflict"),
          runId: live.id,
        });
      }
      const mate = await ctx.client.query<{ id: string; name: string; engine: string; model: string }>(
        "SELECT id, name, engine, model FROM teammates WHERE id = $1 AND company_id = $2",
        [review.reviewer_id, companyId],
      );
      const teammate = mate.rows[0];
      if (!teammate) throw new HttpError(422, "reviewer teammate is not in this company");
      const engine = await ctx.client.query<{ enabled: boolean }>(
        "SELECT enabled FROM engines WHERE id = $1",
        [teammate.engine],
      );
      if (!engine.rows[0]?.enabled) {
        throw new HttpError(409, `${teammate.name} runs on ${teammate.engine}, which is not available`, {
          blocker: blockerFor("adapter_unavailable"),
        });
      }
      await assertWithinBudgets(ctx.client, {
        companyId,
        departmentId: task.department_id,
        projectId: task.project_id,
        teammateId: teammate.id,
        goalId: task.goal_id,
      });
      const inserted = await ctx.client.query<RunRow>(
        `INSERT INTO runs (company_id, task_id, teammate_id, engine, model, note, created_by_kind, created_by_id, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'review') RETURNING *`,
        [
          companyId,
          review.task_id,
          teammate.id,
          teammate.engine,
          teammate.model,
          `Review round ${review.round} of #${task.number}.`,
          "teammate",
          review.reviewer_id,
        ],
      );
      const run = inserted.rows[0]!;
      await ctx.emit(
        "run.queued",
        { kind: "run", id: run.id },
        {
          taskId: review.task_id,
          number: task.number,
          title: task.title,
          teammateId: teammate.id,
          teammateName: teammate.name,
          engine: run.engine,
          model: run.model,
          attempt: 1,
          kind: "review",
          reviewId: review.id,
          round: review.round,
        },
      );
      return run;
    },
  );
  await enqueue(db, queue, run);
  return loadRun(db, run.id);
}

/**
 * Put a run on its queue and remember the job id. The queue is the task's department's worker pool
 * when it names one, else the default fleet. Idempotent for the reaper.
 */
export async function enqueue(
  db: Db,
  queue: RunQueue,
  run: Pick<RunRow, "id" | "company_id" | "task_id">,
): Promise<string> {
  const pool = (
    await db.query<{ pool: string | null }>(
      `SELECT d.sandbox->>'pool' AS pool FROM tasks t LEFT JOIN departments d ON d.id = t.department_id WHERE t.id = $1`,
      [run.task_id],
    )
  ).rows[0]?.pool;
  const queueName = queueNameForPool(pool || null);
  const jobId = await queue.enqueueRun({ runId: run.id, companyId: run.company_id }, queueName);
  await db.query("UPDATE runs SET job_id = $2, queue_name = $3, updated_at = now() WHERE id = $1", [
    run.id,
    jobId,
    queueName,
  ]);
  return jobId;
}

/** The diff a review round opened from: its run's `diff` artifact, whole, from the row or the store. */
async function roundDiff(db: Queryable, store: ObjectStore | null, runId: string): Promise<string | null> {
  const row = (
    await db.query<{ content: string | null; object_key: string | null }>(
      "SELECT content, object_key FROM artifacts WHERE run_id = $1 AND kind = 'diff' LIMIT 1",
      [runId],
    )
  ).rows[0];
  return artifactText(store, row ?? null);
}

export async function buildRunSpec(
  db: Queryable,
  run: RunRow,
  store: ObjectStore | null = null,
  /** Whether the board reads the web (ROSTERDOCK_FETCH_SOURCES); off, the brief says the web connection reads nothing. */
  opts: { web?: boolean } = {},
): Promise<RunSpec> {
  const task = (await db.query<TaskForRun>("SELECT * FROM tasks WHERE id = $1", [run.task_id])).rows[0];
  if (!task) throw notFound("task");
  const company = (
    await db.query<{ name: string }>("SELECT name FROM companies WHERE id = $1", [run.company_id])
  ).rows[0];
  const project = (
    await db.query<{
      id: string;
      name: string;
      client: string;
      goal: string;
      repo_url: string | null;
      default_branch: string;
    }>("SELECT id, name, client, goal, repo_url, default_branch FROM projects WHERE id = $1", [
      task.project_id,
    ])
  ).rows[0];
  // A goal that went into a project that existed is not in the project's own goal text: the pack says it.
  const goal = task.goal_id
    ? (
        await db.query<{
          title: string;
          text: string;
          opened_project: boolean;
          outcome: string | null;
          done_definition: string | null;
        }>(
          `SELECT title, text, opened_project, plan->>'outcome' AS outcome, plan->>'doneDefinition' AS done_definition
           FROM goals WHERE id = $1`,
          [task.goal_id],
        )
      ).rows[0]
    : undefined;
  const teammate = (
    await db.query<{
      id: string;
      name: string;
      handle: string;
      role: string;
      persona_md: string;
      playbooks: string[];
      engine: string;
      model: string;
      effort: string | null;
    }>(
      "SELECT id, name, handle, role, persona_md, playbooks, engine, model, effort FROM teammates WHERE id = $1",
      [run.teammate_id],
    )
  ).rows[0];
  if (!project || !teammate || !company) throw notFound("run context");
  const department = task.department_id
    ? ((
        await db.query<{ name: string; write_policy: string; sandbox: SandboxPreset | null }>(
          "SELECT name, write_policy, sandbox FROM departments WHERE id = $1",
          [task.department_id],
        )
      ).rows[0] ?? null)
    : null;
  const preset = department?.sandbox ?? {};
  const sandbox = {
    allowedTools: preset.allowedTools?.length ? preset.allowedTools : null,
    envNames: preset.envNames ?? null,
    timeoutSeconds: preset.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS,
  };
  const messages = await db.query<{ body: string; created_at: Date; author_name: string | null }>(
    `SELECT m.body, m.created_at, CASE m.author_kind WHEN 'user' THEN u.name ELSE t.name END AS author_name
     FROM messages m
     LEFT JOIN users u ON m.author_kind = 'user' AND u.id = m.author_id
     LEFT JOIN teammates t ON m.author_kind = 'teammate' AND t.id = m.author_id
     WHERE m.task_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
    [task.id, MAX_CONVERSATION_MESSAGES],
  );
  // What reached the teammate since their previous run started, oldest first, so they act on it or hand it on.
  const since = await lastRunStart(db, run.teammate_id, run.id);
  const inbox = (
    await listInbox(db, run.company_id, run.teammate_id, { since, onlyUnread: true, limit: MAX_INBOX_ITEMS })
  ).items
    // This task's own conversation and hand-off are in the pack already.
    .filter((i) => i.taskId !== task.id)
    .reverse()
    .map((i) => ({ at: i.at, text: i.text }));
  const turn =
    run.kind === "turn"
      ? ((
          await db.query<{ author: string | null; body: string; assignee: string | null }>(
            `SELECT CASE m.author_kind WHEN 'user' THEN u.name ELSE t.name END AS author, m.body,
                    (SELECT COALESCE(a.name, au.name) FROM tasks tk
                       LEFT JOIN teammates a ON tk.assignee_kind = 'teammate' AND a.id = tk.assignee_id
                       LEFT JOIN users au ON tk.assignee_kind = 'user' AND au.id = tk.assignee_id
                       WHERE tk.id = m.task_id) AS assignee
             FROM messages m
             LEFT JOIN users u ON m.author_kind = 'user' AND u.id = m.author_id
             LEFT JOIN teammates t ON m.author_kind = 'teammate' AND t.id = m.author_id
             WHERE m.id = $1`,
            [run.trigger_message_id],
          )
        ).rows[0] ?? null)
      : null;
  const previous =
    run.attempt > 1
      ? ((
          await db.query<{ error: string | null; summary: string | null }>(
            "SELECT error, summary FROM runs WHERE task_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 1",
            [task.id, run.id],
          )
        ).rows[0] ?? { error: run.error, summary: run.summary })
      : null;
  // The task's review: a reviewer reads the diff; an author sent back reads the comments.
  const reviewRow = run.kind === "turn" ? null : await reviewForTask(db, run.company_id, task.id);
  const approvals =
    run.kind === "task"
      ? (
          await db.query<{
            id: string;
            connection: string;
            tool: string;
            title: string;
            status: string;
            note: string | null;
            error: string | null;
            result: unknown | null;
          }>(
            "SELECT id, connection, tool, title, status, note, error, result FROM approvals WHERE task_id = $1 ORDER BY created_at",
            [task.id],
          )
        ).rows.map((a) => ({
          ...a,
          result:
            a.result === null || a.result === undefined ? null : JSON.stringify(a.result).slice(0, 2000),
        }))
      : [];
  const wantsReview =
    reviewRow &&
    (run.kind === "review" ? reviewRow.status !== "approved" : reviewRow.status === "changes_requested");
  let review: RunSpec["review"] = null;
  if (reviewRow && wantsReview) {
    const [files, comments, checks] = await Promise.all([
      listFiles(db, reviewRow),
      listComments(db, reviewRow.id),
      listChecks(db, reviewRow),
    ]);
    const diffText = run.kind === "review" ? ((await roundDiff(db, store, reviewRow.run_id)) ?? "") : null;
    review = {
      id: reviewRow.id,
      round: reviewRow.round,
      status: reviewRow.status,
      authorName: reviewRow.author_name ?? "the author",
      reviewerName: reviewRow.reviewer_name ?? null,
      summary: reviewRow.summary,
      files: files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      comments: comments.map((c) => ({
        round: c.round,
        file: c.file_path,
        hunk: c.hunk_index,
        hunkHeader: files.find((f) => f.path === c.file_path)?.hunks[c.hunk_index]?.header ?? "",
        line: c.line_new ?? c.line_old ?? null,
        author: c.author_name ?? "someone",
        body: c.body,
        resolved: c.resolved,
      })),
      checks: checks.map((c) => ({ kind: c.kind, ok: c.ok, title: c.title })),
      binaryFiles: (
        (checks.find((c) => c.kind === "secrets")?.detail as { binaries?: { path: string }[] } | undefined)
          ?.binaries ?? []
      ).map((b) => b.path),
      unscannedFiles: unscannedOnly(checks.find((c) => c.kind === "secrets")),
      sources:
        (checks.find((c) => c.kind === "sources")?.detail as { sources?: FetchedSource[] } | undefined)
          ?.sources ?? [],
      diff: diffText === null ? null : diffText.slice(0, MAX_PACK_DIFF_CHARS),
      diffTruncated: diffText !== null && diffText.length > MAX_PACK_DIFF_CHARS,
    };
  }
  // Rework on a repository: the round sent back travels whole, for the worker to apply to its clone.
  let rework: RunSpec["rework"] = null;
  if (run.kind === "task" && reviewRow?.status === "changes_requested" && project.repo_url) {
    const diff = await roundDiff(db, store, reviewRow.run_id);
    if (diff?.trim())
      rework = {
        round: reviewRow.round,
        diffSha256: reviewRow.diff_sha256,
        baseSha: reviewRow.base_sha,
        diff,
      };
  }
  const toolbox = await effectiveToolbox(db, {
    companyId: run.company_id,
    teammateId: run.teammate_id,
    departmentId: task.department_id,
    projectId: task.project_id,
  });
  // The web connection, when the teammate holds it on this task with its fetch on.
  const webGrant = toolbox.find(
    (e) =>
      e.connection.kind === "web" &&
      e.connection.enabled &&
      e.mode !== "off" &&
      e.tools.some((t) => t.name === WEB_FETCH_TOOL && !t.off),
  );
  const webSites = webGrant
    ? await webScope(db, webGrant.connection, {
        departmentId: task.department_id,
        projectId: task.project_id,
      })
    : null;
  return {
    version: 1,
    runId: run.id,
    attempt: run.attempt,
    companyId: run.company_id,
    companyName: company.name,
    task: {
      id: task.id,
      number: task.number,
      title: task.title,
      description: task.description,
      declaredOutputs: task.declared_outputs ?? [],
      criteria: task.criteria ?? [],
      workKind: task.work_kind ?? "build",
    },
    project: {
      id: project.id,
      name: project.name,
      client: project.client,
      goal: project.goal,
      repoUrl: project.repo_url,
      defaultBranch: project.default_branch,
    },
    goal:
      goal && !goal.opened_project
        ? {
            title: goal.title,
            text: goal.text,
            outcome: goal.outcome,
            doneDefinition: goal.done_definition,
          }
        : null,
    teammate: { ...teammate, personaMd: teammate.persona_md, playbooks: teammate.playbooks ?? [] },
    department: department ? { name: department.name, writePolicy: department.write_policy } : null,
    houseStyle: await houseStyleFor(db, run.company_id),
    sandbox,
    limits: { artifactBytes: artifactLimit(store) },
    inbox,
    conversation: messages.rows
      .reverse()
      .map((m) => ({ author: m.author_name ?? "someone", body: m.body, at: m.created_at.toISOString() })),
    dependencies: await dependenciesForBrief(db, store, task.id),
    note: run.note,
    turn: turn ? { askedBy: turn.author ?? "someone", message: turn.body, assignee: turn.assignee } : null,
    previousAttempt: previous
      ? { error: previous.error ?? run.error, summary: previous.summary ?? run.summary }
      : null,
    checkpoint: run.attempt > 1 ? run.checkpoint : null,
    review,
    rework,
    approvals,
    tools: toolbox.map((e) => ({
      connection: e.connection.name,
      mode: e.mode,
      narrowed: narrowingReason(e, department?.name ?? null, project.client),
      enabled: e.connection.enabled,
      reads: e.tools.filter((t) => !t.write && !t.off).map((t) => t.name),
      writes: e.tools.filter((t) => t.write && !t.off).map((t) => t.name),
      off: e.tools.filter((t) => t.off).map((t) => t.name),
    })),
    web: {
      fetch:
        webGrant && webSites
          ? {
              connection: webGrant.connection.name,
              domains: webSites.domains,
              narrowed: webNarrowingReason(webSites, department?.name ?? null, project.client),
            }
          : null,
      offline: opts.web === false,
      // Connections from the catalog's web tools, as the teammate holds them on this task.
      tools: toolbox.flatMap((e) => {
        const entry = webCatalogEntry(e.connection.catalog_id);
        if (!entry || !e.connection.enabled || e.mode === "off") return [];
        return [
          {
            connection: e.connection.name,
            name: entry.name,
            mode: e.mode,
            reads: e.tools.filter((t) => !t.write && !t.off).map((t) => t.name),
            writes: e.tools.filter((t) => t.write && !t.off).map((t) => t.name),
          },
        ];
      }),
    },
  };
}

export interface ClaimResult {
  run: RunRow;
  token: string;
  tokenExpiresAt: string;
  /** What the worker's report of its clone's commit carries; never in the run's spec or pack. */
  cloneKey: string;
  pack: string;
  spec: RunSpec;
}

/** A worker takes a queued or interrupted run. Interrupted runs resume as a new attempt. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "stopped", "blocked"];

export async function claimRun(
  db: Db,
  input: { runId: string; jobId: string; workerId: string },
  opts: { staleAfterMs: number; store?: ObjectStore | null; web?: boolean } = { staleAfterMs: 60_000 },
): Promise<ClaimResult> {
  const first = await loadRun(db, input.runId);
  const { result } = await mutate(
    db,
    first.company_id,
    { kind: "teammate", id: first.teammate_id },
    async (ctx) => {
      let run = await loadRun(ctx.client, input.runId, true);
      // A running run whose worker went quiet is taken over here, without
      // waiting for the reaper: the claim is the authority on staleness.
      if (run.status === "running") {
        const last = run.heartbeat_at?.getTime() ?? run.started_at?.getTime() ?? 0;
        if (Date.now() - last >= opts.staleAfterMs) {
          const res = await ctx.client.query<RunRow>(
            "UPDATE runs SET status = 'interrupted', updated_at = now() WHERE id = $1 RETURNING *",
            [run.id],
          );
          run = res.rows[0]!;
          await ctx.emit(
            "run.interrupted",
            { kind: "run", id: run.id },
            {
              taskId: run.task_id,
              attempt: run.attempt,
              workerId: run.worker_id,
              lastHeartbeatAt: run.heartbeat_at?.toISOString() ?? null,
              takenOverBy: input.workerId,
            },
          );
        }
      }
      if (run.status !== "queued" && run.status !== "interrupted") {
        throw new HttpError(409, `run is ${run.status}`, { status: run.status });
      }
      // The worker must hold the job this run was queued with; a stale or foreign job is refused.
      if (run.job_id && run.job_id !== input.jobId) {
        throw new HttpError(409, "job id does not match this run", { status: run.status, jobMismatch: true });
      }
      const attempt = run.status === "interrupted" ? run.attempt + 1 : run.attempt;
      const spec = await buildRunSpec(ctx.client, { ...run, attempt }, opts.store ?? null, { web: opts.web });
      const hash = runSpecHash(spec);
      // For the worker alone: its report of the commit the clone is at carries it, which the engine cannot.
      const cloneKey = randomBytes(32).toString("hex");
      const updated = await ctx.client.query<RunRow>(
        `UPDATE runs SET status = 'running', attempt = $2, job_id = COALESCE(job_id, $3), worker_id = $4, started_at = COALESCE(started_at, now()),
         heartbeat_at = now(), run_spec_hash = $5, current_step = 'claimed', cloned_sha = NULL, clone_key_sha256 = $6,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
        [run.id, attempt, input.jobId, input.workerId, hash, sha256Hex(cloneKey)],
      );
      // Any earlier token for this run dies with the previous attempt.
      await ctx.client.query("DELETE FROM api_tokens WHERE run_id = $1", [run.id]);
      const minted = await mintApiToken(ctx.client, {
        companyId: run.company_id,
        actor: { kind: "teammate", id: run.teammate_id },
        ttlSeconds: RUN_TOKEN_TTL_SECONDS,
        label: `run ${run.id} attempt ${attempt}`,
        runId: run.id,
        scopes: [`run:${run.id}`],
      });
      await ctx.emit(
        "run.started",
        { kind: "run", id: run.id },
        {
          taskId: run.task_id,
          number: spec.task.number,
          title: spec.task.title,
          teammateName: spec.teammate.name,
          teammateId: run.teammate_id,
          attempt,
          workerId: input.workerId,
          engine: run.engine,
          model: run.model,
          runSpecHash: hash,
          kind: run.kind,
        },
      );
      await appendRunEvent(ctx.client, run.company_id, run.id, {
        type: "run.claimed",
        payload: { workerId: input.workerId, attempt },
      });
      return {
        run: updated.rows[0]!,
        token: minted.token,
        tokenExpiresAt: minted.expiresAt,
        cloneKey,
        pack: renderRunPack(spec),
        spec,
      };
    },
  );
  return result;
}

async function appendRunEvent(
  client: pg.PoolClient,
  companyId: string,
  runId: string,
  ev: RunEventInput,
): Promise<number> {
  const next = await client.query<{ seq: number }>(
    "SELECT coalesce(max(seq), 0) + 1 AS seq FROM run_events WHERE run_id = $1",
    [runId],
  );
  const seq = next.rows[0]!.seq;
  await client.query(
    "INSERT INTO run_events (company_id, run_id, seq, type, payload, created_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))",
    [companyId, runId, seq, ev.type, JSON.stringify(ev.payload ?? {}), ev.at ?? null],
  );
  return seq;
}

/** Worker log lines and progress. Not company events: too chatty for Activity. */
export async function appendRunEvents(
  db: Db,
  runId: string,
  events: RunEventInput[],
): Promise<{ lastSeq: number }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const run = await loadRun(client, runId, true);
    if (run.status !== "running") throw new HttpError(409, `run is ${run.status}`);
    let lastSeq = 0;
    for (const ev of events) lastSeq = await appendRunEvent(client, run.company_id, run.id, ev);
    const step = [...events].reverse().find((e) => e.type === "step")?.payload?.text;
    await client.query(
      "UPDATE runs SET heartbeat_at = now(), current_step = COALESCE($2, current_step), updated_at = now() WHERE id = $1",
      [runId, typeof step === "string" ? step.slice(0, 200) : null],
    );
    await client.query("COMMIT");
    return { lastSeq };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function heartbeat(
  db: Db,
  runId: string,
  input: { step?: string; usage?: Partial<RunUsage>; resources?: { cpuMillis: number; memoryBytes: number } },
): Promise<{ stopRequested: boolean }> {
  const res = await db.query<{ stop_requested: boolean; status: RunStatus }>(
    `UPDATE runs SET heartbeat_at = now(), current_step = COALESCE($2, current_step),
       usage = CASE WHEN $3::jsonb IS NULL THEN usage ELSE usage || $3::jsonb END,
       resources = COALESCE($4::jsonb, resources), updated_at = now()
     WHERE id = $1 AND status = 'running' RETURNING stop_requested, status`,
    [
      runId,
      input.step?.slice(0, 200) ?? null,
      input.usage ? JSON.stringify(input.usage) : null,
      input.resources ? JSON.stringify(input.resources) : null,
    ],
  );
  const row = res.rows[0];
  if (!row) {
    const run = await loadRun(db, runId);
    throw new HttpError(409, `run is ${run.status}`);
  }
  return { stopRequested: row.stop_requested };
}

export async function saveCheckpoint(
  db: Db,
  runId: string,
  checkpoint: Record<string, unknown>,
): Promise<void> {
  const res = await db.query(
    "UPDATE runs SET checkpoint = $2, heartbeat_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'",
    [runId, JSON.stringify(checkpoint)],
  );
  if (!res.rowCount) throw new HttpError(409, "run is not running");
}

/**
 * The commit the run's clone is at, as the worker reports it right after cloning, with the key its claim gave it
 * (the engine holds the run's token, never the key): kept once per attempt, the same again is no change,
 * another is refused.
 */
export async function saveClonedSha(db: Db, runId: string, sha: string, key: string): Promise<void> {
  const run = (
    await db.query<{ status: string; clone_key_sha256: string | null }>(
      "SELECT status, clone_key_sha256 FROM runs WHERE id = $1",
      [runId],
    )
  ).rows[0];
  if (!run || run.status !== "running") throw new HttpError(409, "run is not running");
  if (!run.clone_key_sha256 || !safeEqualHex(sha256Hex(key), run.clone_key_sha256))
    throw new HttpError(403, "only the worker that claimed the run reports its clone");
  const res = await db.query<{ cloned_sha: string | null }>(
    `UPDATE runs SET cloned_sha = COALESCE(cloned_sha, $2), updated_at = now() WHERE id = $1 AND status = 'running'
     RETURNING cloned_sha`,
    [runId, sha],
  );
  if (!res.rowCount) throw new HttpError(409, "run is not running");
  if (res.rows[0]!.cloned_sha !== sha)
    throw new HttpError(409, "the run's clone is recorded at another commit");
}

function safeEqualHex(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface ArtifactRow {
  id: string;
  company_id: string;
  run_id: string;
  task_id: string;
  path: string;
  kind: string;
  sha256: string;
  bytes: number;
  content: string | null;
  object_key: string | null;
  /** utf8: content is the text. base64: the bytes, base64 in the row or raw in the store. */
  encoding: "utf8" | "base64";
  created_at: Date;
}

export function artifactToJson(row: ArtifactRow) {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    path: row.path,
    kind: row.kind,
    sha256: row.sha256,
    bytes: row.bytes,
    inline: row.content !== null,
    encoding: row.encoding ?? "utf8",
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Record an artifact of a running run. Up to the inline limit the text lives
 * in the row; beyond it, in the object store under a key of the company, the
 * run and the content's hash (the row keeps the key), or it is refused when
 * the board has no store.
 */
export async function addArtifact(
  db: Db,
  runId: string,
  input: RunArtifactInput,
  store: ObjectStore | null = null,
): Promise<ArtifactRow> {
  const first = await loadRun(db, runId);
  const { result } = await mutate(
    db,
    first.company_id,
    { kind: "teammate", id: first.teammate_id },
    async (ctx) => {
      const run = await loadRun(ctx.client, runId, true);
      if (run.status !== "running") throw new HttpError(409, `run is ${run.status}`);
      const buf =
        input.encoding === "base64"
          ? Buffer.from(input.content, "base64")
          : Buffer.from(input.content, "utf8");
      const limit = artifactLimit(store);
      if (buf.byteLength > limit) {
        throw new HttpError(
          413,
          `artifact ${input.path} is ${buf.byteLength} bytes; the limit is ${limit}${store ? "" : " (no object store is configured)"}`,
        );
      }
      const sha = sha256Hex(buf);
      const encoding = input.encoding === "base64" ? "base64" : "utf8";
      // A binary artifact stays base64 in its row; the object store gets the bytes as they are.
      let text: string | null = encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");
      let objectKey: string | null = null;
      if (buf.byteLength > INLINE_ARTIFACT_MAX_BYTES && store) {
        objectKey = artifactObjectKey(run.company_id, run.id, sha);
        await store.put(
          objectKey,
          buf,
          encoding === "base64" ? "application/octet-stream" : "text/plain; charset=utf-8",
        );
        text = null;
      }
      const res = await ctx.client.query<ArtifactRow>(
        `INSERT INTO artifacts (company_id, run_id, task_id, path, kind, sha256, bytes, content, object_key, encoding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (run_id, path) DO UPDATE SET kind = EXCLUDED.kind, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
         content = EXCLUDED.content, object_key = EXCLUDED.object_key, encoding = EXCLUDED.encoding, created_at = now()
       RETURNING *`,
        [
          run.company_id,
          run.id,
          run.task_id,
          input.path,
          input.kind,
          sha,
          buf.byteLength,
          text,
          objectKey,
          encoding,
        ],
      );
      const row = res.rows[0]!;
      await ctx.client.query("UPDATE runs SET heartbeat_at = now(), updated_at = now() WHERE id = $1", [
        run.id,
      ]);
      await ctx.emit(
        "artifact.created",
        { kind: "artifact", id: row.id },
        {
          runId: run.id,
          taskId: run.task_id,
          path: row.path,
          kind: row.kind,
          bytes: row.bytes,
          sha256: row.sha256,
        },
      );
      await appendRunEvent(ctx.client, run.company_id, run.id, {
        type: "artifact",
        payload: { path: row.path, kind: row.kind, bytes: row.bytes },
      });
      return row;
    },
  );
  return result;
}

const TERMINAL: Record<RunCompleteInput["status"], RunStatus> = {
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  blocked: "blocked",
};

function blockerFromInput(input: BlockerInput | undefined, fallback: BlockerRecord): BlockerRecord {
  if (!input) return fallback;
  return blockerFor(input.code, {
    ...(input.what ? { what: input.what } : {}),
    ...(input.why ? { why: input.why } : {}),
    ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}),
  });
}

/**
 * A rework run whose round did not carry over (the base branch moved) says so on the task's
 * conversation, as the run's teammate, so the reviewer reads the next round as the change made again.
 */
async function postReworkFallback(
  ctx: MutationContext,
  run: RunRow,
  task: { number: number; title: string },
  rework: NonNullable<RunCompleteInput["rework"]>,
): Promise<void> {
  const branch =
    (
      await ctx.client.query<{ default_branch: string }>(
        "SELECT p.default_branch FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1",
        [run.task_id],
      )
    ).rows[0]?.default_branch ?? "the base branch";
  const body = `Round ${rework.round}'s changes did not carry over to this run${rework.reason ? `: ${rework.reason}` : ""}. It started from a fresh copy of ${branch} and makes the change again instead of editing round ${rework.round}.`;
  const author: ActorRef = { kind: "teammate", id: run.teammate_id };
  const inserted = await ctx.client.query<{ id: string }>(
    "INSERT INTO messages (company_id, task_id, author_kind, author_id, body, mentions, run_id) VALUES ($1, $2, $3, $4, $5, '[]', $6) RETURNING id",
    [run.company_id, run.task_id, author.kind, author.id, body, run.id],
  );
  await ctx.emit(
    "message.posted",
    { kind: "task", id: run.task_id },
    {
      messageId: inserted.rows[0]!.id,
      number: task.number,
      title: task.title,
      authorName: (await describeActor(ctx.client, run.company_id, author))?.name ?? null,
      preview: body.slice(0, 140),
      mentions: [],
    },
  );
}

/**
 * Finish a run and move the task: completed goes to review, failed and
 * blocked go to Blocked with a reason, stopped goes back to To do.
 */
export async function completeRun(
  db: Db,
  runId: string,
  input: RunCompleteInput,
  actorOverride?: ActorRef,
  /** With a queue, a completed task run opens its review and starts the reviewer teammate. */
  queue?: RunQueue,
  /** Where artifacts over the inline limit are read from when the review opens. */
  store: ObjectStore | null = null,
  /** Fetches the sources a research document cites when its review opens. */
  sources: SourceFetcher | null = null,
): Promise<RunRow> {
  const first = await loadRun(db, runId);
  // Refused before any work: a run that has finished, or whose completion this board is recording now. The
  // engine holds the run's token as well, and could send many; the worker's own retry comes back for the answer.
  if (FINISHED_RUN.includes(first.status)) throw new HttpError(409, `run already ${first.status}`);
  if (completing.has(runId)) throw new HttpError(503, "the run's completion is being recorded; try again");
  completing.add(runId);
  try {
    return await recordCompletion(db, first, input, actorOverride, queue, store, sources);
  } finally {
    completing.delete(runId);
  }
}

/** The statuses a run ends in: its completion is recorded once. */
const FINISHED_RUN: readonly string[] = ["completed", "failed", "stopped", "blocked"];

/** The runs whose completion this board is recording now. */
const completing = new Set<string>();

async function recordCompletion(
  db: Db,
  first: RunRow,
  input: RunCompleteInput,
  actorOverride: ActorRef | undefined,
  queue: RunQueue | undefined,
  store: ObjectStore | null,
  sources: SourceFetcher | null,
): Promise<RunRow> {
  const runId = first.id;
  const actor = actorOverride ?? { kind: "teammate" as const, id: first.teammate_id };
  // A completed task run's binary files are scanned for its review before the transaction, which stays short.
  const scanned =
    first.kind === "task" && input.status === "completed"
      ? await scanRunBinaries(db, store, runId)
      : undefined;
  let opened: OpenedReview | null = null;
  const { result } = await mutate(db, first.company_id, actor, async (ctx) => {
    const run = await loadRun(ctx.client, runId, true);
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "stopped" ||
      run.status === "blocked"
    ) {
      throw new HttpError(409, `run already ${run.status}`);
    }
    const status = TERMINAL[input.status];
    const usage = { ...run.usage, ...(input.usage ?? {}) };
    const task = (
      await ctx.client.query<{
        id: string;
        number: number;
        title: string;
        status: string;
        active_run_id: string | null;
        blocker: BlockerRecord | null;
        department_id: string | null;
        declared_outputs: string[];
        criteria: Criterion[];
        work_kind: "build" | "research";
      }>(
        "SELECT id, number, title, status, active_run_id, blocker, department_id, declared_outputs, criteria, work_kind FROM tasks WHERE id = $1 FOR UPDATE",
        [run.task_id],
      )
    ).rows[0]!;
    // A blocker the teammate already set on the board (who they wait on) wins over the generic one.
    const reported =
      status === "failed"
        ? blockerFromInput(
            input.blocker,
            blockerFor("worker_reported", { what: input.error ?? "The run failed." }),
          )
        : status === "blocked"
          ? blockerFromInput(
              input.blocker,
              task.status === "blocked" && task.blocker
                ? task.blocker
                : blockerFor("unknown", { what: input.summary ?? "The teammate declared the task blocked." }),
            )
          : null;
    // "@manager" in a blocked note is no teammate: the task waits on a person, not on nobody.
    const blocker = reported ? await settleWaitingOn(ctx.client, run.company_id, reported) : null;
    const updated = await ctx.client.query<RunRow>(
      `UPDATE runs SET status = $2, finished_at = now(), summary = $3, error = $4, usage = $5, blocker = $6,
         duration_ms = COALESCE($7, EXTRACT(EPOCH FROM (now() - COALESCE(started_at, queued_at))) * 1000)::int,
         base_sha = COALESCE($8, base_sha), current_step = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        run.id,
        status,
        input.summary ?? null,
        input.error ?? null,
        JSON.stringify(usage),
        blocker ? JSON.stringify(blocker) : null,
        input.durationMs ?? null,
        input.baseSha ?? null,
      ],
    );
    let row = updated.rows[0]!;
    const model = usageModel(run.engine, input.model ?? run.model);
    const price = await priceFor(ctx.client, run.company_id, model);
    const cost = costFor(usage, price);
    if (cost !== null) {
      row = (
        await ctx.client.query<RunRow>("UPDATE runs SET cost_minor_units = $2 WHERE id = $1 RETURNING *", [
          run.id,
          cost,
        ])
      ).rows[0]!;
    }
    const scopes = (
      await ctx.client.query<{ project_id: string; department_id: string | null; goal_id: string | null }>(
        "SELECT project_id, department_id, goal_id FROM tasks WHERE id = $1",
        [run.task_id],
      )
    ).rows[0]!;
    await ctx.client.query(
      `INSERT INTO run_usage (company_id, run_id, task_id, teammate_id, project_id, department_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_minor_units)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        run.company_id,
        run.id,
        run.task_id,
        run.teammate_id,
        scopes.project_id,
        scopes.department_id,
        model,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        cost,
      ],
    );
    await alertOnBudgets(
      ctx,
      {
        companyId: run.company_id,
        departmentId: scopes.department_id,
        projectId: scopes.project_id,
        teammateId: run.teammate_id,
        goalId: scopes.goal_id,
      },
      totalTokens(usage),
    );
    await ctx.client.query("DELETE FROM api_tokens WHERE run_id = $1", [run.id]);
    // A run that proposed a write and ended leaves the task at the gate: no review opens until a person decides.
    const waitingOnApproval =
      run.kind === "task" &&
      task.status === "blocked" &&
      task.blocker?.code === "approval_required" &&
      ((
        await ctx.client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM approvals WHERE task_id = $1 AND status = 'pending'",
          [run.task_id],
        )
      ).rows[0]?.n ?? 0) > 0;
    // A turn (an answer) or a review run never moves the task; only the assignee's task run does,
    // and not a cancelled task: its run's end is recorded and nothing reopens it.
    const cancelled = task.status === "cancelled";
    const nextTask =
      run.kind !== "task" || cancelled
        ? task.status
        : waitingOnApproval
          ? "blocked"
          : status === "completed"
            ? "review"
            : status === "stopped"
              ? "todo"
              : "blocked";
    const nextBlocker = waitingOnApproval ? task.blocker : blocker;
    if (run.kind === "task") {
      await ctx.client.query(
        "UPDATE tasks SET status = $2, blocker = $3, active_run_id = NULL, updated_at = now() WHERE id = $1",
        [run.task_id, nextTask, nextTask === "blocked" ? JSON.stringify(nextBlocker) : null],
      );
    }
    const total =
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0);
    const payload = {
      taskId: run.task_id,
      number: task.number,
      title: task.title,
      teammateId: run.teammate_id,
      attempt: run.attempt,
      summary: input.summary ?? null,
      error: input.error ?? null,
      totalTokens: total,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      },
      durationMs: row.duration_ms,
      model,
      kind: run.kind,
    };
    await ctx.emit(
      `run.${status}` as "run.completed" | "run.failed" | "run.stopped" | "run.blocked",
      { kind: "run", id: run.id },
      payload,
    );
    await appendRunEvent(ctx.client, run.company_id, run.id, {
      type: "run.finished",
      payload: { status, totalTokens: total },
    });
    if (run.kind === "task" && input.rework && !input.rework.applied)
      await postReworkFallback(ctx, run, task, input.rework);
    if (task.status !== nextTask) {
      await ctx.emit(
        "task.moved",
        { kind: "task", id: run.task_id },
        {
          number: task.number,
          title: task.title,
          from: task.status,
          to: nextTask,
          toLabel: nextTask === "review" ? "In review" : nextTask === "todo" ? "To do" : "Blocked",
        },
      );
    }
    if (run.kind === "task" && nextTask === "blocked" && blocker && !waitingOnApproval) {
      await ctx.emit(
        "task.blocked",
        { kind: "task", id: run.task_id },
        { number: task.number, title: task.title, blocker },
      );
    }
    // The diff is in: open (or advance) the task's review in the same transaction.
    if (run.kind === "task" && status === "completed" && !waitingOnApproval && !cancelled) {
      opened = await openReviewRound(
        ctx,
        { ...row, base_sha: row.base_sha },
        task,
        input,
        store,
        sources,
        scanned,
      );
    }
    return row;
  });
  // Autonomy by default: the reviewer teammate starts reading without anyone asking.
  const o = opened as OpenedReview | null;
  if (queue && o?.reviewerTeammateId) {
    await dispatchReviewRun(db, queue, first.company_id, {
      id: o.review.id,
      task_id: o.review.task_id,
      round: o.review.round,
      reviewer_id: o.reviewerTeammateId,
    }).catch(() => {
      // Budget spent, engine off or already live: the review waits on the board for a person or a later run.
    });
  }
  return result;
}

/** Ask the worker to stop. A queued run stops immediately; a running one at its next heartbeat. */
export async function stopRun(
  db: Db,
  queue: RunQueue,
  companyId: string,
  actor: ActorRef,
  runId: string,
): Promise<RunRow> {
  const run = await loadRun(db, runId);
  if (run.company_id !== companyId) throw notFound("run");
  if (run.status === "queued") {
    if (run.job_id) await queue.cancel(run.job_id, run.queue_name).catch(() => {});
    return completeRun(db, runId, { status: "stopped", summary: "Stopped before it started." }, actor);
  }
  if (run.status !== "running" && run.status !== "interrupted")
    throw new HttpError(409, `run is ${run.status}`);
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const res = await ctx.client.query<RunRow>(
      "UPDATE runs SET stop_requested = true, updated_at = now() WHERE id = $1 RETURNING *",
      [runId],
    );
    await ctx.emit(
      "run.stop_requested",
      { kind: "run", id: runId },
      { taskId: run.task_id, attempt: run.attempt },
    );
    return res.rows[0]!;
  });
  if (run.status === "interrupted") {
    if (run.job_id) await queue.cancel(run.job_id, run.queue_name).catch(() => {});
    return completeRun(db, runId, { status: "stopped", summary: "Stopped while interrupted." }, actor);
  }
  return result;
}

export async function listRunEvents(db: Queryable, runId: string, afterSeq = 0, limit = 500) {
  const res = await db.query<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    "SELECT seq, type, payload, created_at FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3",
    [runId, afterSeq, Math.max(1, Math.min(limit, 2000))],
  );
  return res.rows.map((r) => ({
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    at: r.created_at.toISOString(),
  }));
}

export async function listArtifacts(db: Queryable, runId: string): Promise<ArtifactRow[]> {
  return (await db.query<ArtifactRow>("SELECT * FROM artifacts WHERE run_id = $1 ORDER BY path", [runId]))
    .rows;
}

export { type MutationContext };
