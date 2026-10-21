// The board's tools for teammates. Each tool is a plain async function over
// a run-scoped principal (or a manager-scope token outside a run, which has
// no default task and no run to tie messages and decisions to), so they can
// be tested without MCP framing and reused by other engines.

import {
  assertNoRawSecrets,
  RawSecretError,
  type ReviewScoreInput,
  type TaskStatus,
} from "@rosterdock/shared";
import { BrokerRefusal, callTool as brokerCall, listTools as brokerList } from "../broker/broker.js";
import type { Db } from "../db/pool.js";
import type { GitHosts } from "../git/hosts.js";
import type { SpanSink } from "../observability/spans.js";
import type { ObjectStore } from "../storage/s3.js";
import type { McpClientDeps } from "./client.js";
import type { RunQueue } from "../queue.js";
import { HttpError } from "../http-error.js";
import { executePullRequest, restartAuthor } from "../reviews/outcomes.js";
import {
  addComment,
  approveReview,
  commentToJson,
  requestChanges,
  reviewDetail,
  reviewForTask,
  scoreReview,
  type ReviewRow,
} from "../reviews/service.js";
import { deliveredRunId } from "../runs/outputs.js";
import { autoDispatchCreated, routeMessage } from "../runs/routing.js";
import { artifactToJson, listArtifacts, loadRun } from "../runs/service.js";
import { artifactText } from "../storage/artifacts.js";
import {
  createTask,
  decisionToJson,
  findTaskByNumber,
  listDecisions,
  listMessages,
  loadTask,
  logDecision,
  messageToJson,
  moveTask,
  postMessage,
  taskToJson,
  TASK_SELECT,
  type TaskRow,
} from "../tasks/service.js";

export interface ToolActor {
  companyId: string;
  teammateId: string;
  teammateName: string;
  handle: string;
  /** The run the token was minted for; null for a manager token acting outside a run. */
  runId: string | null;
  /** The task the run belongs to; tools default to it. Null outside a run: every call names its task. */
  taskId: string | null;
}

export interface ToolDeps {
  db: Db;
  queue: RunQueue;
  /** The git hosts an approved review opens a change on. */
  hosts: GitHosts;
  /** Where a binary artifact over the inline limit is read from when a change opens. */
  store?: ObjectStore | null;
  /** Where a manager's reads outside a run post their traces. */
  tracer?: SpanSink | null;
  /** The board's MCP client for connections; tests inject a fetch. */
  mcp: McpClientDeps;
}

export class ToolError extends Error {}

/** One page of an output's text from board_read_output. */
export const MAX_OUTPUT_PAGE_CHARS = 50_000;

function guard(payload: unknown): void {
  try {
    assertNoRawSecrets(payload);
  } catch (err) {
    if (err instanceof RawSecretError) throw new ToolError(err.message);
    throw err;
  }
}

/** "#144" or a uuid or absent (the run's own task; outside a run there is none). */
async function resolveTask(deps: ToolDeps, actor: ToolActor, ref: string | undefined): Promise<TaskRow> {
  if (!ref) {
    if (!actor.taskId) throw new ToolError('outside a run, say which task: "#144" or a task id');
    return loadTask(deps.db, actor.companyId, actor.taskId);
  }
  const m = /^#?(\d+)$/.exec(ref.trim());
  if (m) {
    const t = await findTaskByNumber(deps.db, actor.companyId, Number(m[1]));
    if (!t) throw new ToolError(`no task ${ref} in this company`);
    return t;
  }
  try {
    return await loadTask(deps.db, actor.companyId, ref);
  } catch {
    throw new ToolError(`no task ${ref} in this company`);
  }
}

/**
 * The task whose department and client narrow a teammate's live systems: in a run, the run's own, and a
 * task named besides it is refused; outside one, the task named, only if it is assigned to the teammate.
 * Naming another task never lends its policy.
 */
async function policyTask(deps: ToolDeps, actor: ToolActor, ref: string | undefined): Promise<TaskRow> {
  const task = await resolveTask(deps, actor, ref);
  if (actor.taskId) {
    if (task.id === actor.taskId) return task;
    const own = await loadTask(deps.db, actor.companyId, actor.taskId);
    throw new ToolError(
      `live systems are reached for this run's own task, #${own.number}, under its department and client; #${task.number} is not it`,
    );
  }
  if (task.assignee_kind !== "teammate" || task.assignee_id !== actor.teammateId)
    throw new ToolError(
      `outside a run, live systems are reached only for a task assigned to you; #${task.number} is not assigned to you`,
    );
  return task;
}

