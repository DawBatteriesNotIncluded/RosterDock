// Approvals: the one gate between a teammate and a live external system. A
// teammate proposes the exact tool call (connection, tool, arguments); the
// arguments are stored with their sha256 and the task waits on a person.
// Approve records the decision, re-verifies the hash and sends exactly those
// bytes through the executor (the broker); the outcome is recorded and the
// proposer is started again with it in their pack. Reject records the note and
// the task says so: blocked on the rejection, not on a decision nobody has left
// to make. Peter re-plans a teammate's task on his next pass; any other waits
// with the rejection for a person, and the card says which. Every step is a
// mutation with an event.

import {
  assertNoRawSecrets,
  blockerFor,
  payloadSha256,
  RawSecretError,
  type ActorRef,
  type ApprovalStatus,
  type BlockerRecord,
} from "@rosterdock/shared";
import { describeActor } from "../actors.js";
import type { Db, Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate, type MutationContext } from "../mutate.js";
import { MAX_REPLANS } from "../peter/replan.js";
import { companyManager, managerForTask } from "../peter/seat.js";
import type { RunQueue } from "../queue.js";
import { dispatchRun } from "../runs/service.js";
import { moveTask, STATUS_LABEL, type TaskRow } from "../tasks/service.js";
import { connectionRoots, writeTarget } from "./target.js";

export interface ApprovalRow {
  id: string;
  company_id: string;
  task_id: string;
  run_id: string | null;
  teammate_id: string | null;
  connection: string;
  tool: string;
  title: string;
  why: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  status: ApprovalStatus;
  decided_by_kind: "user" | "teammate" | null;
  decided_by_id: string | null;
  decided_at: Date | null;
  note: string | null;
  result: unknown | null;
  error: string | null;
  executed_at: Date | null;
  connection_id: string | null;
  superseded_by: string | null;
  created_at: Date;
  updated_at: Date;
  // Joined for listings.
  task_number?: number;
  task_title?: string;
  project_id?: string;
  department_id?: string | null;
  teammate_name?: string | null;
  teammate_handle?: string | null;
}

/** Who takes a task from a rejected write: what its card says after "Nothing was sent". */
export type AfterRejection =
  /** The task's manager re-planned it since the rejection. */
  | { kind: "replanned"; by: string }
  /** The task waits with the rejection, and its manager re-plans it on his next pass. */
  | { kind: "replan"; by: string }
  /** Another proposal on the task still waits for a decision. */
  | { kind: "proposal" }
  /** The task waits with the rejection for its assignee, a person, or for any person (null). */
  | { kind: "person"; name: string | null };