/** A project by name (case-insensitive) or id. */
async function resolveProject(deps: ToolDeps, companyId: string, ref: string) {
  const res = await deps.db.query<{ id: string; department_id: string | null }>(
    "SELECT id, NULL::uuid AS department_id FROM projects WHERE company_id = $1 AND (id::text = $2 OR lower(name) = lower($2)) LIMIT 1",
    [companyId, ref.trim()],
  );
  const row = res.rows[0];
  if (!row) throw new ToolError(`no project ${ref} in this company`);
  return row;
}

async function teammateByHandle(deps: ToolDeps, companyId: string, handle: string) {
  const h = handle.replace(/^@/, "").toLowerCase();
  const res = await deps.db.query<{ id: string; name: string; handle: string; role: string }>(
    "SELECT id, name, handle, role FROM teammates WHERE company_id = $1 AND handle = $2",
    [companyId, h],
  );
  const row = res.rows[0];
  if (!row) throw new ToolError(`no teammate @${h} in this company`);
  return row;
}

export async function readTask(deps: ToolDeps, actor: ToolActor, input: { task?: string }) {
  const task = await resolveTask(deps, actor, input.task);
  const [messages, decisions, delivered, assignee] = await Promise.all([
    listMessages(deps.db, actor.companyId, task.id, 40),
    listDecisions(deps.db, task.id),
    // What the task delivered, not a reviewer's or a mention's run.
    deliveredRunId(deps.db, task.id),
    task.assignee_kind === "teammate" && task.assignee_id
      ? deps.db.query<{ name: string; handle: string }>("SELECT name, handle FROM teammates WHERE id = $1", [
          task.assignee_id,
        ])
      : Promise.resolve(null),
  ]);
  const outputs = delivered ? (await listArtifacts(deps.db, delivered)).map((a) => artifactToJson(a)) : [];
  return {
    ...taskToJson(task),
    assigneeName: assignee?.rows[0]?.name ?? null,
    assigneeHandle: assignee?.rows[0]?.handle ?? null,
    conversation: messages.map(messageToJson),
    decisions: decisions.map(decisionToJson),
    outputs,
  };
}

/** The text of one file a task delivered, a page at a time: a dependency's document, say. */
export async function readOutputTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; path: string; offset?: number },
) {
  const task = await resolveTask(deps, actor, input.task);
  const runId = await deliveredRunId(deps.db, task.id);
  if (!runId) throw new ToolError(`#${task.number} has delivered nothing yet`);
  const rows = (await listArtifacts(deps.db, runId)).filter((a) => a.kind !== "diff");
  const row =
    rows.find((a) => a.path === input.path) ?? rows.find((a) => a.path.split("/").pop() === input.path);
  if (!row)
    throw new ToolError(
      `#${task.number} delivered no ${input.path}; its outputs: ${rows.map((a) => a.path).join(", ") || "none"}`,
    );
  const base = {
    task: `#${task.number}`,
    title: task.title,
    path: row.path,
    bytes: row.bytes,
    sha256: row.sha256,
  };
  if (row.encoding === "base64") return { ...base, binary: true, text: null, nextOffset: null };
  const text = await artifactText(deps.store ?? null, row);
  if (text === null) throw new ToolError(`the text of ${row.path} is not available on this board`);
  const offset = Math.min(input.offset ?? 0, text.length);
  const end = Math.min(offset + MAX_OUTPUT_PAGE_CHARS, text.length);
  return {
    ...base,
    chars: text.length,
    offset,
    text: text.slice(offset, end),
    nextOffset: end < text.length ? end : null,
  };
}

export async function listMyTasks(deps: ToolDeps, actor: ToolActor, input: { status?: TaskStatus }) {
  const params: unknown[] = [actor.companyId, actor.teammateId];
  let where =
    "t.company_id = $1 AND t.assignee_kind = 'teammate' AND t.assignee_id = $2 AND t.status NOT IN ('done', 'cancelled')";
  if (input.status) {
    params.push(input.status);
    where = where.replace("AND t.status NOT IN ('done', 'cancelled')", `AND t.status = $${params.length}`);
  }
  const res = await deps.db.query<TaskRow>(`${TASK_SELECT} WHERE ${where} ORDER BY t.number`, params);
  return res.rows.map(taskToJson);
}

export async function postMessageTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; body: string },
) {
  guard(input);
  const task = await resolveTask(deps, actor, input.task);
  const row = await postMessage(
    deps.db,
    actor.companyId,
    { kind: "teammate", id: actor.teammateId },
    task.id,
    input.body,
    { runId: actor.runId },
  );
  const routed = await routeMessage(deps.db, deps.queue, row);
  return { ...messageToJson(row), routed };
}

export async function createTaskTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: {
    title: string;
    description?: string;
    assigneeHandle?: string;
    dependsOnTask?: string;
    declaredOutputs?: string[];
    /** Project name or id. Defaults to the run's own project; required outside a run. */
    project?: string;
  },
) {
  guard(input);
  // In a run the new task is a follow-up of the run's task: its parent, its department wherever it is
  // filed, so its run keeps the department's sandbox and pool, and its project unless another is named.
  // Outside a run a manager names the project and the task has no parent.
  const own = actor.taskId ? await loadTask(deps.db, actor.companyId, actor.taskId) : null;
  const projectId = input.project
    ? (await resolveProject(deps, actor.companyId, input.project)).id
    : own?.project_id;
  if (!projectId) throw new ToolError("outside a run, say which project: its name or id");
  const assignee = input.assigneeHandle
    ? await teammateByHandle(deps, actor.companyId, input.assigneeHandle)
    : null;
  const dep = input.dependsOnTask ? await resolveTask(deps, actor, input.dependsOnTask) : null;
  try {
    const task = await createTask(
      deps.db,
      actor.companyId,
      { kind: "teammate", id: actor.teammateId },
      {
        projectId,
        title: input.title,
        description: input.description ?? "",
        departmentId: own?.department_id ?? null,
        assignee: assignee ? { kind: "teammate", id: assignee.id } : null,
        dependsOn: dep ? [dep.id] : [],
        declaredOutputs: input.declaredOutputs ?? [],
        criteria: [],
        workKind: "build",
      },
      own ? { parentTaskId: own.id } : {},
    );
    const startedRunId = await autoDispatchCreated(deps.db, deps.queue, task, actor.teammateId);
    return { ...taskToJson(task), startedRunId };
  } catch (err) {
    if (err instanceof HttpError) throw new ToolError(err.message);
    throw err;
  }
}

export async function setBlockerTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; reason: string; waitingOnHandle?: string },
) {
  guard(input);
  const task = await resolveTask(deps, actor, input.task);
  const waiting = input.waitingOnHandle
    ? await teammateByHandle(deps, actor.companyId, input.waitingOnHandle)
    : null;
  if (waiting) {
    // The ask goes on the task so the teammate gets a turn and the answer has a place to land.
    const ask = await postMessage(
      deps.db,
      actor.companyId,
      { kind: "teammate", id: actor.teammateId },
      task.id,
      `@${waiting.handle} ${input.reason}`,
      { runId: actor.runId },
    );
    await routeMessage(deps.db, deps.queue, ask);
  }
  const moved = await moveTask(
    deps.db,
    actor.companyId,
    { kind: "teammate", id: actor.teammateId },
    task.id,
    {
      status: "blocked",
      blocker: waiting
        ? {
            code: "waiting_on_teammate",
            what: input.reason,
            waitingOn: { kind: "teammate", id: waiting.id, name: waiting.handle },
          }
        : { code: "unknown", what: input.reason },
    },
  );
  return taskToJson(moved);
}

export async function requestReviewTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; note?: string },
) {
  guard(input);
  const task = await resolveTask(deps, actor, input.task);
  if (task.assignee_kind !== "teammate" || task.assignee_id !== actor.teammateId) {
    throw new ToolError(`only the assignee can request review of #${task.number}`);
  }
  if (input.note) {
    const note = await postMessage(
      deps.db,
      actor.companyId,
      { kind: "teammate", id: actor.teammateId },
      task.id,
      input.note,
      { runId: actor.runId },
    );
    await routeMessage(deps.db, deps.queue, note);
  }
  const moved = await moveTask(
    deps.db,
    actor.companyId,
    { kind: "teammate", id: actor.teammateId },
    task.id,
    { status: "review" },
  );
  return taskToJson(moved);
}

// --- Review tools (M3) --------------------------------------------------------

async function resolveReview(deps: ToolDeps, actor: ToolActor, ref: string | undefined): Promise<ReviewRow> {
  const task = await resolveTask(deps, actor, ref);
  const review = await reviewForTask(deps.db, actor.companyId, task.id);
  if (!review)
    throw new ToolError(`#${task.number} has no review yet; it opens when the assignee's run finishes`);
  return review;
}

function asToolError<T>(p: Promise<T>): Promise<T> {
  return p.catch((err) => {
    if (err instanceof HttpError) throw new ToolError(err.message);
    throw err;
  });
}

/** The diff under review: files, hunks with numbered lines, comments, checks and criteria. */
export async function reviewDiffTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; file?: string },
) {
  const review = await resolveReview(deps, actor, input.task);
  const detail = await reviewDetail(deps.db, actor.companyId, review.id);
  const files = input.file ? detail.files.filter((f) => f.path === input.file) : detail.files;
  if (input.file && !files.length) throw new ToolError(`${input.file} is not in this review`);
  return {
    ...detail,
    files: files.map((f) => ({
      ...f,
      hunks: f.hunks.map((h) => ({
        index: h.index,
        header: h.header,
        lines: h.lines.map(
          (l) =>
            `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${String(l.new ?? l.old ?? "").padStart(5)} ${l.text}`,
        ),
      })),
    })),
    howToAnchor:
      "Comment with file, hunk (index) and line (the new-side number shown, or oldLine for a deleted line).",
  };
}