export function approvalToJson(row: ApprovalRow, after: AfterRejection | null = null) {
  return {
    id: row.id,
    companyId: row.company_id,
    taskId: row.task_id,
    taskNumber: row.task_number ?? null,
    taskTitle: row.task_title ?? null,
    projectId: row.project_id ?? null,
    departmentId: row.department_id ?? null,
    runId: row.run_id,
    teammate:
      row.teammate_id !== null
        ? {
            kind: "teammate" as const,
            id: row.teammate_id,
            name: row.teammate_name ?? null,
            handle: row.teammate_handle ?? null,
          }
        : null,
    connectionId: row.connection_id ?? null,
    connection: row.connection,
    tool: row.tool,
    title: row.title,
    why: row.why,
    payload: row.payload,
    payloadSha256: row.payload_sha256,
    status: row.status,
    decidedBy:
      row.decided_by_kind && row.decided_by_id ? { kind: row.decided_by_kind, id: row.decided_by_id } : null,
    decidedAt: row.decided_at?.toISOString() ?? null,
    note: row.note,
    result: row.result ?? null,
    error: row.error,
    executedAt: row.executed_at?.toISOString() ?? null,
    /** What it writes to (a path, an id), when its arguments name one. */
    target: writeTarget(row.payload)?.label ?? null,
    supersededBy: row.superseded_by ?? null,
    /** A rejected write's: who takes the task from there; null once it moved on another way. */
    afterRejection: row.status === "rejected" ? after : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * For each rejected write among `rows`, who takes its task from there. Mirrors Peter's replanRejections
 * (peter/loop.ts): he re-plans a teammate's task outside a stopped or closed goal until its re-plans run out
 * (MAX_REPLANS, then he escalates). Any other task waits with the rejection for its assignee when a person
 * is, or for any person. A rejection whose task has moved on another way (started again, cancelled, done)
 * says nothing more.
 */
export async function afterRejections(
  db: Queryable,
  companyId: string,
  rows: ApprovalRow[],
): Promise<Map<string, AfterRejection>> {
  const out = new Map<string, AfterRejection>();
  const rejected = rows.filter((r) => r.status === "rejected" && r.decided_at);
  if (!rejected.length) return out;
  const res = await db.query<{
    id: string;
    replanned_by: string | null;
    task_status: string;
    blocker_code: string | null;
    assignee_kind: "user" | "teammate" | null;
    assignee_id: string | null;
    department_id: string | null;
    replans: number;
    goal_status: string | null;
    person: string | null;
    pending: number;
  }>(
    `SELECT a.id,
       (SELECT e.payload->>'managerName' FROM events e
         WHERE e.company_id = a.company_id AND e.subject_kind = 'task' AND e.subject_id = a.task_id
           AND e.type = 'task.replanned' AND e.created_at >= a.decided_at
         ORDER BY e.seq LIMIT 1) AS replanned_by,
       t.status AS task_status, t.blocker->>'code' AS blocker_code, t.assignee_kind, t.assignee_id,
       t.department_id, t.replans, g.status AS goal_status, u.name AS person,
       (SELECT count(*)::int FROM approvals p WHERE p.task_id = t.id AND p.status = 'pending') AS pending
     FROM approvals a
     JOIN tasks t ON t.id = a.task_id
     LEFT JOIN goals g ON g.id = t.goal_id
     LEFT JOIN users u ON t.assignee_kind = 'user' AND u.id = t.assignee_id
     WHERE a.company_id = $1 AND a.id = ANY($2::uuid[])`,
    [companyId, rejected.map((r) => r.id)],
  );
  // Without a company manager Peter makes no pass at all.
  const peter = res.rows.length ? await companyManager(db, companyId) : null;
  for (const r of res.rows) {
    if (r.replanned_by) {
      out.set(r.id, { kind: "replanned", by: r.replanned_by });
      continue;
    }
    if (r.task_status !== "blocked") continue;
    if (r.blocker_code === "approval_required" && r.pending > 0) {
      out.set(r.id, { kind: "proposal" });
      continue;
    }
    if (r.blocker_code !== "approval_rejected" && r.blocker_code !== "approval_required") continue;
    const goalOpen = r.goal_status !== "stopped" && r.goal_status !== "done";
    if (peter && r.assignee_kind === "teammate" && goalOpen && r.replans < MAX_REPLANS) {
      const manager = await managerForTask(db, companyId, r);
      if (manager) {
        out.set(r.id, { kind: "replan", by: manager.name });
        continue;
      }
    }
    out.set(r.id, { kind: "person", name: r.person });
  }
  return out;
}

/** Approvals as the API returns them: each rejected one says who takes its task from there. */
export async function approvalsToJson(db: Queryable, companyId: string, rows: ApprovalRow[]) {
  const after = await afterRejections(db, companyId, rows);
  return rows.map((row) => approvalToJson(row, after.get(row.id) ?? null));
}

export const APPROVAL_SELECT = `
  SELECT a.*, t.number AS task_number, t.title AS task_title, t.project_id, t.department_id,
         m.name AS teammate_name, m.handle AS teammate_handle
  FROM approvals a
  JOIN tasks t ON t.id = a.task_id
  LEFT JOIN teammates m ON m.id = a.teammate_id`;

export async function loadApproval(
  db: Queryable,
  companyId: string,
  id: string,
  forUpdate = false,
): Promise<ApprovalRow> {
  const res = await db.query<ApprovalRow>(
    `${APPROVAL_SELECT} WHERE a.id = $1 AND a.company_id = $2${forUpdate ? " FOR UPDATE OF a" : ""}`,
    [id, companyId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("approval");
  return row;
}

export async function listApprovals(
  db: Queryable,
  companyId: string,
  statuses: ApprovalStatus[] | null,
): Promise<ApprovalRow[]> {
  const params: unknown[] = [companyId];
  let where = "a.company_id = $1";
  if (statuses?.length) {
    params.push(statuses);
    where += ` AND a.status = ANY($${params.length}::text[])`;
  }
  const res = await db.query<ApprovalRow>(
    `${APPROVAL_SELECT} WHERE ${where} ORDER BY (a.status = 'pending') DESC, a.created_at DESC LIMIT 500`,
    params,
  );
  return res.rows;
}

export async function approvalsForTask(
  db: Queryable,
  companyId: string,
  taskId: string,
): Promise<ApprovalRow[]> {
  const res = await db.query<ApprovalRow>(
    `${APPROVAL_SELECT} WHERE a.company_id = $1 AND a.task_id = $2 ORDER BY a.created_at`,
    [companyId, taskId],
  );
  return res.rows;
}

export async function pendingApprovalsForTask(db: Queryable, taskId: string): Promise<number> {
  const res = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM approvals WHERE task_id = $1 AND status = 'pending'",
    [taskId],
  );
  return res.rows[0]?.n ?? 0;
}

function guard(value: unknown): void {
  try {
    assertNoRawSecrets(value);
  } catch (err) {
    if (err instanceof RawSecretError) throw new HttpError(422, err.message);
    throw err;
  }
}

export interface ProposalInput {
  taskId: string;
  runId: string | null;
  teammateId: string;
  /** The connection by name (and id, when it exists) and the tool on it. */
  connection: string;
  connectionId?: string | null;
  tool: string;
  /** Manager language: what the write does. */
  title: string;
  why: string;
  /** The exact arguments to send. */
  payload: Record<string, unknown>;
}

/** The blocker a task carries while a proposal waits. Names only. */
export function approvalBlocker(approval: Pick<ApprovalRow, "id" | "title" | "connection">): BlockerRecord {
  return blockerFor("approval_required", {
    what: `Waiting for approval: ${approval.title} (${approval.connection}).`,
    waitingOn: { kind: "approval", id: approval.id, name: approval.title },
  });
}

/** The blocker a task carries once the last proposal it waited on was rejected: nothing waits any more. */
export function rejectedBlocker(
  approval: Pick<ApprovalRow, "title" | "connection" | "tool" | "note">,
): BlockerRecord {
  const note = approval.note?.trim();
  return blockerFor("approval_rejected", {
    what: `${approval.title} (${approval.connection} · ${approval.tool}) was rejected${note ? `: ${note}` : "."}`,
  });
}

/**
 * After a decision the task's blocker says what is true: the oldest proposal still waiting, or the
 * rejection when the last one waiting was rejected. A task whose write went through is restarted by
 * resumeProposer, outside this.
 */
async function settleTask(ctx: MutationContext, decided: ApprovalRow): Promise<void> {
  const task = (
    await ctx.client.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [decided.task_id])
  ).rows[0];
  if (!task || task.status !== "blocked" || task.blocker?.code !== "approval_required") return;
  const pending = (
    await ctx.client.query<ApprovalRow>(
      `${APPROVAL_SELECT} WHERE a.task_id = $1 AND a.status = 'pending' ORDER BY a.created_at`,
      [task.id],
    )
  ).rows;
  // Still waiting on one that waits: nothing to say.
  if (pending.some((a) => a.id === task.blocker?.waitingOn?.id)) return;
  const waiting = pending[0];
  const blocker = waiting
    ? approvalBlocker(waiting)
    : decided.status === "rejected"
      ? rejectedBlocker(decided)
      : null;
  if (!blocker) return;
  await ctx.client.query("UPDATE tasks SET blocker = $2, updated_at = now() WHERE id = $1", [
    task.id,
    JSON.stringify(blocker),
  ]);
}

/**
 * Record a proposed write and park the task on it. Idempotent for one run: the
 * same call (same task, connection, tool and bytes) proposed twice is one row.
 * The run that proposed it should finish; the proposer is started again once
 * a person decides.
 */
export async function proposeApproval(
  db: Db,
  companyId: string,
  input: ProposalInput,
): Promise<{ approval: ApprovalRow; created: boolean }> {
  guard({ title: input.title, why: input.why, payload: input.payload });
  const actor: ActorRef = { kind: "teammate", id: input.teammateId };
  const sha = payloadSha256(input.payload);
  // The same bytes proposed again while the first proposal waits: one row, and nothing to record.
  const dup = (
    await db.query<ApprovalRow & { task_status: string; blocker_code: string | null }>(
      `SELECT a.*, t.status AS task_status, t.blocker->>'code' AS blocker_code FROM approvals a JOIN tasks t ON t.id = a.task_id
       WHERE a.task_id = $1 AND a.connection = $2 AND a.tool = $3 AND a.payload_sha256 = $4 AND a.status = 'pending'`,
      [input.taskId, input.connection, input.tool, sha],
    )
  ).rows[0];
  if (dup && dup.task_status === "blocked" && dup.blocker_code === "approval_required") {
    return { approval: await loadApproval(db, companyId, dup.id), created: false };
  }
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const task = (
      await ctx.client.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 AND company_id = $2 FOR UPDATE", [
        input.taskId,
        companyId,
      ])
    ).rows[0];
    if (!task) throw notFound("task");
    if (task.status === "done" || task.status === "cancelled")
      throw new HttpError(409, `#${task.number} is ${task.status}`);
    const existing = (
      await ctx.client.query<ApprovalRow>(
        `SELECT * FROM approvals WHERE task_id = $1 AND connection = $2 AND tool = $3 AND payload_sha256 = $4 AND status = 'pending'`,
        [task.id, input.connection, input.tool, sha],
      )
    ).rows[0];
    if (existing) {
      // Nothing new happened, but a mutation must say something: the task is (still) waiting.
      await park(ctx, task, existing);
      return { approval: existing, created: false };
    }
    const row = (
      await ctx.client.query<ApprovalRow>(
        `INSERT INTO approvals (company_id, task_id, run_id, teammate_id, connection, connection_id, tool, title, why, payload, payload_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          companyId,
          task.id,
          input.runId,
          input.teammateId,
          input.connection,
          input.connectionId ?? null,
          input.tool,
          input.title,
          input.why,
          JSON.stringify(input.payload),
          sha,
        ],
      )
    ).rows[0]!;
    const who = await describeActor(ctx.client, companyId, actor);
    await supersede(ctx, task, row);
    await ctx.emit(
      "approval.proposed",
      { kind: "approval", id: row.id },
      {
        taskId: task.id,
        number: task.number,
        taskTitle: task.title,
        title: row.title,
        connection: row.connection,
        tool: row.tool,
        teammateId: input.teammateId,
        teammateName: who?.name ?? null,
        payloadSha256: sha,
      },
    );
    await park(ctx, task, row);
    return { approval: row, created: true };
  });
  return { approval: await loadApproval(db, companyId, result.approval.id), created: result.created };
}

/**
 * A newer proposal of the same write (this task, connection, tool and target) replaces the ones
 * still waiting, so the older bytes can no longer be approved after the newer ones.
 */
async function supersede(ctx: MutationContext, task: TaskRow, newer: ApprovalRow): Promise<void> {
  const roots = connectionRoots(
    (
      await ctx.client.query<{ args: unknown }>(
        "SELECT args FROM connections WHERE company_id = $1 AND name = $2",
        [task.company_id, newer.connection],
      )
    ).rows[0]?.args,
  );
  const target = writeTarget(newer.payload, roots);
  if (!target) return;
  const waiting = (
    await ctx.client.query<ApprovalRow>(
      `${APPROVAL_SELECT} WHERE a.task_id = $1 AND a.connection = $2 AND a.tool = $3 AND a.status = 'pending' AND a.id <> $4
       ORDER BY a.created_at FOR UPDATE OF a`,
      [task.id, newer.connection, newer.tool, newer.id],
    )
  ).rows.filter((a) => writeTarget(a.payload, roots)?.key === target.key);
  for (const old of waiting) {
    await ctx.client.query(
      "UPDATE approvals SET status = 'superseded', superseded_by = $2, updated_at = now() WHERE id = $1",
      [old.id, newer.id],
    );
    await ctx.emit(
      "approval.superseded",
      { kind: "approval", id: old.id },
      eventPayload(old, { by: newer.id, byTitle: newer.title, target: target.label }),
    );
  }
  // The task waited on the old one: it waits on the new one now.
  if (waiting.length && task.status === "blocked" && task.blocker?.code === "approval_required") {
    await ctx.client.query("UPDATE tasks SET blocker = $2, updated_at = now() WHERE id = $1", [
      task.id,
      JSON.stringify(approvalBlocker(newer)),
    ]);
  }
}

/** A decision on a proposal that no longer waits. */
function notPending(row: ApprovalRow): HttpError {
  return new HttpError(
    409,
    row.status === "superseded"
      ? "a newer proposal of the same write replaced this one; decide that one"
      : `this approval is already ${row.status}`,
  );
}

/** The task waits at the gate: Blocked, needs your approval. */
async function park(ctx: MutationContext, task: TaskRow, approval: ApprovalRow): Promise<void> {
  if (task.status === "blocked" && task.blocker?.code === "approval_required") return;
  const blocker = approvalBlocker(approval);
  await ctx.client.query(
    "UPDATE tasks SET status = 'blocked', blocker = $2, updated_at = now() WHERE id = $1",
    [task.id, JSON.stringify(blocker)],
  );
  await ctx.emit(
    "task.blocked",
    { kind: "task", id: task.id },
    { number: task.number, title: task.title, blocker },
  );
  await ctx.emit(
    "task.moved",
    { kind: "task", id: task.id },
    {
      number: task.number,
      title: task.title,
      from: task.status,
      to: "blocked",
      toLabel: STATUS_LABEL.blocked,
    },
  );
}

/** Sends the bound bytes to the live system. The broker implements it; tests inject one. */
export type ApprovalExecutor = (
  approval: ApprovalRow,
) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;

export interface Decided {
  approval: ApprovalRow;
  /** The proposer's new run, when the task had nothing else pending and could be restarted. */
  restartedRunId: string | null;
  /** Why the proposer was not restarted, when they were not. */
  restartReason: string | null;
}

/**
 * Approve: record the decision, verify the stored payload still hashes to the
 * sha256 it was proposed with, send exactly those bytes, record the outcome.
 * Then, if nothing else on the task waits for a person, start the proposer
 * again with the outcome in their pack.
 */
export async function approveApproval(
  db: Db,
  queue: RunQueue,
  companyId: string,
  actor: ActorRef,
  approvalId: string,
  note: string | undefined,
  execute: ApprovalExecutor,
): Promise<Decided> {
  guard({ note });
  const { result: approved } = await mutate(db, companyId, actor, async (ctx) => {
    const row = await loadApproval(ctx.client, companyId, approvalId, true);
    if (row.status !== "pending") throw notPending(row);
    const updated = (
      await ctx.client.query<ApprovalRow>(
        `UPDATE approvals SET status = 'approved', decided_by_kind = $2, decided_by_id = $3, decided_at = now(), note = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [row.id, actor.kind, actor.id, note ?? null],
      )
    ).rows[0]!;
    await ctx.emit(
      "approval.approved",
      { kind: "approval", id: row.id },
      eventPayload(row, { note: note ?? null }),
    );
    return { ...row, ...updated };
  });
  // Verify before anything leaves the board: the bytes approved are the bytes sent.
  let outcome: Awaited<ReturnType<ApprovalExecutor>>;
  if (payloadSha256(approved.payload) !== approved.payload_sha256) {
    outcome = {
      ok: false,
      error: "the payload no longer matches the sha256 it was approved with; nothing was sent",
    };
  } else {
    try {
      outcome = await execute(approved);
    } catch (err) {
      outcome = { ok: false, error: (err as Error).message.slice(0, 2000) };
    }
  }
  const { result: executed } = await mutate(db, companyId, actor, async (ctx) => {
    const updated = (
      await ctx.client.query<ApprovalRow>(
        `UPDATE approvals SET status = $2, result = $3, error = $4, executed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [
          approved.id,
          outcome.ok ? "executed" : "failed",
          outcome.ok ? JSON.stringify(outcome.result ?? null) : null,
          outcome.ok ? null : outcome.error,
        ],
      )
    ).rows[0]!;
    await ctx.emit(
      outcome.ok ? "approval.executed" : "approval.failed",
      { kind: "approval", id: approved.id },
      eventPayload(approved, { error: outcome.ok ? null : outcome.error }),
    );
    // Another proposal still waits: the task waits on that one now, not on this decided one.
    await settleTask(ctx, { ...approved, ...updated });
    return { ...approved, ...updated };
  });
  const resumed = await resumeProposer(db, queue, companyId, actor, executed);
  return { approval: await loadApproval(db, companyId, executed.id), ...resumed };
}

/**
 * Reject: the note is recorded and the task stays blocked, on the rejection once nothing else waits for a
 * person. Peter re-plans a teammate's task on his next pass; afterRejections says who takes any task.
 */
export async function rejectApproval(
  db: Db,
  companyId: string,
  actor: ActorRef,
  approvalId: string,
  note: string | undefined,
): Promise<ApprovalRow> {
  guard({ note });
  await mutate(db, companyId, actor, async (ctx) => {
    const row = await loadApproval(ctx.client, companyId, approvalId, true);
    if (row.status !== "pending") throw notPending(row);
    await ctx.client.query(
      `UPDATE approvals SET status = 'rejected', decided_by_kind = $2, decided_by_id = $3, decided_at = now(), note = $4, updated_at = now() WHERE id = $1`,
      [row.id, actor.kind, actor.id, note ?? null],
    );
    await ctx.emit(
      "approval.rejected",
      { kind: "approval", id: row.id },
      eventPayload(row, { note: note ?? null }),
    );
    await settleTask(ctx, { ...row, status: "rejected", note: note ?? null });
  });
  return loadApproval(db, companyId, approvalId);
}

function eventPayload(row: ApprovalRow, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: row.task_id,
    number: row.task_number,
    taskTitle: row.task_title,
    title: row.title,
    connection: row.connection,
    tool: row.tool,
    teammateId: row.teammate_id,
    teammateName: row.teammate_name ?? null,
    payloadSha256: row.payload_sha256,
    ...extra,
  };
}

/**
 * After a decision that executed (or failed to): when no other proposal on the
 * task still waits, the proposer continues in a new run whose pack carries the
 * outcome. When they cannot be started (engine off, budget), the task goes back
 * to To do so a person or Peter's ready-task pass picks it up.
 */
async function resumeProposer(
  db: Db,
  queue: RunQueue,
  companyId: string,
  actor: ActorRef,
  approval: ApprovalRow,
): Promise<{ restartedRunId: string | null; restartReason: string | null }> {
  if (await pendingApprovalsForTask(db, approval.task_id)) {
    return { restartedRunId: null, restartReason: "other proposals on this task still wait for you" };
  }
  const task = (await db.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [approval.task_id])).rows[0];
  if (!task || task.status !== "blocked" || task.blocker?.code !== "approval_required") {
    return { restartedRunId: null, restartReason: "the task was not waiting on this approval" };
  }
  const verb = approval.status === "executed" ? "approved and executed" : "approved but the send failed";
  try {
    const run = await dispatchRun(db, queue, companyId, actor, task.id, {
      note: `Your proposal "${approval.title}" (${approval.connection} · ${approval.tool}) was ${verb}; the outcome is under Approvals on this task. Continue from there.`,
    });
    return { restartedRunId: run.id, restartReason: null };
  } catch (err) {
    const reason = err instanceof HttpError ? err.message : String(err);
    try {
      await moveTask(db, companyId, actor, task.id, { status: "todo" });
    } catch {
      // Already moved by someone else; the board is the truth.
    }
    return { restartedRunId: null, restartReason: reason };
  }
}