export async function reviewCommentTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; file: string; hunk: number; line?: number; oldLine?: number; body: string },
) {
  guard(input);
  const review = await resolveReview(deps, actor, input.task);
  const row = await asToolError(
    addComment(deps.db, actor.companyId, { kind: "teammate", id: actor.teammateId }, review.id, {
      file: input.file,
      hunk: input.hunk,
      line: input.line,
      oldLine: input.oldLine,
      body: input.body,
    }),
  );
  return commentToJson(row);
}

export async function reviewScoreTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string } & ReviewScoreInput,
) {
  guard(input);
  const review = await resolveReview(deps, actor, input.task);
  await asToolError(
    scoreReview(deps.db, actor.companyId, { kind: "teammate", id: actor.teammateId }, "teammate", review.id, {
      scores: input.scores,
    }),
  );
  const detail = await reviewDetail(deps.db, actor.companyId, review.id);
  return { scores: detail.scores, checks: detail.checks };
}

export async function requestChangesTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; summary?: string },
) {
  guard(input);
  const review = await resolveReview(deps, actor, input.task);
  const updated = await asToolError(
    requestChanges(
      deps.db,
      actor.companyId,
      { kind: "teammate", id: actor.teammateId },
      "teammate",
      review.id,
      {
        summary: input.summary,
      },
    ),
  );
  const restarted = await restartAuthor(
    deps.db,
    deps.queue,
    actor.companyId,
    { kind: "teammate", id: actor.teammateId },
    updated,
  );
  return { reviewId: updated.id, status: updated.status, round: updated.round, restarted };
}

export async function approveTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; summary?: string },
) {
  guard(input);
  const review = await resolveReview(deps, actor, input.task);
  const { review: updated, pullRequestId } = await asToolError(
    approveReview(
      deps.db,
      actor.companyId,
      { kind: "teammate", id: actor.teammateId },
      "teammate",
      review.id,
      {
        summary: input.summary,
      },
      deps.hosts,
    ),
  );
  if (pullRequestId)
    await executePullRequest(deps.db, deps.hosts, actor.companyId, pullRequestId, deps.store ?? null);
  const detail = await reviewDetail(deps.db, actor.companyId, updated.id);
  return {
    reviewId: updated.id,
    status: updated.status,
    taskStatus: detail.taskStatus,
    pullRequests: detail.pullRequests,
  };
}

// --- Governed tools (M5) ------------------------------------------------------

/** The connections in the teammate's toolbox as they apply to its task: modes, tools, verdicts. */
export async function listToolsTool(deps: ToolDeps, actor: ToolActor, input: { task?: string } = {}) {
  const task = await policyTask(deps, actor, input.task);
  return brokerList(
    { db: deps.db, mcp: deps.mcp, tracer: deps.tracer ?? null },
    {
      companyId: actor.companyId,
      teammateId: actor.teammateId,
      teammateName: actor.teammateName,
      runId: actor.runId,
      taskId: task.id,
    },
  );
}

/** One call through the broker: a read runs, a write is proposed, anything else is refused with the reason. */
export async function toolCallTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: {
    task?: string;
    connection: string;
    tool: string;
    arguments?: Record<string, unknown>;
    title?: string;
    why?: string;
  },
) {
  guard(input);
  const { task: taskRef, ...call } = input;
  const task = await policyTask(deps, actor, taskRef);
  try {
    return await brokerCall(
      { db: deps.db, mcp: deps.mcp, tracer: deps.tracer ?? null },
      {
        companyId: actor.companyId,
        teammateId: actor.teammateId,
        teammateName: actor.teammateName,
        runId: actor.runId,
        taskId: task.id,
      },
      { ...call, arguments: call.arguments ?? {} },
    );
  } catch (err) {
    if (err instanceof BrokerRefusal || err instanceof HttpError) throw new ToolError(err.message);
    throw err;
  }
}

export async function logDecisionTool(
  deps: ToolDeps,
  actor: ToolActor,
  input: { task?: string; decision: string; assumptions?: string[]; confidence: number },
) {
  guard(input);
  const task = await resolveTask(deps, actor, input.task);
  const run = actor.runId ? await loadRun(deps.db, actor.runId).catch(() => null) : null;
  const row = await logDecision(deps.db, actor.companyId, actor.teammateId, run?.id ?? null, task.id, {
    decision: input.decision,
    assumptions: input.assumptions ?? [],
    confidence: Math.max(0, Math.min(1, input.confidence)),
  });
  return decisionToJson(row);
}
